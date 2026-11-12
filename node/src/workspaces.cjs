// Recent workspaces: ~/.grid/state.json (same file and format as the Go version, port of internal/state) and the
// /api/workspaces endpoints (port of internal/server/workspaces.go). grid.cjs calls handle() after its Host / X-Grid checks;
// it returns false for paths that are not ours.
const fs = require('fs'), os = require('os'), path = require('path')

const MAX_RECENT = 20
const MAX_BODY = 1 << 20

// Grid home: $GRID_HOME, else ~/.grid.
function gridDir() { return process.env.GRID_HOME || path.join(os.homedir(), '.grid') }

// The store keeps everything else in state.json (logLines, logFiles, anything newer) untouched.
// Returns null when there is no usable home folder; recents are then simply empty.
function openStore(dir) {
  let file
  try { file = path.join(dir || gridDir(), 'state.json') } catch { return null }
  const load = () => {
    try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {} } catch { return {} } // a corrupt file just means "no history"
  }
  const save = d => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, file)
  }
  const list = d => Array.isArray(d.workspaces) ? d.workspaces.filter(w => w && typeof w.path === 'string') : []
  const exists = p => { try { fs.statSync(p); return true } catch { return false } }
  return {
    file,
    // most recently opened first; entries whose file is gone are skipped
    recent() { return list(load()).filter(w => exists(w.path)).map((w, i) => ({ w, i })).sort((a, b) => (b.w.lastOpened || 0) - (a.w.lastOpened || 0) || a.i - b.i).map(x => x.w) },
    // the most recently opened workspace that still exists
    last() { const p = load().last; return p && exists(p) ? p : '' },
    touch(p, name) {
      const d = load(), w = { path: p }
      if (name) w.name = name
      w.lastOpened = Date.now()
      d.workspaces = [w, ...list(d).filter(x => x.path !== p)].slice(0, MAX_RECENT); d.last = p
      save(d)
    },
    remove(p) {
      const d = load()
      d.workspaces = list(d).filter(x => x.path !== p)
      if (d.last === p) delete d.last
      save(d)
    },
  }
}

const readBody = req => new Promise((ok, no) => {
  let n = 0; const chunks = []
  req.on('data', c => { n += c.length; if (n > MAX_BODY) { no(new Error('request too large')); req.destroy() } else chunks.push(c) })
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { no(e) } })
  req.on('error', no)
})

// ctx: { store (or null), current() -> open grid.yaml path, switchTo(file) -> Promise (throws when it cannot load), name() -> workspace name, state() }
function createWorkspaces(ctx) {
  async function handle(req, res, u, json) {
    if (u.pathname !== '/api/workspaces' && u.pathname !== '/api/workspaces/open') return false
    const m = req.method
    if (u.pathname === '/api/workspaces' && m === 'GET') return json({ current: ctx.current(), workspaces: ctx.store ? safe(() => ctx.store.recent(), []) : [] }), true
    if (u.pathname === '/api/workspaces/open' && m === 'POST') {
      let b; try { b = await readBody(req) } catch { b = null }
      if (!b || typeof b.path !== 'string' || !b.path) return json({ error: 'path required' }, 400), true
      let file = path.resolve(b.path)
      try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'grid.yaml') } catch {} // a folder means its grid.yaml
      try { await ctx.switchTo(file) } catch (e) { return json({ error: e.message }, 400), true }
      if (ctx.store) safe(() => ctx.store.touch(ctx.current(), ctx.name()))
      return json(ctx.state()), true
    }
    if (u.pathname === '/api/workspaces' && m === 'DELETE') { // forget a workspace (the file itself is untouched)
      const p = u.searchParams.get('path') || ''
      if (!p || p === ctx.current()) return json({ error: 'cannot forget the open workspace' }, 400), true
      if (ctx.store) safe(() => ctx.store.remove(p))
      return json({ ok: true }), true
    }
    return json({ error: 'method not allowed' }, 405), true
  }
  return { handle }
}
const safe = (f, dflt) => { try { return f() } catch (e) { console.error('~/.grid state:', e.message); return dflt } } // a failing state file never breaks the workspace

module.exports = { openStore, createWorkspaces, gridDir }
