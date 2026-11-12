// Self-update of an installed Grid: `grid update [--check] [--force]` and the version check when `serve` starts.
// Node port of internal/update + update.go. Only Node core modules; the distribution repo is a Bitbucket "raw" endpoint.
//
// Layout (written by the installer, the-grid-node-installer.cjs, and by this module):
//   ~/.grid/node/install.json         { base, dir, version, wrapper }   which folder is active, where the dist repo is
//   ~/.grid/node/<dir>/               grid.bundle.cjs, drivers/, node_modules/...   (one folder per installed version)
//   ~/.grid/app/<wrapper>             grid.cmd:  node "<...>\grid.bundle.cjs" %*
// Nothing is replaced in place: Windows will not overwrite or delete a loaded conpty.node, so a new version is downloaded into
// a temporary folder, every file is verified, the folder is renamed, and only then install.json and the wrapper point to it.
// Old folders are removed at a later start (best effort, never one that is active or still in use).
//
// The dist address is never in this repo: it comes from install.json (written by the installer) or $GRID_DIST_URL. Neither = no updates.
const fs = require('fs'), path = require('path'), http = require('http'), https = require('https'), crypto = require('crypto')
const readline = require('readline')
const { pipeline } = require('stream/promises')
const { spawn } = require('child_process')
const { gridDir } = require('./workspaces.cjs')

const WIN = process.platform === 'win32'
const UA = 'the-grid-updater'
const INSTALLER = 'the-grid-node-installer.cjs'
const MANIFEST_REF = 'refs/heads/master'
const BUNDLE = 'grid.bundle.cjs'
const LIMITS = { files: 500, file: 64 << 20, total: 256 << 20, manifest: 1 << 20 }
const MAX_REDIRECTS = 5
const IDLE_MS = 30000
const DIR_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/       // a version folder inside ~/.grid/node
const WRAPPER_RE = /^[A-Za-z0-9_-]+\.cmd$/
const PART_RE = /^[A-Za-z0-9._-]+$/                   // one segment of a manifest path
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i // Windows device names
const ERR_NO_CREDS = 'no Bitbucket credentials (run the installer once, or set GRID_USER and GRID_TOKEN)'
const ERR_AUTH = 'Bitbucket rejected the credentials (wrong user code or PAT, or no read access)'

class UpdateError extends Error {
  constructor(msg, extra) { super(msg); this.name = 'UpdateError'; Object.assign(this, extra) }
}

// ---- version compare ----

// Newer(remote, local): leading "v" dropped, everything after the first + - or space ignored, dot-separated numbers compared in
// order (a missing part is 0): 0.12.10 > 0.12.6, v0.13.0 > 0.12.99, 0.13.0-rc1 == 0.13.0
function newer(remote, local) {
  const parts = s => String(s).trim().replace(/^v/i, '').split(/[+\- ]/)[0].split('.').map(x => /^\d+$/.test(x) ? parseInt(x, 10) : 0)
  const a = parts(remote), b = parts(local)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0
    if (x !== y) return x > y
  }
  return false
}

// ---- locations ----
const nodeDir = () => path.join(gridDir(), 'node')
const infoFile = () => path.join(nodeDir(), 'install.json')
const credFile = () => path.join(gridDir(), 'credentials')
const appDir = () => path.join(gridDir(), 'app')

// install.json, or null when it is missing / corrupt / holds anything unexpected
function readInfo() {
  try {
    const j = JSON.parse(fs.readFileSync(infoFile(), 'utf8'))
    if (!j || typeof j !== 'object' || typeof j.dir !== 'string' || !DIR_RE.test(j.dir)) return null
    return { base: typeof j.base === 'string' ? j.base : '', dir: j.dir, version: String(j.version || ''), wrapper: WRAPPER_RE.test(j.wrapper || '') ? j.wrapper : 'grid.cmd' }
  } catch { return null }
}

const isLoopback = h => h === 'localhost' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h)
const urlAllowed = u => u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u.hostname)) // http only for loopback (tests)

// The dist address: $GRID_DIST_URL wins, else install.json. null = updates are off (also for an address that is not allowed).
function distBase(info) {
  const b = (process.env.GRID_DIST_URL || '').trim() || (info && info.base) || ''
  if (!b) return null
  try { const u = new URL(b); if (!urlAllowed(u) || u.username || u.password) return null; return b.replace(/\/+$/, '') } catch { return null }
}

// Same file as the installer and the Go version: GRID_USER + GRID_TOKEN, else ~/.grid/credentials {user, token}
function loadCreds() {
  const u = (process.env.GRID_USER || '').trim(), t = (process.env.GRID_TOKEN || '').trim()
  if (u && t) return { user: u, token: t }
  try { const j = JSON.parse(fs.readFileSync(credFile(), 'utf8')); if (j && j.user && j.token) return { user: String(j.user), token: String(j.token) } } catch {}
  return null
}
const authHeader = c => 'Basic ' + Buffer.from(c.user + ':' + c.token, 'utf8').toString('base64')

// <base>/<each segment encoded, joined by />?at=<ref>   (Bitbucket Data Center raw endpoint)
function rawUrl(base, file, ref) {
  return base.replace(/\/+$/, '') + '/' + String(file).split('/').map(encodeURIComponent).join('/') + '?at=' + encodeURIComponent(ref)
}

// ---- manifest ----

// Everything in the manifest ends up in a URL and a file path, so it is checked strictly. Returns { version, tag, files, total }.
function validateManifest(m) {
  const bad = why => { throw new UpdateError('manifest.json: ' + why) }
  if (!m || typeof m !== 'object' || Array.isArray(m)) bad('unexpected format')
  const tag = String(m.tag || '')
  if (!/^[A-Za-z0-9._/-]+$/.test(tag)) bad('invalid "tag"')
  let version = String(m.version || '').trim() || tag.replace(/^v/, '')
  if (!DIR_RE.test(version) || version.length > 64) bad('invalid "version"')
  if (!Array.isArray(m.files) || !m.files.length) bad('"files" must be a non-empty list')
  if (m.files.length > LIMITS.files) bad(`too many files (max ${LIMITS.files})`)
  const seen = new Set(), dirs = new Set(), files = []
  let total = 0
  for (const f of m.files) {
    if (!f || typeof f !== 'object') bad('invalid file entry')
    const p = f.path
    if (typeof p !== 'string' || !p) bad('invalid file "path"')
    if (p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p)) bad(`invalid path "${p}" (absolute or backslash)`)
    const parts = p.split('/')
    for (const x of parts) {
      if (x === '' || x === '.' || x === '..' || !PART_RE.test(x) || x.endsWith('.') || RESERVED.test(x)) bad(`invalid path "${p}"`)
    }
    const key = p.toLowerCase() // Windows is case-insensitive
    if (seen.has(key)) bad(`duplicate path "${p}"`)
    seen.add(key)
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/').toLowerCase())
    if (!/^[0-9a-fA-F]{64}$/.test(String(f.sha256 || ''))) bad(`"${p}": sha256 must be 64 hex digits`)
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > LIMITS.file) bad(`"${p}": invalid size`)
    total += f.size
    files.push({ path: p, sha256: f.sha256.toLowerCase(), size: f.size })
  }
  for (const d of dirs) if (seen.has(d)) bad(`"${d}" is both a file and a folder`)
  if (total > LIMITS.total) bad('total size too large')
  if (!seen.has(BUNDLE)) bad(`"${BUNDLE}" is not in the list`)
  return { version, tag, files, total }
}

// ---- HTTP ----

// An overall time limit for a whole operation (connect, headers, body); aborting makes every pending request fail with the reason.
function deadline(ms) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(new Error(`timed out (${ms >= 1000 ? ms / 1000 + ' s' : ms + ' ms'})`)), ms)
  return { signal: ac.signal, done: () => clearTimeout(t) }
}
const mapAbort = (e, ctx) => ctx.signal && ctx.signal.aborted ? ctx.signal.reason : e && e.message === 'aborted' ? new Error('connection lost during the download') : e

// ctx: { auth, host, signal }. The credentials go only to the dist host, never to a redirect target elsewhere.
function get(url, ctx, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url) } catch (e) { return reject(new UpdateError('invalid address')) }
    const file = path.posix.basename(u.pathname)
    if (!urlAllowed(u)) return reject(new UpdateError(`${u.protocol}//${u.host} is not allowed (https is required)`))
    const headers = { 'User-Agent': UA }
    if (ctx.auth && u.host === ctx.host) headers.Authorization = ctx.auth
    const req = (u.protocol === 'http:' ? http : https).get(url, { headers, signal: ctx.signal }, res => {
      const code = res.statusCode
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        if (redirects >= MAX_REDIRECTS) return reject(new UpdateError('too many redirects'))
        let next; try { next = new URL(res.headers.location, url).toString() } catch { return reject(new UpdateError('invalid redirect')) }
        return resolve(get(next, ctx, redirects + 1))
      }
      if (code === 401 || code === 403) { res.resume(); return reject(new UpdateError(`${ERR_AUTH} [HTTP ${code}]`, { auth: true })) }
      if (code !== 200) { res.resume(); return reject(new UpdateError(`${file}: HTTP ${code}`, { httpStatus: code })) }
      if (String(res.headers['content-type'] || '').includes('text/html')) { res.resume(); return reject(new UpdateError(`${ERR_AUTH} [got a sign-in page]`, { auth: true })) }
      resolve(res)
    })
    req.setTimeout(IDLE_MS, () => req.destroy(new Error(`timed out (${IDLE_MS / 1000} s without data)`)))
    req.on('error', e => reject(mapAbort(e, ctx)))
  })
}

// at most max bytes of the body
async function readBody(res, max, ctx) {
  const chunks = []; let n = 0
  try {
    for await (const c of res) { chunks.push(c); n += c.length; if (n > max) { res.destroy(); break } }
  } catch (e) { throw mapAbort(e, ctx) }
  return Buffer.concat(chunks).subarray(0, max)
}

// Network errors in words; certificate problems get the same hint as the installer.
function explain(e) {
  const code = e && e.code || ''
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ISSUER/.test(code)) {
    return `${e.message} (certificate not trusted: set NODE_EXTRA_CA_CERTS to the corporate CA file, or use node --use-system-ca on Node 22+)`
  }
  return String(e && e.message ? e.message : e).replace(/\s+/g, ' ')
}

// the manifest of the newest release (refs/heads/master); ms = overall time limit
async function fetchManifest(base, creds, ms) {
  const dl = deadline(ms), ctx = { auth: authHeader(creds), host: new URL(base).host, signal: dl.signal }
  try {
    const res = await get(rawUrl(base, 'manifest.json', MANIFEST_REF), ctx)
    const body = await readBody(res, LIMITS.manifest, ctx)
    let m; try { m = JSON.parse(body.toString('utf8')) } catch (e) { throw new UpdateError('manifest.json is not valid JSON: ' + e.message) }
    return validateManifest(m)
  } finally { dl.done() }
}

// ---- install ----

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
// Windows (antivirus, indexers) may hold a file for a moment: a few retries before giving up
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to) } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
      sleepSync(200)
    }
  }
}
function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, text)
  try { renameRetry(tmp, file) } catch (e) { try { fs.unlinkSync(tmp) } catch {}; throw e }
}

// the wrapper that starts the active folder; the content is only written when it differs
function wrapperText(dirName) { return '@echo off\r\nnode "' + path.join(nodeDir(), dirName, BUNDLE).replace(/%/g, '%%') + '" %*\r\n' }
function writeWrapper(info) {
  const file = path.join(appDir(), info.wrapper), text = wrapperText(info.dir)
  try { if (fs.readFileSync(file, 'utf8') === text) return } catch {}
  writeAtomic(file, text)
}

// Downloads every file of the manifest into a temporary folder (each one hashed while it is written), renames the folder to its
// final name and activates it (install.json, then the wrapper). Nothing is active before the last file is verified; on any error
// the temporary folder is removed and the installed version is untouched. Returns the folder name.
async function install(m, base, creds, info, opts = {}) {
  const root = nodeDir(), dl = deadline(opts.timeout || 10 * 60 * 1000)
  const ctx = { auth: authHeader(creds), host: new URL(base).host, signal: dl.signal }
  const stage = path.join(root, `.tmp-${process.pid}-${Date.now()}`)
  fs.mkdirSync(stage, { recursive: true })
  try {
    for (const f of m.files) {
      const dest = path.join(stage, ...f.path.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      let res; try { res = await get(rawUrl(base, f.path, 'refs/tags/' + m.tag), ctx) } catch (e) { throw e instanceof UpdateError && e.httpStatus ? new UpdateError(`${f.path}: HTTP ${e.httpStatus}`, e) : e }
      const hash = crypto.createHash('sha256'); let size = 0
      try {
        await pipeline(res, async function* (src) {
          for await (const c of src) { hash.update(c); size += c.length; if (size > f.size) throw new UpdateError(`${f.path}: larger than the manifest says (${f.size} bytes)`); yield c }
        }, fs.createWriteStream(dest, { flags: 'wx' }))
      } catch (e) { throw mapAbort(e, ctx) }
      const got = hash.digest('hex')
      if (got !== f.sha256) throw new UpdateError(`${f.path}: SHA256 mismatch: expected ${f.sha256}, got ${got}`)
      if (size !== f.size) throw new UpdateError(`${f.path}: size mismatch: expected ${f.size}, got ${size}`)
      if (opts.onFile) opts.onFile(f)
    }
    // final name: the version, with a suffix when that folder exists (a forced reinstall, or a folder still in use)
    let name = m.version, n = 1
    for (;;) {
      if (!fs.existsSync(path.join(root, name)) && !(info && info.dir === name)) {
        try { renameRetry(stage, path.join(root, name)); break } catch (e) { if (!['ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e }
      }
      if (++n > 50) throw new UpdateError('no free folder name for ' + m.version)
      name = m.version + '_' + n
    }
    const next = { base, dir: name, version: m.version, wrapper: info ? info.wrapper : 'grid.cmd' }
    writeAtomic(infoFile(), JSON.stringify(next, null, 2) + '\n')
    try { writeWrapper(next) } catch (e) { process.stderr.write(`warning: ${next.wrapper} could not be updated (${e.message}); it is repaired at the next start\n`) }
    return name
  } catch (e) {
    try { fs.rmSync(stage, { recursive: true, force: true }) } catch {}
    throw e
  } finally { dl.done() }
}

// ---- running state and cleanup ----

const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function inUse(dir) { // some Grid started from this folder is still running
  try { return fs.readdirSync(dir).some(n => /^\.run-\d+$/.test(n) && alive(parseInt(n.slice(5), 10))) } catch { return false }
}
// `.run-<pid>` in the active folder tells a later cleanup that this folder is in use (an old folder is never removed under a running Grid)
function markRunning() {
  try {
    const f = path.join(path.dirname(__filename), `.run-${process.pid}`)
    fs.writeFileSync(f, ''); process.on('exit', () => { try { fs.unlinkSync(f) } catch {} })
  } catch {}
}
// Removes folders of older versions and abandoned downloads inside ~/.grid/node; never the active one, the one this process runs
// from, or one in use. A folder is renamed first: Windows refuses that while a loaded file (conpty.node) is inside, which is how a
// locked folder is told from a free one (nothing is half-deleted).
function cleanOld(info) {
  const root = nodeDir(), me = path.basename(path.dirname(__filename))
  let ents; try { ents = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (!e.isDirectory() || e.name === info.dir || e.name === me) continue
    const p = path.join(root, e.name)
    try {
      if (/^\.old-/.test(e.name)) { fs.rmSync(p, { recursive: true, force: true }); continue }
      if (/^\.tmp-/.test(e.name)) { if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { recursive: true, force: true }); continue }
      if (!DIR_RE.test(e.name) || inUse(p)) continue
      const trash = path.join(root, '.old-' + e.name + '-' + process.pid)
      fs.renameSync(p, trash)
      try { fs.rmSync(trash, { recursive: true, force: true }) } catch {} // what is left is retried at the next start
    } catch {}
  }
}

// Is this the installed copy (the active folder of install.json)? A copy run from the repo (node/release, node/dist) is not.
function installed(info, file = __filename) {
  if (!info) return false
  try {
    const a = fs.realpathSync(file), b = fs.realpathSync(path.join(nodeDir(), info.dir, BUNDLE))
    return WIN ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch { return false }
}

// ---- grid update ----

async function updateCmd(args, version) {
  const check = args.includes('--check'), force = args.includes('--force')
  const info = readInfo(), base = distBase(info)
  if (!base) throw new Error(`updates are not set up (no usable dist address: ${infoFile()} is missing or has no https address; install with ${INSTALLER}, or set GRID_DIST_URL)`)
  const creds = loadCreds(); if (!creds) throw new Error(ERR_NO_CREDS)
  const m = await fetchManifest(base, creds, 20000).catch(e => { throw new Error(explain(e)) })
  console.log(`installed: ${version}\nlatest:    ${m.version}`)
  const isNewer = newer(m.version, version)
  if (!isNewer && (check || !force)) { console.log('Already up to date.'); return }
  if (check) { console.log('A newer version is available. Run: grid update'); return }
  if (!installed(info)) throw new Error(`this grid is not running from ${path.join(nodeDir(), info ? info.dir : '')}, so it will not be replaced (install with the installer, or set it up there)`)
  console.log(`downloading ${m.files.length} files (${(m.total / 1048576).toFixed(1)} MB)...`)
  await install(m, base, creds, info).catch(e => { throw new Error(explain(e)) })
  console.log(`Updated to ${m.version}. Restart grid to use it.`)
}

// ---- serve start ----

// "Install it now? [Y/n]": Enter, y, yes, e, evet = yes. Resolves null when the input ends without an answer (counts as no).
function askInstall(input, output) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input, output })
    let answered = false
    rl.on('SIGINT', () => { rl.close(); process.exit(130) })
    rl.on('close', () => { if (!answered) resolve(null) })
    rl.question('Install it now? [Y/n] ', a => { answered = true; rl.close(); resolve(/^(|y|yes|e|evet)$/i.test(a.trim())) })
  })
}

// Starts the new version as a child with the same arguments and console; this process waits and leaves with its exit code.
// Ctrl+C reaches both (same console / process group): the parent ignores it and the child shuts down by itself. SIGTERM / SIGHUP
// reach only one process, so they are passed on. Resolves false when the child could not be started.
function restart(bundle) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...process.execArgv, bundle, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, GRID_UPDATED: '1' } })
    child.on('error', e => { process.stderr.write(`could not start the new version: ${e.message}\n`); resolve(false) })
    child.on('spawn', () => {
      process.on('SIGINT', () => {})
      for (const s of ['SIGTERM', 'SIGHUP']) process.on(s, () => { try { child.kill(s) } catch {} })
    })
    child.on('exit', (code, sig) => process.exit(code === null ? (sig === 'SIGINT' ? 130 : sig === 'SIGTERM' ? 143 : 1) : code))
  })
}

// Called before `serve` starts. Never throws and never waits longer than the 3 s manifest limit (plus the answer to the question).
// Resolves true only when a new version took over (and then the process exits by itself), so the caller must not start serving.
async function maybeUpdateOnServe(version, opts = {}) {
  try {
    if (process.env.GRID_UPDATED || process.env.GRID_NO_UPDATE) return false
    const info = readInfo()
    if (!installed(info)) return false // a developer build, or nothing installed: no requests at all
    cleanOld(info)
    markRunning()
    try { writeWrapper(info) } catch {}
    const base = distBase(info), creds = base && loadCreds()
    if (!base || !creds) return false
    let m
    try { m = await fetchManifest(base, creds, 3000) } catch (e) {
      process.stderr.write(e.auth ? `update check: ${e.message}; refresh them with: node ${INSTALLER} --reset-credentials\n` : `update check skipped: ${explain(e)}\n`)
      return false
    }
    if (!newer(m.version, version)) return false
    console.log(`A new version is available: ${m.version} (installed: ${version})`)
    const stdin = opts.stdin || process.stdin
    if (!stdin.isTTY) { console.log('Run `grid update` to install it.'); return false }
    if (!await askInstall(stdin, opts.stdout || process.stdout)) return false
    let dir
    try { dir = await install(m, base, creds, info) } catch (e) { process.stderr.write(`update failed, continuing with the current version: ${explain(e)}\n`); return false }
    console.log(`Updated to ${m.version}, restarting...`)
    return await restart(path.join(nodeDir(), dir, BUNDLE)) // never resolves unless the child cannot be started
  } catch (e) {
    try { process.stderr.write(`update check skipped: ${e && e.message || e}\n`) } catch {}
    return false
  }
}

module.exports = { newer, validateManifest, rawUrl, distBase, readInfo, installed, loadCreds, fetchManifest, install, cleanOld, askInstall, updateCmd, maybeUpdateOnServe, UpdateError, ERR_NO_CREDS, ERR_AUTH }
