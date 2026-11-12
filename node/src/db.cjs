// The Database panel (/api/dbconn..., /api/db/...) and the guarded AI access (/api/ai/db...), port of internal/server/db.go.
// grid.cjs calls handle() after its Host / X-Grid checks; it returns false for paths that are not ours.
const { openStore, listTNSAliases } = require('./dbstore.cjs')
const { Manager, wire } = require('./dbmanager.cjs')

const MAX_BODY = 16 << 20 // a PL/SQL package body can be big
const PATHS = [/^\/api\/dbconn(\/|$)/, /^\/api\/db\//, /^\/api\/ai\/db(\/|$)/]

const clamp = (n, def, lo, hi) => { n = Number(n) || 0; if (n === 0) n = def; return Math.max(lo, Math.min(hi, Math.trunc(n))) }

function readBody(req) {
  return new Promise((ok, no) => {
    let n = 0; const chunks = []
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { no(Object.assign(new Error('request too large'), { status: 413 })); req.destroy() } else chunks.push(c) })
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8')
      try { const b = s.trim() ? JSON.parse(s) : {}; ok(b && typeof b === 'object' && !Array.isArray(b) ? b : {}) } catch (e) { no(Object.assign(new Error('bad JSON: ' + e.message), { status: 400 })) }
    })
    req.on('error', no)
  })
}

// ctx: { home (the grid folder), onChange() (features changed), manager (tests) }
function createDb(ctx) {
  const store = openStore(ctx.home)
  const mgr = ctx.manager || new Manager(store, { onChange: ctx.onChange })
  const view = name => mgr.views().find(v => v.name.toLowerCase() === String(name).toLowerCase())

  async function handle(req, res, u, json) {
    const p = u.pathname
    if (!PATHS.some(r => r.test(p))) return false
    // these endpoints run SQL and read files: refuse requests that a web page of another origin sent
    const origin = req.headers.origin
    let foreign = req.headers['sec-fetch-site'] === 'cross-site'
    if (origin) { try { foreign = foreign || new URL(origin).host !== req.headers.host } catch { foreign = true } }
    if (foreign) return json({ error: 'cross-origin request refused' }, 403), true
    const m = req.method
    const fail = (e, code) => json({ error: e.message }, e.status || (e.busy ? 409 : code || 400))
    let mt
    const seg = i => decodeURIComponent(mt[i])
    async function save(c, old) {
      let saved
      try { saved = store.put(old, c) } catch (e) { return fail(e) }
      if (old) await mgr.forget(old) // reconnect with the new settings
      return json(view(saved.name))
    }
    try {
      // ---- saved connections ----
      if (p === '/api/dbconn' && m === 'GET') return json(mgr.views()), true
      if (p === '/api/dbconn' && m === 'POST') return await save(await readBody(req), ''), true
      if (p === '/api/dbconn/reload' && m === 'POST') {
        const r = await mgr.reload()
        return json({ added: r.added, removed: r.removed, changed: r.changed, total: store.list().length }), true
      }
      if (p === '/api/dbconn/test' && m === 'POST') {
        const b = await readBody(req)
        try { return json({ ok: true, message: await mgr.test(b, String(b.existing || '')) }), true } catch (e) { return json({ ok: false, error: e.message }), true }
      }
      if (p === '/api/dbconn/tns' && m === 'GET') { // the aliases of a tnsnames.ora (file or folder), for the form
        try { return json({ aliases: listTNSAliases(u.searchParams.get('path')) }), true } catch (e) { return json({ error: e.message }, 400), true }
      }
      if (p === '/api/dbconn/order' && m === 'PUT') { // the UI's drag & drop: all names in their new order, and a group per name
        const b = await readBody(req)
        if (Array.isArray(b.names)) { store.order(b.names, b.groups); return json({ ok: true }), true }
      }
      if ((mt = p.match(/^\/api\/dbconn\/([^/]+)$/))) {
        if (m === 'PUT') return await save(await readBody(req), seg(1)), true
        if (m === 'DELETE') {
          const n = seg(1)
          await mgr.forget(n)
          try { store.del(n) } catch (e) { return json({ error: e.message }, 404), true }
          return json({ ok: true }), true
        }
      }

      // ---- the SQL session ----
      if ((mt = p.match(/^\/api\/db\/([^/]+)\/query$/)) && m === 'POST') {
        const b = await readBody(req)
        const r = await mgr.run(seg(1), String(b.sql || ''), clamp(b.maxRows, 500, 1, 10000), clamp(b.offset, 0, 0, 10000000), clamp(b.timeoutSec, 60, 1, 3600))
        return json(wire(r)), true
      }
      if ((mt = p.match(/^\/api\/db\/([^/]+)\/(commit|rollback|cancel|disconnect)$/)) && m === 'POST') {
        const n = seg(1)
        switch (mt[2]) {
          case 'commit': await mgr.commit(n); break
          case 'rollback': await mgr.rollback(n); break
          case 'cancel': mgr.cancel(n); break
          case 'disconnect': await mgr.disconnect(n); break
        }
        return json(view(n) || {}), true
      }

      // ---- schema browsing: the UI, and AI (the same data, but only for shared connections) ----
      if ((mt = p.match(/^\/api\/(ai\/)?db\/([^/]+)\/(schemas|tables|describe)$/)) && m === 'GET') {
        const n = decodeURIComponent(mt[2]), q = u.searchParams
        if (mt[1]) { const v = view(n); if (!v || v.mcp === 'off') return json({ error: 'connection is not shared with AI' }, 403), true }
        switch (mt[3]) {
          case 'schemas': {
            const schemas = await mgr.schemas(n, q.get('all') === '1')
            let current = ''; try { current = await mgr.currentSchema(n) } catch { /* the list is still useful */ }
            return json({ schemas, current }), true
          }
          case 'tables': return json(await mgr.tables(n, q.get('schema') || '', q.get('q') || '', clamp(q.get('limit'), 500, 1, 5000))), true
          case 'describe': return json(await mgr.describe(n, q.get('schema') || '', q.get('table') || '')), true
        }
      }

      // ---- AI access ----
      if (p === '/api/ai/db' && m === 'GET') return json(mgr.views().filter(v => v.mcp !== 'off')), true
      if ((mt = p.match(/^\/api\/ai\/db\/([^/]+)\/query$/)) && m === 'POST') {
        const b = await readBody(req)
        return json(wire(await mgr.aiQuery(seg(1), String(b.sql || ''), clamp(b.maxRows, 100, 1, 500), !!b.write))), true
      }
    } catch (e) { return fail(e), true }
    return json({ error: 'not found' }, 404), true
  }
  return { handle, manager: mgr, features: () => mgr.features(), close: () => mgr.close() }
}

module.exports = { createDb, clamp }
