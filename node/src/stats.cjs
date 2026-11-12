// CPU and memory of each running service's process tree (port of runner/stats*.go), sampled every 2 s while a UI is connected.
// The services' process lists come from one cheap call per platform, no native module:
//   macOS   one `ps -axo pid=,ppid=,pgid=,rss=,time=`
//   Linux   /proc/<pid>/stat
//   Windows one long-lived `powershell -EncodedCommand` that prints a Win32_Process table in a loop (see PS_SCRIPT)
// A service's tree = its root process + every descendant (pid/ppid table) + (Unix) every member of its process group, which is
// what the Go version counted. Services show `cpu` (percent of one core since the previous sample) and `mem` (resident bytes).
const fs = require('fs'), os = require('os')
const { spawn, execFile } = require('child_process')
const { WIN } = require('./util.cjs')

const EVERY = 2000 // ms between samples
const FIRST_BLOCK_TIMEOUT = 45000, BLOCK_TIMEOUT = 30000 // Windows helper: silence after which it is given up
const HELPER_IDLE = 60000 // the Windows helper is stopped after this long without anything to sample
const LINUX_TICKS = 100 // USER_HZ

// ---- parsing (pure, unit-tested) ----
// ps TIME column: [dd-][hh:]mm:ss[.cc] -> ms, or NaN
function parseCpuTime(s) {
  let days = 0; const i = s.indexOf('-')
  if (i >= 0) { if (!/^\d+$/.test(s.slice(0, i))) return NaN; days = Number(s.slice(0, i)); s = s.slice(i + 1) }
  const parts = s.split(':'); if (parts.length < 2 || parts.length > 3) return NaN
  let total = Number(parts[parts.length - 1]); if (!/^\d+(\.\d+)?$/.test(parts[parts.length - 1])) return NaN
  let mult = 60
  for (let k = parts.length - 2; k >= 0; k--) { if (!/^\d+$/.test(parts[k])) return NaN; total += Number(parts[k]) * mult; mult *= 60 }
  return (total + days * 86400) * 1000
}
// rows: Map pid -> { ppid, pgid, cpu (ms), mem (bytes), start? }
function parsePs(text) {
  const t = new Map()
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/); if (f.length !== 5) continue
    const [pid, ppid, pgid, rss] = f.slice(0, 4).map(Number), cpu = parseCpuTime(f[4])
    if (![pid, ppid, pgid, rss].every(Number.isFinite) || Number.isNaN(cpu)) continue
    t.set(pid, { ppid, pgid, cpu, mem: rss * 1024 })
  }
  return t
}
// /proc/<pid>/stat: the command may hold spaces and parentheses, so fields are counted after the last ')'
function parseProcStat(s, pageSize = 4096) {
  const i = s.lastIndexOf(')'), head = s.slice(0, s.indexOf(' ')); if (i < 0) return null
  const f = s.slice(i + 1).trim().split(/\s+/); if (f.length < 22) return null // f[0] is field 3 (state)
  const ppid = Number(f[1]), pgid = Number(f[2]), ticks = Number(f[11]) + Number(f[12]), rss = Math.max(0, Number(f[21]))
  if (![ppid, pgid, ticks, rss].every(Number.isFinite)) return null
  return { pid: Number(head), ppid, pgid, cpu: ticks * 1000 / LINUX_TICKS, mem: rss * pageSize }
}
// Windows helper output: "T <ticks>" then rows "pid ppid cpu100ns workingSet creationTicks" then "END". Calls onBlock({ at (ms), table }).
function blockReader(onBlock) {
  let rest = '', table = new Map(), at = NaN
  const line = l => {
    l = l.trim()
    if (l === 'END') { const b = { at: at / 1e4, table }; table = new Map(); at = NaN; onBlock(b); return }
    if (l[0] === 'T') { at = Number(l.slice(2)); return }
    const f = l.split(/\s+/); if (f.length < 4) return
    const [pid, ppid, cpu, mem] = f.map(Number), start = f.length > 4 ? Number(f[4]) : NaN
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(cpu) || !Number.isFinite(mem)) return
    table.set(pid, { ppid, pgid: NaN, cpu: cpu / 1e4, mem, start: start > 0 ? start : NaN })
  }
  return chunk => { rest += chunk; let i; while ((i = rest.indexOf('\n')) >= 0) { line(rest.slice(0, i)); rest = rest.slice(i + 1) } }
}

// CPU time and memory of the tree under root, or null when root is not in the table.
// A child must not be older than its parent (a reused pid would otherwise attach foreign processes).
function treeUsage(table, root) {
  if (!table.has(root)) return null
  const kids = new Map()
  for (const [pid, r] of table) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(pid) }
  const seen = new Set([root]), todo = [root]
  while (todo.length) {
    const p = todo.pop(), ps = table.get(p).start
    for (const c of kids.get(p) || []) {
      const cs = table.get(c).start
      if (seen.has(c) || c === p || (cs < ps)) continue
      seen.add(c); todo.push(c)
    }
  }
  for (const [pid, r] of table) if (r.pgid === root) seen.add(pid) // Unix: processes that left the parent chain but kept the group
  let cpu = 0, mem = 0
  for (const pid of seen) { const r = table.get(pid); cpu += r.cpu; mem += r.mem }
  return { cpu, mem }
}

// ---- platform sources ----
// Only basic cmdlets and the format operator: works in PowerShell Constrained Language Mode (no Add-Type, no .NET calls).
// It paces itself (no stdin), ends when its parent (Grid) is gone, and prints blocks: T <now ticks>, one row per process, END.
const psScript = parent => `$ErrorActionPreference='SilentlyContinue'
while ($true) {
  if (-not (Get-Process -Id ${parent})) { break }
  $r = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize,CreationDate
  'T {0}' -f (Get-Date).Ticks
  $r | ForEach-Object { '{0} {1} {2} {3} {4}' -f $_.ProcessId,$_.ParentProcessId,($_.KernelModeTime + $_.UserModeTime),$_.WorkingSetSize,$_.CreationDate.Ticks }
  'END'
  Start-Sleep -Milliseconds ${EVERY}
}`
const encodePs = s => Buffer.from(s, 'utf16le').toString('base64')

let pageSize = 0
function linuxTable() {
  if (!pageSize) { try { pageSize = Number(require('child_process').execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' })) || 4096 } catch { pageSize = 4096 } }
  const t = new Map()
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue
    let s; try { s = fs.readFileSync(`/proc/${n}/stat`, 'utf8') } catch { continue }
    const r = parseProcStat(s, pageSize); if (r) t.set(Number(n), r)
  }
  return t
}
const psTable = () => new Promise((ok, no) => execFile('ps', ['-axo', 'pid=,ppid=,pgid=,rss=,time='], { maxBuffer: 64 << 20, timeout: 8000, windowsHide: true }, (e, out) => e ? no(e) : ok(parsePs(out))))
const unixTable = () => process.platform === 'linux' && fs.existsSync('/proc/self/stat') ? Promise.resolve().then(linuxTable) : psTable()

// ---- the sampler ----
// ctx: { svcs() -> { name: Service }, clients() -> number of connected UIs, publish(service) }. Services keep { proc: { pid }, stats }.
function createStats(ctx) {
  let timer = null, busy = false, off = false, fails = 0
  let helper = null, helperOK = false, helperWatch = null, helperIdle = 0, empties = 0
  const note = why => { if (!off) { off = true; console.error('[grid] cpu/memory display off: ' + why) } stopHelper() }

  function apply(table, at) {
    const now = at
    for (const s of Object.values(ctx.svcs())) {
      const p = s.proc; if (!p) continue
      const u = treeUsage(table, p.pid); if (!u) continue
      const st = s.stats || (s.stats = { proc: null, at: 0, used: 0, cpu: 0, cpuOK: false, mem: 0 }), before = { ...st }
      if (st.proc === p && now > st.at) { st.cpu = Math.round(Math.max(0, u.cpu - st.used) / (now - st.at) * 1000) / 10; st.cpuOK = true } // a child exited: its CPU time left the sum
      else st.cpuOK = false
      st.proc = p; st.at = now; st.used = u.cpu; st.mem = u.mem
      if (st.cpuOK !== before.cpuOK || Math.abs(st.cpu - before.cpu) >= 1 || Math.abs(st.mem - before.mem) > Math.max(before.mem / 50, 1 << 20) || before.proc !== p) ctx.publish(s)
    }
  }
  const running = () => Object.values(ctx.svcs()).some(s => s.proc)
  const reset = () => { for (const s of Object.values(ctx.svcs())) s.stats = null } // nobody watches: the next listener starts from fresh samples

  async function tick() {
    if (off || busy) return
    if (!ctx.clients() || !running()) { // nothing to show: the Windows helper is not kept alive for it
      if (!ctx.clients()) reset()
      if (helper && Date.now() - helperIdle > HELPER_IDLE) stopHelper()
      return
    }
    helperIdle = Date.now()
    if (WIN) return startHelper() // its blocks arrive on their own
    busy = true
    try { const t0 = Date.now(), t = await unixTable(); apply(t, (t0 + Date.now()) / 2); fails = 0 } catch (e) { if (++fails >= 3) note(e.message) } finally { busy = false }
  }

  function startHelper() {
    if (helper) return
    let child
    try {
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(psScript(process.pid))], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (e) { return note(e.message) }
    helper = child; helperOK = false; empties = 0
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
    const watch = ms => { clearTimeout(helperWatch); helperWatch = setTimeout(() => note(helperOK ? 'powershell stopped answering' : 'powershell gave no output'), ms); helperWatch.unref() }
    watch(FIRST_BLOCK_TIMEOUT)
    child.on('error', e => { if (helper === child) note('powershell: ' + e.message) })
    child.on('exit', () => { if (helper === child) { helper = null; clearTimeout(helperWatch); if (!off && !helperOK) note('powershell exited without output') ; else if (!off) note('powershell exited') } })
    const read = blockReader(b => {
      if (helper !== child) return
      if (!b.table.size) { if (++empties >= 3) note('Win32_Process returned nothing'); return }
      empties = 0; helperOK = true; watch(BLOCK_TIMEOUT)
      if (!ctx.clients()) return reset()
      apply(b.table, Number.isFinite(b.at) ? b.at : Date.now())
    })
    child.stdout.on('data', c => read(c.toString('utf8')))
  }
  function stopHelper() { // intentional stop: not an error, the next start is lazy
    const c = helper; helper = null; clearTimeout(helperWatch)
    if (c) { c.removeAllListeners('exit'); try { c.kill() } catch {} }
  }

  timer = setInterval(() => tick().catch(() => {}), EVERY); timer.unref()
  process.on('exit', () => { if (helper) try { helper.kill() } catch {} })
  return { close() { clearInterval(timer); stopHelper() } }
}

module.exports = { createStats, parseCpuTime, parsePs, parseProcStat, blockReader, treeUsage, psScript }
