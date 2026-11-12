// Git Changes panel back end (read-only): GET /api/git/changes and GET /api/git/diff.
// Port of internal/server/git.go + internal/gitdiff (master). grid.cjs calls handle() after its Host / X-Grid checks;
// it returns false for paths that are not ours.
const fs = require('fs'), path = require('path'), { spawn } = require('child_process')
const { WIN } = require('./util.cjs')

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_DIFF = 2 << 20 // bytes of diff text sent to the UI
const MAX_COUNT = 2 << 20 // untracked files bigger than this are not line-counted
const COUNT_BUDGET = 32 << 20 // bytes one changes call reads from files it has not counted yet
const MAX_COUNTS = 20000 // remembered line counts
const GIT_TIMEOUT = 20000
const MAX_UNTRACKED = 2000 // untracked files one project lists (more is nearly always a missing .gitignore)
const REPO_RETRY = 30000 // how long a folder that git could not place stays "not a repository"
const MAX_OUT = 1 << 30 // safety net for the output of a git call that is read whole (status of a huge tree)
const DEV_NULL = WIN ? 'NUL' : '/dev/null'

// ---- running git ----
// Resolves with { out: Buffer, truncated }. Rejects with an Error (message like Go: "git <cmd>: <stderr>"); err.out holds
// what git printed before it failed. opts: pre (options before the command), signal, cap (keep at most cap bytes of output
// and stop git: truncated is true when there was more).
function git(dir, args, opts = {}) {
  return new Promise((ok, no) => {
    const { signal, cap = MAX_OUT, pre = [] } = opts
    if (signal && signal.aborted) return no(new Error('request canceled'))
    const full = [...pre, '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args]
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
    let child
    try { child = spawn('git', full, { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { return no(e) }
    const chunks = []; let n = 0, truncated = false, err = '', fin = false, timedOut = false
    const done = (f, v) => { if (fin) return; fin = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); f(v) }
    const onAbort = () => { child.kill(); done(no, new Error('request canceled')) }
    const timer = setTimeout(() => { timedOut = true; child.kill() }, GIT_TIMEOUT)
    if (signal) signal.addEventListener('abort', onAbort)
    child.stdout.on('data', c => {
      if (truncated) return
      if (n + c.length > cap) { chunks.push(c.subarray(0, cap - n)); n = cap; truncated = true; child.kill(); return }
      chunks.push(c); n += c.length
    })
    child.stderr.on('data', c => { if (err.length < 65536) err += c.toString('utf8') })
    child.on('error', e => {
      if (e.code === 'ENOENT') {
        let st; try { st = fs.statSync(dir) } catch {}
        if (!st) return done(no, new Error(`chdir ${dir}: no such file or directory`))
        return done(no, new Error('git was not found on PATH'))
      }
      done(no, e)
    })
    child.on('close', code => {
      const out = Buffer.concat(chunks)
      if (truncated) return done(ok, { out, truncated })
      if (code !== 0) {
        const e = new Error(`git ${args[0]}: ${timedOut ? 'timed out' : err.trim()}`); e.out = out; return done(no, e)
      }
      done(ok, { out, truncated })
    })
  })
}
const text = r => r.out.toString('utf8')

// ---- repository / file helpers (gitdiff) ----
// Where dir sits: the repository's top-level folder and dir's folder in it ("" = the top level, slash separated).
// Git works the prefix out itself: a junction or mount point (a VDI's C:\dev) makes the two paths incomparable as text.
async function locate(dir) {
  const lines = text(await git(dir, ['rev-parse', '--show-toplevel', '--show-prefix'])).replace(/[\r\n]+$/, '').split('\n')
  const root = path.resolve(lines[0].trim()) // cleaned like filepath.Clean (backslashes on Windows)
  const prefix = lines.length > 1 ? lines[1].trim().replace(/\/$/, '') : ''
  return { root, prefix }
}

async function branch(root) {
  try { const b = text(await git(root, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim(); if (b) return b } catch {}
  try { return '(' + text(await git(root, ['rev-parse', '--short', 'HEAD'])).trim() + ')' } catch {}
  return '(no commits)'
}

async function base(root) {
  try { await git(root, ['rev-parse', '--verify', '-q', 'HEAD']); return 'HEAD' } catch { return EMPTY_TREE }
}

// Every changed file (staged, unstaged, untracked) against HEAD. Untracked files come without line count (see countUntracked).
async function status(root) {
  const res = { branch: await branch(root), files: [] }
  const out = text(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']))
  const byPath = new Map()
  for (const rec of out.split('\0')) {
    if (rec.length < 4) continue
    const x = rec[0], y = rec[1], p = rec.slice(3)
    const f = { path: p, status: '', staged: x !== ' ' && x !== '?', additions: 0, deletions: 0 }
    if (x === '?' && y === '?') f.status = 'U'
    else if (x === 'D' || y === 'D') f.status = 'D'
    else if (x === 'A') f.status = 'A'
    else f.status = 'M'
    byPath.set(p, f)
  }
  try {
    const nums = text(await git(root, ['diff', await base(root), '--numstat', '-z', '--no-renames']))
    for (const rec of nums.split('\0')) {
      const parts = rec.split('\t'); if (parts.length < 3) continue
      const f = byPath.get(parts.slice(2).join('\t'))
      if (!f) continue
      if (parts[0] === '-') { f.binary = true; continue }
      f.additions = parseInt(parts[0], 10) || 0; f.deletions = parseInt(parts[1], 10) || 0
    }
  } catch {}
  res.files = [...byPath.values()].sort(byPathAsc)
  return res
}
const byPathAsc = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0

// lines (and binary) of a file read once; the cache key is the path, size and mtime
const counts = new Map()
function countLines(buf) {
  if (buf.subarray(0, 8000).indexOf(0) >= 0) return { lines: 0, binary: true }
  let lines = 0
  for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) lines++
  if (buf.length && buf[buf.length - 1] !== 10) lines++
  return { lines, binary: false }
}
async function readCount(file) { // like Go's countLines: unreadable / too big / folder = 0 lines, not binary
  try {
    const st = await fs.promises.stat(file)
    if (st.isDirectory() || st.size > MAX_COUNT) return { lines: 0, binary: false }
    return countLines(await fs.promises.readFile(file))
  } catch { return { lines: 0, binary: false } }
}
// Fills in additions and binary of the untracked files in files (those about to be shown). A file is read once, and again
// after it changed. One call reads at most COUNT_BUDGET bytes; files beyond keep additions 0 until a later call.
async function countUntracked(root, files) {
  let budget = COUNT_BUDGET
  for (const f of files) {
    if (f.status !== 'U') continue
    const file = path.join(root, ...f.path.split('/'))
    let st; try { st = await fs.promises.stat(file) } catch { continue }
    if (st.isDirectory() || st.size > MAX_COUNT) continue
    let c = counts.get(file)
    if (!c || c.size !== st.size || c.mod !== st.mtimeMs) {
      if (st.size > budget) continue
      budget -= st.size
      c = { size: st.size, mod: st.mtimeMs, ...await readCount(file) }
      if (counts.size >= MAX_COUNTS) counts.clear()
      counts.set(file, c)
    }
    f.additions = c.lines
    if (c.binary) f.binary = true
  }
}

// Unified diff of one file against HEAD. rel must be a path inside the repository, as listed by status.
// It asks git about this one path only.
async function fileDiff(root, rel, signal) {
  if (WIN) rel = rel.replace(/\\/g, '/')
  if (!rel || rel.startsWith('/') || rel.includes('\0') || (WIN && /^[A-Za-z]:/.test(rel))) throw new Error('bad path')
  if (rel.split('/').includes('..')) throw new Error('bad path')
  // literal: a name such as [id] or :x must not be read as a glob / pathspec magic
  const pre = ['--literal-pathspecs']
  const st = text(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', rel], { pre, signal }))
  const rec = st.split('\0')[0]
  if (rec.length < 4) throw new Error('file has no changes')
  let out, truncated
  if (rec[0] === '?' && rec[1] === '?') { // untracked
    if ((await readCount(path.join(root, ...rel.split('/')))).binary) return { diff: '', binary: true }
    try { ({ out, truncated } = await git(root, ['diff', '--no-index', '--no-color', '--no-ext-diff', '-U6', '--', DEV_NULL, rel], { signal, cap: MAX_DIFF + 1 })) } catch (e) { // --no-index exits with 1 when the files differ
      if (!e.out || !e.out.length) throw e
      out = e.out; truncated = false
    }
  } else {
    const a = ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-renames', '-U6', '--', rel], opt = { pre, signal, cap: MAX_DIFF + 1 }
    try { ({ out, truncated } = await git(root, a, opt)) } catch { // a repository without commits: compare with the empty tree
      a[1] = EMPTY_TREE; ({ out, truncated } = await git(root, a, opt))
    }
    const head = out.subarray(0, 400)
    if (out.subarray(0, 10).toString() === 'diff --git' && head.includes('\nBinary files ')) return { diff: '', binary: true }
  }
  const d = { diff: '' }
  if (truncated || out.length > MAX_DIFF) { out = out.subarray(0, MAX_DIFF); d.truncated = true }
  d.diff = out.toString('utf8')
  return d
}

// ---- changes_ignore patterns (gitdiff/ignore.go) ----
// *.iml any depth | tmp/ folders only | a/b.yml relative to the project folder | **/gen/*.java ** spans folders
function newIgnore(patterns) {
  const pats = []
  for (const raw of patterns) {
    let p = String(raw).replace(/\\/g, '/').trim()
    if (!p || p.startsWith('#')) continue
    const ip = { raw, dirOnly: false }
    if (p.endsWith('/')) { ip.dirOnly = true; p = p.replace(/\/+$/, '') }
    ip.any = !p.includes('/')
    if (p.startsWith('/')) p = p.slice(1)
    if (!p) continue
    ip.segs = p.split('/')
    pats.push(ip)
  }
  return pats
}
// path.Match for one name: * ? [class] [^class]; the name itself always matches (a Next.js [id] folder)
function matchName(pat, name) {
  if (pat === name) return true
  let re = '^'
  const cp = [...pat]
  for (let i = 0; i < cp.length; i++) {
    const c = cp[i]
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[') {
      let j = i + 1, neg = false, cls = ''
      if (cp[j] === '^') { neg = true; j++ }
      for (; j < cp.length && (cp[j] !== ']' || j === i + 1 + (neg ? 1 : 0)); j++) cls += cp[j] === '\\' || cp[j] === '[' || cp[j] === '^' ? '\\' + cp[j] : cp[j]
      if (j >= cp.length || !cls) return false // malformed pattern: Go's Match reports an error, the caller treats it as no match
      re += (neg ? '[^' : '[') + cls + ']'; i = j
    } else if (c === '\\') { i++; if (i >= cp.length) return false; re += cp[i].replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') }
    else re += c.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')
  }
  try { return new RegExp(re + '$', 'u').test(name) } catch { return false }
}
function matchSegs(pat, segs, dirOnly) {
  if (!pat.length) return !dirOnly || segs.length > 0
  if (pat[0] === '**') {
    for (let i = 0; i <= segs.length; i++) if (matchSegs(pat.slice(1), segs.slice(i), dirOnly)) return true
    return false
  }
  if (!segs.length || !matchName(pat[0], segs[0])) return false
  if (pat.length === 1) return !dirOnly || segs.length > 1
  return matchSegs(pat.slice(1), segs.slice(1), dirOnly)
}
function ignoreMatch(pats, rel) { // the pattern that hides rel (slash separated, relative to the project folder), or ""
  if (!pats || !rel) return ''
  const segs = rel.split('/')
  for (const p of pats) {
    if (p.any) {
      const last = p.dirOnly ? segs.length - 1 : segs.length
      for (const s of segs.slice(0, Math.max(last, 0))) if (matchName(p.segs[0], s)) return p.raw
      continue
    }
    if (matchSegs(p.segs, segs, p.dirOnly)) return p.raw
  }
  return ''
}

// ---- grouping into projects (server/git.go) ----
// Windows folders ignore case, and a cwd typed in grid.yaml may not match the case git keeps
function under(p, prefix) {
  if (!prefix) return true
  if (WIN) { p = p.toLowerCase(); prefix = prefix.toLowerCase() }
  return p === prefix || p.startsWith(prefix + '/')
}

// keeps the first max untracked files (files are sorted by path) and every other change
function capUntracked(files, max) {
  const n = files.filter(f => f.status === 'U').length
  if (n <= max) return { kept: files, more: 0 }
  const kept = []; let k = 0
  for (const f of files) { if (f.status === 'U' && ++k > max) continue; kept.push(f) }
  return { kept, more: n - max }
}

async function finish(p) {
  let r = capUntracked(p.files, MAX_UNTRACKED); p.files = r.kept; if (r.more) p.more = r.more
  r = capUntracked(p.ignored, MAX_UNTRACKED); p.ignored = r.kept; if (r.more) p.ignoredMore = r.more
  await countUntracked(p.root, p.files)
}

// ctx: { svcs() -> { name: Service }, generation() -> a value that changes when the workspace is reloaded }
function createGit(ctx) {
  let gen, locs = new Map() // service folder -> { loc: { root, prefix }, at }; root "" = not a repository (for now, see REPO_RETRY)
  const sync = () => { const g = ctx.generation(); if (g !== gen) { gen = g; locs = new Map() } }
  const cached = dir => {
    const e = locs.get(dir)
    return !e || (e.loc.root === '' && Date.now() - e.at >= REPO_RETRY) ? null : e.loc
  }
  const services = () => Object.values(ctx.svcs()).map(v => v.info())

  async function projects() {
    sync()
    const list = services()
    // ask git about the folders it has not placed yet, in parallel (a Windows git start is slow); the first failure is reported
    const errs = new Map()
    await Promise.all([...new Set(list.map(s => s.cwd))].filter(d => !cached(d)).map(async dir => {
      let loc = { root: '', prefix: '' }
      try { loc = await locate(dir) } catch (e) { errs.set(dir, e.message) }
      locs.set(dir, { loc, at: Date.now() })
    }))
    let firstErr = ''
    for (const s of list) {
      const m = errs.get(s.cwd)
      if (m && m.includes('not found on PATH')) return { projects: [], error: m }
    }
    for (const s of list) { const m = errs.get(s.cwd); if (m) { firstErr = m; break } }

    const byKey = new Map(), visible = new Set() // visible: repositories with at least one service shown in Changes
    for (const s of list) {
      const loc = locs.get(s.cwd).loc
      if (!loc.root) continue
      if (!s.noChanges) visible.add(loc.root)
      const k = loc.root + '\0' + loc.prefix
      let p = byKey.get(k)
      if (!p) {
        p = { key: loc.root + '|' + loc.prefix, name: s.name, services: [], types: [], root: loc.root, prefix: loc.prefix, branch: '', files: [], ignored: [], hidden: false, patterns: [] }
        byKey.set(k, p)
      }
      if (s.noChanges) p.hidden = true // services in one folder share a project
      p.services.push(s.name); p.types.push(String(s.type)); p.patterns.push(...(s.changesIgnore || []))
    }
    if (!byKey.size) return { projects: [], error: firstErr }
    for (const p of byKey.values()) p.ignore = newIgnore(p.patterns)

    const byRoot = new Map()
    for (const p of byKey.values()) { if (!byRoot.has(p.root)) byRoot.set(p.root, []); byRoot.get(p.root).push(p) }
    const out = []
    for (const [root, plist] of byRoot) {
      if (!visible.has(root)) continue // every service of this repository is hidden: not even its other files are listed
      let st
      try { st = await status(root) } catch (e) { return { projects: [], error: e.message } }
      plist.sort((a, b) => b.prefix.length - a.prefix.length) // deepest folder first
      const rootProject = plist.find(p => p.prefix === '')
      const add = (p, f) => {
        const rel = p.prefix && f.path.length > p.prefix.length ? f.path.slice(p.prefix.length + 1) : f.path
        const pat = ignoreMatch(p.ignore, rel)
        if (pat) p.ignored.push({ ...f, pattern: pat }); else p.files.push(f)
      }
      const other = []
      for (const f of st.files) {
        const p = plist.find(p => p.prefix !== '' && under(f.path, p.prefix))
        if (p) add(p, f); else if (rootProject) add(rootProject, f); else other.push(f)
      }
      for (const p of plist) {
        if (p.files.length + p.ignored.length === 0 || p.hidden) continue // a hidden project still claims its files
        p.branch = st.branch
        await finish(p)
        out.push(p)
      }
      if (other.length) {
        const o = { key: root + '|*', name: path.basename(root) + ' (other files)', services: [], types: [], root, prefix: '', branch: st.branch, files: other, ignored: [] }
        await finish(o)
        out.push(o)
      }
    }
    out.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    // same field order as the Go JSON; the working fields (hidden, patterns, ignore) stay out
    return {
      projects: out.map(p => ({
        key: p.key, name: p.name, services: p.services, types: p.types, root: p.root, prefix: p.prefix, branch: p.branch, files: p.files, ignored: p.ignored,
        ...(p.more ? { more: p.more } : {}), ...(p.ignoredMore ? { ignoredMore: p.ignoredMore } : {}),
      })),
      error: '',
    }
  }

  // returns false when the request is not for this module
  async function handle(req, res, u, json) {
    const p = u.pathname
    if (req.method !== 'GET' || (p !== '/api/git/changes' && p !== '/api/git/diff')) return false
    // the diff is the content of the user's files: refuse requests that a web page of another origin sent (like api.cjs)
    const origin = req.headers.origin
    let foreign = req.headers['sec-fetch-site'] === 'cross-site'
    if (origin) { try { foreign = foreign || new URL(origin).host !== req.headers.host } catch { foreign = true } }
    if (foreign) return json({ error: 'cross-origin request refused' }, 403), true
    try {
      if (p === '/api/git/changes') return json(await projects()), true
      // only repositories that contain a service can be read
      const root = u.searchParams.get('repo') || ''
      if (!root || !services().some(s => { const loc = cached(s.cwd); return loc && loc.root === root })) return json({ error: 'unknown repository' }, 404), true
      const ac = new AbortController() // the browser gave up on the request
      res.on('close', () => { if (!res.writableEnded) ac.abort() })
      let d
      try { d = await fileDiff(root, u.searchParams.get('path') || '', ac.signal) } catch (e) { return json({ error: e.message }, 400), true }
      return json(d), true
    } catch (e) { return json({ error: e.message }, 500), true }
  }
  return { handle, projects }
}

module.exports = { createGit, newIgnore, ignoreMatch }
