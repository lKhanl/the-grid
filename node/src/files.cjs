// Files panel back end (read-only): browse and read the files of the services' folders.
//   GET /api/files/roots                 the folders (one per distinct service cwd)
//   GET /api/files/tree?root=&dir=       one folder level (lazy tree); git-ignored entries are left out unless ignored=1
//   GET /api/files/list?root=            every file path (git ls-files, or a bounded walk), for the filter box
// Folder listings and the filter list are cached in memory (a git start is slow on a VDI). A cached listing is reused while the
// folder's own mtime (it changes when an entry is added, removed or renamed) and the .gitignore files that decide what is hidden
// are unchanged: checking that is a few stat calls, no process. fresh=1 (the Refresh button) skips the cache.
//   GET /api/files/read?root=&path=      the text of one file (capped, binary files are only reported)
//   GET /api/files/raw?root=&path=       an image file (for the Markdown preview); other types are refused
// Only folders that belong to a service can be read, and nothing outside such a folder (.. or a symlink leading out).
const fs = require('fs'), path = require('path')
const { git } = require('./git.cjs')

const MAX_READ = 1 << 20 // bytes of one file sent to the UI
const MAX_LIST = 50000 // paths of the filter list
const MAX_ENTRIES = 5000 // entries of one folder
const IMAGES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif' }
const MAX_IMAGE = 8 << 20
const MAX_CACHE = 3000 // cached folder listings
const LIST_TTL = 60000 // a filter list is trusted this long unless .git/index or a folder change says otherwise
const WALK_SKIP = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.gradle', '.idea', '__pycache__'])

const within = (root, full) => { const r = path.relative(root, full); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) }

// ctx: { svcs() -> { name: Service } }
function createFiles(ctx) {
  const roots = () => {
    const by = new Map()
    for (const v of Object.values(ctx.svcs())) {
      const s = v.info(), root = path.resolve(s.cwd)
      let r = by.get(root)
      if (!r) by.set(root, (r = { root, name: path.basename(root) || root, services: [], types: [] }))
      r.services.push(s.name); r.types.push(String(s.type))
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  // the absolute path of rel inside root, or throws. realpath on both sides: a symlink must not lead out of the folder.
  async function safe(root, rel) {
    if (rel.includes('\0') || path.isAbsolute(rel)) throw new Error('invalid path')
    const full = path.resolve(root, rel)
    if (!within(root, full)) throw new Error('invalid path')
    const [realRoot, real] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(full)])
    if (!within(realRoot, real)) throw new Error('path leads outside the project folder')
    return full
  }

  // which of names (entries of folder `rel`) git ignores; all false when root is not a repository
  async function ignoredSet(root, rel, names) {
    const set = new Set()
    if (!names.length) return set
    const input = names.map(n => (rel ? rel + '/' : '') + n).join('\0') + '\0'
    try {
      const out = await new Promise((ok, no) => {
        const { spawn } = require('child_process')
        const c = spawn('git', ['-c', 'core.quotepath=false', 'check-ignore', '--stdin', '-z'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
        const chunks = []; c.stdout.on('data', d => chunks.push(d)); c.on('error', no)
        c.on('close', code => code === 0 || code === 1 ? ok(Buffer.concat(chunks).toString('utf8')) : no(new Error('git check-ignore')))
        c.stdin.on('error', () => {}); c.stdin.end(input)
      })
      const pre = rel ? rel.length + 1 : 0
      for (const p of out.split('\0')) if (p) set.add(p.slice(pre))
    } catch {}
    return set
  }

  const mtime = async p => { try { return (await fs.promises.stat(p)).mtimeMs } catch { return 0 } }
  const treeCache = new Map() // root \0 rel \0 ignored -> { stamp, data }
  const listCache = new Map() // root -> { at, stamp, data }

  async function tree(root, rel, showIgnored, fresh) {
    const dir = rel ? await safe(root, rel) : root
    // what the listing depends on: the folder itself and the .gitignore files above it that this panel can see (root and the folder)
    const stamp = (await Promise.all([mtime(dir), mtime(path.join(root, '.gitignore')), rel ? mtime(path.join(dir, '.gitignore')) : 0, mtime(path.join(root, '.git', 'info', 'exclude'))])).join(':')
    const key = root + '\0' + rel + '\0' + (showIgnored ? 1 : 0)
    const hit = treeCache.get(key)
    if (hit && !fresh && hit.stamp === stamp) return hit.data
    if (hit && hit.stamp !== stamp) listCache.delete(root) // something changed in this project: the filter list is stale too
    const data = await readTree(root, rel, dir, showIgnored)
    if (treeCache.size >= MAX_CACHE) treeCache.clear()
    treeCache.set(key, { stamp, data })
    return data
  }

  async function readTree(root, rel, dir, showIgnored) {
    let ents = await fs.promises.readdir(dir, { withFileTypes: true })
    ents = ents.filter(e => e.name !== '.git')
    const truncated = ents.length > MAX_ENTRIES
    if (truncated) ents = ents.slice(0, MAX_ENTRIES)
    const ign = await ignoredSet(root, rel, ents.map(e => e.name))
    const entries = []
    for (const e of ents) {
      let isDir = e.isDirectory()
      if (e.isSymbolicLink()) { try { isDir = (await fs.promises.stat(path.join(dir, e.name))).isDirectory() } catch { continue } }
      const ignored = ign.has(e.name)
      if (ignored && !showIgnored) continue
      entries.push({ name: e.name, dir: isDir, ...(ignored ? { ignored: true } : {}) })
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    return { entries, truncated }
  }

  async function list(root, fresh) {
    const stamp = (await Promise.all([mtime(path.join(root, '.git', 'index')), mtime(root)])).join(':') // .git/index: a commit, checkout or add; the folder: a new top-level entry
    const hit = listCache.get(root)
    if (hit && !fresh && hit.stamp === stamp && Date.now() - hit.at < LIST_TTL) return hit.data
    const data = await readList(root)
    listCache.set(root, { at: Date.now(), stamp, data })
    return data
  }

  async function readList(root) {
    try {
      const r = await git(root, ['ls-files', '-co', '--exclude-standard', '-z'], { cap: 8 << 20 })
      const files = r.out.toString('utf8').split('\0').filter(Boolean)
      return { files: files.slice(0, MAX_LIST), truncated: r.truncated || files.length > MAX_LIST }
    } catch {}
    const files = []; let truncated = false // not a repository: a bounded walk
    const walk = async rel => {
      if (files.length >= MAX_LIST) { truncated = true; return }
      let ents; try { ents = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        if (e.isDirectory()) { if (!WALK_SKIP.has(e.name)) await walk(rel ? rel + '/' + e.name : e.name) }
        else if (files.length < MAX_LIST) files.push(rel ? rel + '/' + e.name : e.name)
      }
    }
    await walk('')
    return { files, truncated }
  }

  async function read(root, rel) {
    const full = await safe(root, rel)
    const st = await fs.promises.stat(full)
    if (!st.isFile()) throw new Error('not a file')
    const fh = await fs.promises.open(full, 'r')
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_READ))
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      const data = buf.subarray(0, bytesRead)
      const base = { size: st.size, mtime: st.mtimeMs }
      if (data.subarray(0, 8000).indexOf(0) >= 0) return { ...base, binary: true, content: '' }
      return { ...base, content: data.toString('utf8'), truncated: st.size > MAX_READ }
    } finally { await fh.close() }
  }

  // returns false when the request is not for this module
  async function handle(req, res, u, json) {
    const p = u.pathname
    if (req.method !== 'GET' || !p.startsWith('/api/files/')) return false
    // file contents: refuse requests that a web page of another origin sent (like git.cjs)
    const origin = req.headers.origin
    let foreign = req.headers['sec-fetch-site'] === 'cross-site'
    if (origin) { try { foreign = foreign || new URL(origin).host !== req.headers.host } catch { foreign = true } }
    if (foreign) return json({ error: 'cross-origin request refused' }, 403), true
    try {
      if (p === '/api/files/roots') return json({ roots: roots() }), true
      if (p !== '/api/files/tree' && p !== '/api/files/list' && p !== '/api/files/read' && p !== '/api/files/raw') return false
      const root = path.resolve(u.searchParams.get('root') || '\0')
      if (!roots().some(r => r.root === root)) return json({ error: 'unknown folder' }, 404), true
      const rel = (u.searchParams.get('dir') ?? u.searchParams.get('path') ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      try {
        if (p === '/api/files/tree') return json(await tree(root, rel, u.searchParams.get('ignored') === '1', u.searchParams.get('fresh') === '1')), true
        if (p === '/api/files/list') return json(await list(root, u.searchParams.get('fresh') === '1')), true
        if (!rel) return json({ error: 'path required' }, 400), true
        if (p === '/api/files/raw') {
          const type = IMAGES[path.extname(rel).slice(1).toLowerCase()]
          if (!type) return json({ error: 'only image files can be fetched raw' }, 400), true
          const full = await safe(root, rel), st = await fs.promises.stat(full)
          if (!st.isFile() || st.size > MAX_IMAGE) return json({ error: 'not an image this size' }, 400), true
          // sandbox + nosniff: an SVG opened on its own cannot run script with this origin's rights
          res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'", 'cache-control': 'no-cache' })
          return fs.createReadStream(full).on('error', () => res.destroy()).pipe(res), true
        }
        return json(await read(root, rel)), true
      } catch (e) { return json({ error: e.code === 'ENOENT' ? 'no such file or folder' : e.message }, 400), true }
    } catch (e) { return json({ error: e.message }, 500), true }
  }
  return { handle }
}

module.exports = { createFiles }
