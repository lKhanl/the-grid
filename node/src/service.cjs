// One managed service: build step, process, readiness, restarts, stop (port of runner/service.go).
const path = require('path'), net = require('net')
const { spawn, execFile } = require('child_process')
const { WIN, fmtDuration, stripAnsi, decode, lineReader } = require('./util.cjs')
const { plan: makePlan } = require('./plan.cjs')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const ACTIVE = ['starting', 'building', 'running', 'stopping']

// ---- process spawning / killing ----
function shellKind(shell) {
  const base = path.basename(shell || '').replace(/\.[^.]*$/, '').toLowerCase()
  if (!shell || !shell.trim() || base === 'cmd') return 'cmd'
  return base === 'powershell' || base === 'pwsh' ? 'powershell' : 'posix'
}
// Returns [file, args, extra spawn options]. A .cmd/.bat wrapper in the command is run by cmd.exe, which is why cmd is the Windows default.
function shellCommand(shell, command) {
  if (!WIN) {
    const sh = shell || '/bin/sh', base = path.basename(sh).toLowerCase()
    return base === 'powershell' || base === 'pwsh' ? [sh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {}] : [sh, ['-c', command], {}]
  }
  switch (shellKind(shell)) {
    case 'cmd': {
      let exe = shell
      if (!exe || exe.toLowerCase() === 'cmd') exe = process.env.COMSPEC || 'cmd.exe'
      // raw command line: cmd.exe has its own quoting rules, Node's escaping would break them
      return [exe, ['/d', '/s', '/c', '"' + command + '"'], { windowsVerbatimArguments: true, argv0: '"' + exe + '"' }]
    }
    case 'powershell': {
      const exe = /^(powershell|pwsh)$/i.test(shell) ? shell + '.exe' : shell
      return [exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {}]
    }
    default: return [shell, ['-c', command], {}]
  }
}
const signalGroup = (pid, sig) => { try { process.kill(-pid, sig) } catch {} }
function taskkill(pid) { return new Promise(ok => execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => ok())) }
// Windows has no graceful signal for console programs: stopping is a tree kill.
const terminate = pid => WIN ? taskkill(pid) : signalGroup(pid, 'SIGTERM')
const kill = pid => WIN ? taskkill(pid) : signalGroup(pid, 'SIGKILL')

class Service {
  constructor(mgr, cfg) {
    this.mgr = mgr; this.name = cfg.name
    this.logs = []; this.seq = 0
    this.status = 'stopped'; this.pid = 0; this.exitCode = undefined; this.startedAt = 0; this.restarts = 0
    this.launchSeq = 0; this.proc = null; this.stats = null; this.done = null; this.stopRequested = false; this.gen = 0; this.readyD = null
    this.setConfig(cfg)
  }
  setConfig(cfg) { // new settings apply on the next start
    this.cfg = cfg
    const p = makePlan(cfg, false, false); this.prevBuild = p.buildPreview || ''; this.prevRun = p.runPreview || ''
  }
  info() {
    const c = this.cfg, i = {
      name: this.name, group: c.group, description: c.description || undefined, status: this.status, pid: this.pid || undefined, exitCode: this.exitCode,
      restarts: this.restarts, type: c.type, build: this.prevBuild || undefined, command: this.prevRun, cwd: c.cwd, url: c.url || undefined,
      dependsOn: c.dependsOn.length ? c.dependsOn : undefined, runtimes: c.runtime.length ? c.runtime : undefined,
      noChanges: c.changes ? undefined : true, changesIgnore: c.changesIgnore.length ? c.changesIgnore : undefined,
    }
    if (this.startedAt && ACTIVE.includes(this.status)) i.startedAt = this.startedAt
    const st = this.stats // CPU (percent of one core, after two samples) and memory (bytes) of the process tree, only while a process runs
    if (this.proc && st && st.proc === this.proc) { if (st.mem) i.mem = st.mem; if (st.cpuOK) i.cpu = st.cpu }
    if (c.ready) i.ready = c.ready.port > 0 ? 'port ' + c.ready.port : 'log /' + c.ready.log + '/'
    return i
  }

  // ---- log ----
  tail(n) { const max = this.mgr.logLines(); n = n > 0 && n < max ? n : max; return this.logs.slice(-n) }
  sinceStart(n) { const l = this.logs.filter(e => e.seq > this.launchSeq); return n > 0 ? l.slice(-n) : l }
  trim() { const max = this.mgr.logLines(); if (this.logs.length > max + (max >> 2)) this.logs = this.logs.slice(-max) } // the slack avoids copying on every line
  setMax() { const max = this.mgr.logLines(); if (this.logs.length > max) this.logs = this.logs.slice(-max) }
  clear() { this.logs = [] }
  append(stream, line) {
    const entry = { seq: ++this.seq, t: Date.now(), s: stream, line }
    this.logs.push(entry); this.trim()
    this.mgr.send({ type: 'log', service: this.name, entry })
  }
  sys(msg) { this.append('sys', msg) }
  publish() { this.mgr.send({ type: 'service', info: this.info() }) }

  active() { return ACTIVE.includes(this.status) }
  closeReady() { if (this.readyD && !this.readyD.closed) { this.readyD.closed = true; this.readyD.resolve() } }
  newReady() { const d = { closed: false }; d.promise = new Promise(r => d.resolve = r); this.readyD = d }
  isReady() { return this.status === 'running' }

  // Resolves once the service is spawned (not when it is ready). Rejects when it could not be started.
  async start(skipBuild = false) {
    if (this.active()) return
    const gen = ++this.gen
    this.launchSeq = this.seq; this.stopRequested = false; this.restarts = 0; this.exitCode = undefined
    this.newReady(); this.status = 'starting'
    const cfg = this.cfg
    this.publish()
    for (const dep of cfg.dependsOn) {
      const d = this.mgr.get(dep); if (!d) continue
      try {
        await d.start()
        if (!d.isReady()) this.sys(`waiting for ${dep} ...`)
        await d.waitReady(d.cfg.ready ? d.cfg.ready.timeout + 5000 : 30000)
      } catch (e) { const err = new Error(`dependency ${dep}: ${e.message}`); this.failStart(gen, err); throw err }
    }
    await this.spawn(gen, cfg, skipBuild)
  }
  failStart(gen, err) {
    if (this.gen !== gen || (this.status !== 'starting' && this.status !== 'building') || this.proc) return
    this.status = 'crashed'; this.closeReady()
    this.sys(`failed to start: ${err.message}`); this.publish()
  }
  async waitReady(ms) {
    const st = this.status
    if (st === 'running') return
    if (st !== 'starting' && st !== 'building') throw new Error(`not running (${st})`)
    let t
    await Promise.race([this.readyD.promise, new Promise((_, no) => { t = setTimeout(() => no(new Error(`not ready after ${fmtDuration(ms)}`)), ms) })]).finally(() => clearTimeout(t))
    if (this.status !== 'running') throw new Error('stopped before becoming ready')
  }

  async spawn(gen, cfg, skipBuild) {
    if (this.gen !== gen || this.stopRequested) return // stopped while waiting for dependencies
    let env, plan
    try {
      let st; try { st = require('fs').statSync(cfg.cwd) } catch (e) { throw new Error(`cwd: ${e.message}`) }
      if (!st.isDirectory()) throw new Error(`cwd: ${cfg.cwd} is not a directory`)
      env = this.mgr.environ(cfg)
      plan = makePlan(cfg, skipBuild)
    } catch (e) { this.failStart(gen, e); throw e }
    for (const name of cfg.runtime) { const rt = this.mgr.config.runtimes.get(name); if (rt) this.sys(`runtime ${name} (${rt.type}): ${rt.home}`) }
    if (plan.build) return this.launch(gen, cfg, env, plan, true, plan.build, plan.buildCwd)
    if (plan.note) this.sys(plan.note)
    return this.runPhase(gen, cfg, env, plan)
  }
  async runPhase(gen, cfg, env, plan) {
    let r
    try { r = plan.run() } catch (e) { this.failStart(gen, e); throw e }
    return this.launch(gen, cfg, env, plan, false, r.cmd, r.cwd)
  }

  // One process: the build step (build === true) or the app.
  async launch(gen, cfg, env, plan, build, command, cwd) {
    if (this.gen !== gen || this.stopRequested) return
    const [file, args, extra] = shellCommand(cfg.shell, command)
    let child
    try { child = spawn(file, args, { cwd, env, windowsHide: true, detached: !WIN, stdio: ['ignore', 'pipe', 'pipe'], ...extra }) } catch (e) { this.failStart(gen, e); throw e }
    if (!child.pid) { const e = await new Promise(r => child.once('error', r)); this.failStart(gen, e); throw e }
    child.on('error', () => {})
    const pid = child.pid
    this.proc = { pid, child }; this.pid = pid; this.startedAt = Date.now()
    let finish; this.done = new Promise(r => finish = r)
    if (build) this.status = 'building'
    else if (!cfg.ready) { this.status = 'running'; this.closeReady() } else this.status = 'starting'
    this.sys(build ? `building (pid ${pid}): ${command}` : `started pid ${pid}: ${command}`)
    this.publish()

    const readyRe = !build && cfg.readyRegexp
    const reader = stream => lineReader(buf => {
      const text = decode(buf, cfg.encoding)
      this.append(stream, text)
      if (readyRe && readyRe.test(stripAnsi(text))) this.markReady(gen, 'log matched')
    })
    const readers = [['out', child.stdout], ['err', child.stderr]].map(([name, s]) => {
      const r = reader(name), closed = new Promise(ok => s.once('close', ok)); s.on('data', c => r.push(c)); return { r, closed }
    })
    if (!build && cfg.ready) {
      if (cfg.ready.port > 0) this.probePort(gen, cfg.ready.port)
      setTimeout(() => { if (this.stillStarting(gen)) this.sys(`still not ready after ${fmtDuration(cfg.ready.timeout)}; check the 'ready' setting`) }, cfg.ready.timeout).unref()
    }
    const started = Date.now()
    child.once('exit', async (code) => {
      if (!WIN) signalGroup(pid, 'SIGKILL') // anything left in the group after the main process exited
      code = code === null ? -1 : code // killed by a signal
      // give the readers a moment to drain the final output before reporting the exit
      await Promise.race([Promise.all(readers.map(x => x.closed)), sleep(500)])
      readers.forEach(x => x.r.end())
      if (build) this.buildDone(gen, code, Date.now() - started, cfg, env, plan); else this.exited(gen, code)
      finish()
    })
  }

  buildDone(gen, code, took, cfg, env, plan) {
    if (this.gen !== gen) return
    this.proc = null; this.pid = 0
    if (this.stopRequested) { this.status = 'stopped'; this.closeReady(); this.sys('build stopped'); this.publish(); return }
    if (code !== 0) {
      this.status = 'crashed'; this.exitCode = code; this.closeReady()
      this.sys(`build failed (exit ${code}) after ${fmtDuration(took)}; the app was not started`); this.publish(); return
    }
    if (plan.afterBuild) plan.afterBuild()
    this.sys(`build finished in ${fmtDuration(took)}`)
    this.runPhase(gen, cfg, env, plan).catch(() => {})
  }

  markReady(gen, why) {
    if (this.gen !== gen || this.status !== 'starting' || !this.proc) return
    this.status = 'running'; this.closeReady()
    this.sys(`ready in ${fmtDuration(Date.now() - this.startedAt)} (${why})`); this.publish()
  }
  stillStarting(gen) { return this.gen === gen && this.status === 'starting' }
  async probePort(gen, port) {
    while (this.stillStarting(gen)) {
      const ok = await new Promise(r => { const c = net.connect({ port, host: '127.0.0.1' }); c.setTimeout(300, () => { c.destroy(); r(false) }); c.on('connect', () => { c.destroy(); r(true) }); c.on('error', () => { c.destroy(); r(false) }) })
      if (ok) return this.markReady(gen, `port ${port} open`)
      await sleep(500)
    }
  }

  exited(gen, code) {
    if (this.gen !== gen) return
    this.proc = null; this.pid = 0; this.exitCode = code; this.closeReady()
    let restart = false
    if (this.stopRequested) this.status = 'stopped'
    else if (code === 0) { this.status = 'exited'; restart = this.cfg.restart === 'always' }
    else { this.status = 'crashed'; restart = this.cfg.restart === 'always' || this.cfg.restart === 'on-failure' }
    if (restart && this.restarts >= this.cfg.maxRestarts) restart = false
    if (restart) this.restarts++
    this.sys(this.status === 'stopped' ? 'stopped' : `exited with code ${code}`)
    this.publish()
    if (restart) {
      this.sys(`restarting in 2s (attempt ${this.restarts}/${this.cfg.maxRestarts})`)
      setTimeout(() => this.autoRestart(gen), 2000).unref()
    }
  }
  autoRestart(prevGen) {
    if (this.gen !== prevGen || this.stopRequested || this.active()) return
    const gen = ++this.gen
    this.newReady(); this.status = 'starting'; this.publish()
    this.spawn(gen, this.cfg, true).catch(() => {}) // crash restarts reuse the last build
  }

  // Terminates the whole process tree and waits for it to exit.
  async stop() {
    if (!this.proc) { // not spawned yet (waiting for dependencies) or already finished: cancel pending work
      this.stopRequested = true; this.gen++
      if (this.status === 'starting' || this.status === 'building') { this.status = 'stopped'; this.closeReady(); this.sys('start cancelled'); this.publish() }
      return
    }
    this.stopRequested = true; this.status = 'stopping'
    const { pid } = this.proc, done = this.done, timeout = this.cfg.stopTimeout
    this.publish(); this.sys('stopping ...')
    terminate(pid)
    const waited = (ms) => Promise.race([done.then(() => true), sleep(ms).then(() => false)])
    if (await waited(timeout)) return
    this.sys(`did not stop within ${fmtDuration(timeout)}, killing process tree`)
    kill(pid)
    if (!(await waited(5000))) throw new Error(`${this.name}: process did not exit after kill`)
  }
  async restart() { await this.stop(); await this.start() }
}

module.exports = { Service }
