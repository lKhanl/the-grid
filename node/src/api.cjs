// HTTP handlers for editing the configuration, the wizard helpers and the folder picker.
// grid.cjs calls handle() after its Host / X-Grid checks; it returns false for paths that are not ours.
const fs = require('fs')
const { WIN, resolvePath, dirExists } = require('./util.cjs')
const { normalizeRuntime, checkRuntime, binDir, executable, runtimeVars } = require('./config.cjs')
const edit = require('./edit.cjs')
const { detectDir, listDir, listTools, runtimeVersion } = require('./detect.cjs')

const MAX_BODY = 1 << 20
const PATHS = [/^\/api\/config\//, /^\/api\/preview$/, /^\/api\/detect$/, /^\/api\/fs\//, /^\/api\/runtimes\/probe$/]

// ctx: { file, base, svcs(), state(), reload() }
function createApi(ctx) {
  const readBody = req => new Promise((ok, no) => {
    let n = 0; const chunks = []
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { no(Object.assign(new Error('request too large'), { status: 413 })); req.destroy() } else chunks.push(c) })
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8')
      try { ok(s.trim() ? JSON.parse(s) : {}) } catch (e) { no(Object.assign(new Error('bad JSON: ' + e.message), { status: 400 })) }
    })
    req.on('error', no)
  })
  // a form path: env vars, ~ and relative paths like the config does; "C:" alone means the drive's root
  const resolve = p => { p = String(p || '').trim(); if (WIN && /^[A-Za-z]:$/.test(p)) p += '\\'; return resolvePath(ctx.base, p) }
  const isActive = n => { const s = ctx.svcs()[n]; return !!s && s.active() }

  async function probe(q) {
    let rt
    try { rt = normalizeRuntime(ctx.base, 'probe', { type: q.get('type') || '', home: q.get('home') || '', bin: q.get('bin') || '' }) } catch (e) { return { error: e.message } }
    const res = { home: rt.home, binDir: binDir(rt) }, exe = executable(rt)
    if (exe) res.exe = exe
    res.exists = dirExists(rt.home)
    const err = checkRuntime(rt)
    if (err) { res.error = err; return res }
    if (rt.type === 'script') { const t = listTools(res.binDir); if (t.length) res.tools = t; return res }
    const v = await runtimeVersion(exe, rt.type, runtimeVars(rt)); if (v) res.version = v
    return res
  }

  // returns false when the request is not for this module
  async function handle(req, res, u, json) {
    const p = u.pathname
    if (!PATHS.some(r => r.test(p))) return false
    // these endpoints can start programs or list folders: refuse requests that a web page of another origin sent
    const origin = req.headers.origin
    let foreign = req.headers['sec-fetch-site'] === 'cross-site'
    if (origin) { try { foreign = foreign || new URL(origin).host !== req.headers.host } catch { foreign = true } }
    if (foreign) return json({ error: 'cross-origin request refused' }, 403), true
    const m = req.method
    let mt
    const name = i => decodeURIComponent(mt[i])
    const fail = (e, code) => json({ error: e.message }, e.status || (e.notFound ? 404 : e.badRequest ? 400 : code || 400))
    // the file is written first; then the running state follows it
    const done = async (write, result) => {
      try { write() } catch (e) { return fail(e) }
      try { await ctx.reload() } catch (e) { return json({ error: e.message }, 500) }
      return json(result ? result() : ctx.state())
    }
    try {
      // ---- services ----
      if (p === '/api/config/services' && m === 'POST') { const s = await readBody(req); return await done(() => edit.saveService(ctx.file, '', s)), true }
      if ((mt = p.match(/^\/api\/config\/services\/([^/]+)$/))) {
        const n = name(1)
        if (m === 'GET') { try { json(edit.readSpec(ctx.file, n)) } catch (e) { fail(e, 404) }; return true }
        if (m === 'PUT') {
          const s = await readBody(req); s.name = String(s.name || '').trim()
          if (s.name !== n && isActive(n)) return json({ error: `stop ${n} before renaming it` }, 409), true
          return await done(() => edit.saveService(ctx.file, n, s)), true
        }
        if (m === 'DELETE') return await done(() => edit.deleteService(ctx.file, n)), true
      }
      if ((mt = p.match(/^\/api\/config\/services\/([^/]+)\/changes-ignore$/)) && (m === 'POST' || m === 'DELETE')) {
        const n = name(1), add = m === 'POST', b = await readBody(req), pat = String(b.pattern || '').trim()
        if (!pat) return json({ error: 'expected a pattern' }, 400), true
        let spec; try { spec = edit.readSpec(ctx.file, n) } catch (e) { return fail(e, 404), true }
        const had = spec.changesIgnore.includes(pat)
        if (!add && !had) return json({ error: `${n} has no pattern "${pat}" (edit the service to change its patterns)` }, 404), true
        spec.changesIgnore = add ? (had ? spec.changesIgnore : [...spec.changesIgnore, pat]) : spec.changesIgnore.filter(x => x !== pat)
        return await done(() => edit.saveService(ctx.file, n, spec), () => ({ changesIgnore: spec.changesIgnore.length ? spec.changesIgnore : null })), true
      }
      if (p === '/api/config/order' && m === 'PUT') { const b = await readBody(req); return await done(() => edit.reorderServices(ctx.file, b.services), () => ({ ok: true })), true }

      // ---- runtimes ----
      if (p === '/api/config/runtimes' && m === 'POST') { const s = await readBody(req); return await done(() => edit.saveRuntime(ctx.file, '', s)), true }
      if ((mt = p.match(/^\/api\/config\/runtimes\/([^/]+)$/))) {
        const n = name(1)
        if (m === 'GET') { try { json(edit.readRuntime(ctx.file, n)) } catch (e) { fail(e, 404) }; return true }
        if (m === 'PUT') { const s = await readBody(req); return await done(() => edit.saveRuntime(ctx.file, n, s)), true }
        if (m === 'DELETE') return await done(() => edit.deleteRuntime(ctx.file, n, u.searchParams.get('detach') === '1')), true
      }
      if (p === '/api/runtimes/probe' && m === 'GET') return json(await probe(u.searchParams)), true

      // ---- the same with grid.yaml's own keys (MCP): { config } adds, { change, rename } edits; the answer says whether the file changed ----
      if ((mt = p.match(/^\/api\/config\/raw\/(services|runtimes)$/))) {
        const what = mt[1]
        if (m === 'GET') { try { json(edit.readSection(ctx.file, what)) } catch (e) { fail(e) }; return true }
        if (m === 'POST') {
          const b = await readBody(req), add = what === 'services' ? edit.addServiceRaw : edit.addRuntimeRaw
          let changed; return await done(() => { changed = add(ctx.file, b.name, b.config) }, () => ({ changed })), true
        }
      }
      if ((mt = p.match(/^\/api\/config\/raw\/(services|runtimes)\/([^/]+)$/))) {
        const what = mt[1], n = name(2)
        if (m === 'GET') { try { json(what === 'services' ? edit.readServiceRaw(ctx.file, n) : edit.readRuntimeRaw(ctx.file, n)) } catch (e) { fail(e, 404) }; return true }
        if (m === 'PATCH') {
          const b = await readBody(req), to = String(b.rename || '').trim()
          if (what === 'services' && to && to !== n && isActive(n)) return json({ error: `stop ${n} before renaming it` }, 409), true
          const save = what === 'services' ? edit.editServiceRaw : edit.editRuntimeRaw
          let changed; return await done(() => { changed = save(ctx.file, n, b.change, to) }, () => ({ changed })), true
        }
      }

      // ---- wizard helpers ----
      if (p === '/api/preview' && m === 'POST') { const s = await readBody(req); return json(edit.previewSpec(ctx.base, s)), true }
      if (p === '/api/detect' && m === 'GET') return json(detectDir(resolve(u.searchParams.get('dir')))), true
      if (p === '/api/fs/check' && m === 'GET') {
        const q = resolve(u.searchParams.get('path')); let st; try { st = fs.statSync(q) } catch {}
        return json({ path: q, exists: !!st, dir: !!st && st.isDirectory() }), true
      }
      if (p === '/api/fs/list' && m === 'GET') { const q = (u.searchParams.get('path') || '').trim(); return json(listDir(q ? resolve(q) : ctx.base)), true }
    } catch (e) { return json({ error: e.message }, e.status || 400), true }
    return json({ error: 'not implemented in the node poc' }, 501), true
  }
  return { handle }
}

module.exports = { createApi }
