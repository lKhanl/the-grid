// The open connections (port of internal/db/manager.go + schema.go). UI statements run in one long-lived session per connection (so commit /
// rollback mean something); AI statements get their own short ones. Everything that differs between the databases lives in dbdrivers.cjs.
const { dialects: defaultDialects, errMessage } = require('./dbdrivers.cjs')
const { normalize, toRaw, MCP_OFF, MCP_READONLY } = require('./dbstore.cjs')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const key = name => String(name).toLowerCase()
const STOP = Symbol('stop')
const METADATA_MS = 30000

class BusyError extends Error { constructor() { super('a statement is still running on this connection (stop it first)'); this.busy = true } }

// Go's time.Duration text: 30s, 1m0s, 1h0m0s
function goDuration(sec) {
  if (sec < 60) return sec + 's'
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  return (h ? h + 'h' : '') + m + 'm' + s + 's'
}

// a stopped statement's connection: ask the database to stop, then drop the connection (it may still be busy)
function killRaw(raw) {
  ;(async () => { try { await Promise.race([raw.cancel(), sleep(1500)]) } catch { /* the connection is going anyway */ } raw.destroy() })()
}

// the result as the UI expects it: empty parts left out like Go's omitempty
function wire(r) {
  const o = { kind: r.kind }
  if (r.kind === 'rows') {
    if (r.columns && r.columns.length) o.columns = r.columns
    if (r.rows && r.rows.length) o.rows = r.rows
    if (r.truncated) o.truncated = true
    if (r.offset) o.offset = r.offset
  } else if (r.rowsAffected) o.rowsAffected = r.rowsAffected
  o.ms = r.ms; o.inTx = !!r.inTx
  return o
}

class Manager {
  // opts: { dialects, aiTimeoutMs, onChange() }
  constructor(store, opts = {}) {
    this.store = store; this.dialects = opts.dialects || defaultDialects; this.aiTimeoutMs = opts.aiTimeoutMs || 30000; this.onChange = opts.onChange || (() => {})
    this.pools = new Map(); this.failed = new Map() // kind -> why its driver could not be loaded
  }

  // what the UI may offer: the panel, and the kinds whose driver is not known to be broken (drivers load on first use)
  features() { return ['db', ...Object.keys(this.dialects).sort().filter(k => !this.failed.has(k)).map(k => 'db:' + k)] }

  // the (lazily opened) pool of a saved connection
  async get(name) {
    const c = this.store.get(name)
    if (!c) throw new Error(`unknown connection "${name}"`)
    const k = key(name), have = this.pools.get(k)
    if (have) { have.conn.mcp = c.mcp; return have } // the access level is current without reconnecting
    const dialect = this.dialects[c.kind]
    if (!dialect) throw new Error(`kind "${c.kind}" is not supported (${Object.keys(this.dialects).join(', ')})`)
    const e = { conn: c, dialect, ok: false, sess: { raw: null, tx: false, running: false, ctl: null } }
    e.ready = (async () => {
      try { await dialect.load() } catch (err) {
        const why = `the ${c.kind} driver could not be loaded: ${errMessage(err).split('\n')[0]}`
        if (!this.failed.has(c.kind)) { this.failed.set(c.kind, why); this.onChange() }
        const x = new Error(why); x.driver = true; throw x
      }
      try { const pool = await dialect.openPool(c); e.ok = true; return pool } catch (err) { throw dialect.error(err) }
    })()
    e.ready.catch(() => { if (this.pools.get(k) === e) this.pools.delete(k) }) // the next use tries again
    this.pools.set(k, e)
    return e
  }

  // Re-reads the saved connections and closes the open ones that were changed or removed (their next use connects with the new settings).
  async reload() {
    const r = this.store.reload()
    await Promise.all([...r.removed, ...r.changed].map(n => this.forget(n)))
    return r
  }

  // Closes the open connection called name (after it was edited or deleted): the running statement is stopped, open changes are rolled back.
  async forget(name) {
    const e = this.pools.get(key(name)); this.pools.delete(key(name))
    if (!e) return
    const s = e.sess
    if (s.ctl) s.ctl.stop('closed')
    const raw = s.raw; s.raw = null; const tx = s.tx; s.tx = false
    if (raw) { if (s.running) killRaw(raw); else { if (tx) await raw.rollback().catch(() => {}); raw.destroy() } }
    const pool = await e.ready.catch(() => null)
    if (pool) await pool.close()
  }
  disconnect(name) { return this.forget(name) }
  async close() { await Promise.all([...this.pools.values()].map(e => this.forget(e.conn.name))) }

  // the saved connections with their live state; never with the password
  views() {
    return this.store.list().map(c => {
      const e = this.pools.get(key(c.name)), v = toRaw(c, {}) // empty optional fields left out, like Go's omitempty
      delete v.password
      v.hasPassword = !!c.password; v.connected = !!(e && e.ok); v.inTx = !!(e && e.sess.tx)
      return v
    })
  }

  // Connects with c (not saved) and reports who we are and the server version. A draft without a password uses the stored one of `existing`.
  async test(draft, existing) {
    const c = normalize({ ...draft, name: draft.name || 'test' })
    if (!c.password && existing) { const old = this.store.get(existing); if (old) c.password = old.password }
    const dialect = this.dialects[c.kind]
    if (!dialect) throw new Error(`kind "${c.kind}" is not supported`)
    try { dialect.load() } catch (err) { this.failed.set(c.kind, errMessage(err)); this.onChange(); throw new Error(`the ${c.kind} driver could not be loaded: ${errMessage(err).split('\n')[0]}`) }
    let timer, raw, late = false
    const connecting = dialect.connectOnce(c).then(r => { if (late) r.destroy(); else raw = r; return r })
    connecting.catch(() => {})
    try {
      await Promise.race([connecting, new Promise((_, no) => { timer = setTimeout(() => no(new Error('no answer within 20s')), 20000) })])
      return await dialect.hello(raw)
    } catch (err) { late = true; throw dialect.error(err) } finally { clearTimeout(timer); if (raw) raw.destroy() }
  }

  // ---- the UI session ----

  // Executes one statement in the UI session of the connection. Rejects with BusyError while another one runs.
  async run(name, sqlText, maxRows, offset, timeoutSec) {
    const e = await this.get(name), s = e.sess
    if (s.running) throw new BusyError()
    s.running = true
    const ctl = { why: '', stop: null }
    s.ctl = ctl
    const stopped = new Promise(ok => { ctl.stop = why => { if (!ctl.why) { ctl.why = why; ok() } } })
    const timer = setTimeout(() => ctl.stop('timeout'), timeoutSec * 1000)
    const work = this._runWork(e, sqlText, maxRows, offset, ctl)
    work.catch(() => {})
    try {
      const r = await Promise.race([work, stopped.then(() => STOP)])
      if (r !== STOP) return r
      // Stop answers at once, whether or not the driver can interrupt the server: a statement given up on is abandoned with its connection.
      const hadTx = s.tx, raw = s.raw
      if (s.ctl === ctl) { s.raw = null; s.tx = false }
      if (raw) killRaw(raw)
      const lost = hadTx ? '; uncommitted changes were rolled back' : ''
      if (ctl.why === 'timeout') throw new Error(`stopped after ${goDuration(timeoutSec)} (timeout); the database may still be finishing the statement${lost}`)
      throw new Error('stopped; the database may still be finishing the statement' + lost)
    } finally { clearTimeout(timer); if (s.ctl === ctl) { s.running = false; s.ctl = null } }
  }

  async _runWork(e, rawText, maxRows, offset, ctl) {
    const s = e.sess, T = e.dialect.text
    const pool = await e.ready
    if (s.raw && s.raw.dead) { // the database closed the session since the last statement (restart, kill, idle timeout)
      const lost = s.tx; s.raw.release(true); s.raw = null; s.tx = false
      if (lost) throw new Error('the connection to the database was lost; uncommitted changes were rolled back')
    }
    if (!s.raw) {
      const raw = await pool.acquire()
      if (ctl.why) { raw.release(false); throw new Error('stopped') } // given up on while connecting
      s.raw = raw
    }
    const raw = s.raw
    const gone = () => ctl.why !== ''
    // a connection-level failure drops the session, so the next run reconnects
    const resetIfBroken = err => { if (raw.broken(err) && s.raw === raw) { s.raw = null; s.tx = false; raw.release(true) } }
    const sql = T.prepare(rawText)
    if (sql === '') throw new Error('empty statement')
    const start = Date.now(), done = r => Object.assign(r, { ms: Date.now() - start, inTx: s.tx })
    const begin = async () => { try { await raw.begin() } catch (err) { resetIfBroken(err); throw raw.error(err, sql) } s.tx = true }

    const ctrl = T.txControl(sql)
    if (ctrl.startsWith('BEGIN')) { // Postgres: BEGIN typed in the editor
      if (!s.tx) {
        await begin()
        const opts = ctrl.slice(5).trim()
        if (opts) { try { await raw.exec('SET TRANSACTION ' + opts) } catch (err) { await raw.rollback().catch(() => {}); s.tx = false; throw raw.error(err, sql) } } // BEGIN ISOLATION LEVEL ...
      }
      return done({ kind: 'update' })
    }
    if (ctrl) { // COMMIT / ROLLBACK typed in the editor
      if (s.tx) {
        s.tx = false
        try { await (ctrl === 'COMMIT' ? raw.commit() : raw.rollback()) } catch (err) { resetIfBroken(err); throw raw.error(err, sql) }
      }
      return done({ kind: 'update' })
    }
    const wantRows = T.returnsRows(sql)
    if (!T.isRead(sql) && !T.noTx(sql) && !e.conn.autoCommit && !s.tx) await begin()
    const hadTx = s.tx, savepoint = hadTx && T.stmtSavepoint(sql)
    if (savepoint) { try { await raw.exec('SAVEPOINT grid_stmt') } catch (err) { resetIfBroken(err); throw raw.error(err, sql) } }
    let res
    try {
      res = wantRows ? { kind: 'rows', offset, ...(await raw.query(sql, { maxRows, offset })) } : { kind: 'update', ...(await raw.exec(sql, { autoCommit: e.conn.autoCommit && !s.tx })) }
    } catch (err) {
      if (gone()) throw err
      if (savepoint && s.tx) { // undo only this statement; the transaction stays usable (Postgres would refuse everything until a rollback otherwise)
        try { await raw.exec('ROLLBACK TO SAVEPOINT grid_stmt') } catch (err2) { resetIfBroken(err2) }
      }
      resetIfBroken(err)
      const out = raw.error(err, sql)
      if (hadTx && !s.tx) out.message += '; the session was reset and uncommitted changes were rolled back'
      throw out
    }
    if (gone()) throw new Error('stopped')
    if (savepoint && s.tx) await raw.exec('RELEASE SAVEPOINT grid_stmt').catch(() => {})
    if (T.implicitCommit(sql) && s.tx) { await raw.commit().catch(() => {}); s.tx = false } // Oracle committed everything with the DDL
    return done(res)
  }

  // Stops the statement running in the UI session of name.
  cancel(name) {
    const e = this.pools.get(key(name))
    if (e && e.sess.ctl) e.sess.ctl.stop('cancel')
  }

  // Commit / Rollback end the open transaction of the UI session.
  commit(name) { return this._endTx(name, true) }
  rollback(name) { return this._endTx(name, false) }
  async _endTx(name, commit) {
    const e = this.pools.get(key(name))
    if (!e) return
    const s = e.sess
    if (s.running) throw new BusyError()
    if (!s.tx || !s.raw) return
    s.tx = false
    try { await (commit ? s.raw.commit() : s.raw.rollback()) } catch (err) { throw s.raw.error(err) }
  }

  // ---- AI access ----

  // Runs one statement for an AI agent in its own short session: read-only connections get a READ ONLY transaction and SELECT / WITH only;
  // read-write ones may run anything and the statement is committed on success.
  async aiQuery(name, sqlText, maxRows, write) {
    const e = await this.get(name), T = e.dialect.text
    if (e.conn.mcp === MCP_OFF) throw new Error(`connection "${name}" is not shared with AI (see its MCP access setting)`)
    if (e.conn.mcp === MCP_READONLY && write) throw new Error(`connection "${name}" is read-only for AI (set its MCP access to read & write to change data)`)
    const sql = T.prepare(sqlText)
    if (write) T.checkSingle(sql); else T.checkReadOnly(sql) // refuse before touching the database
    const pool = await e.ready
    let raw, timedOut = false, timer
    const work = (async () => {
      raw = await pool.acquire()
      if (timedOut) { raw.release(false); throw new Error('timeout') }
      return this._aiRun(raw, T, sql, maxRows, write, e.conn)
    })()
    work.catch(() => {})
    try {
      return await Promise.race([work, new Promise((_, no) => {
        timer = setTimeout(() => { timedOut = true; no(new Error(`stopped after ${goDuration(Math.round(this.aiTimeoutMs / 1000))} (timeout); the database may still be finishing the statement, but its changes are rolled back`)) }, this.aiTimeoutMs)
      })])
    } finally { clearTimeout(timer); if (timedOut && raw) killRaw(raw) }
  }

  async _aiRun(raw, T, sql, maxRows, write, conn) {
    const start = Date.now()
    let bad = false
    try {
      if (!write) {
        await raw.begin()
        try {
          try { await raw.exec('SET TRANSACTION READ ONLY') } catch (err) { throw new Error('cannot start a read-only transaction: ' + raw.error(err).message) }
          const res = await raw.query(sql, { maxRows, offset: 0 })
          return { kind: 'rows', ...res, ms: Date.now() - start }
        } finally { await raw.rollback().catch(() => { bad = true }) }
      }
      if (T.noTx(sql)) { // e.g. VACUUM: cannot run in a transaction
        const res = await raw.exec(sql, { autoCommit: true })
        return { kind: 'update', ...res, ms: Date.now() - start }
      }
      await raw.begin()
      let res
      try { res = T.returnsRows(sql) ? { kind: 'rows', ...(await raw.query(sql, { maxRows, offset: 0 })) } : { kind: 'update', ...(await raw.exec(sql, { autoCommit: false })) } } catch (err) {
        await raw.rollback().catch(() => { bad = true }); throw err
      }
      await raw.commit()
      return { ...res, ms: Date.now() - start }
    } catch (err) {
      bad = bad || raw.broken(err)
      throw raw.error(err, sql)
    } finally {
      if (!bad) await raw.reset().catch(() => { bad = true })
      raw.release(bad)
    }
  }

  // ---- schema browsing ----

  // runs the queries of fn on one pooled connection, each with its own time limit
  async _meta(name, fn) {
    const e = await this.get(name), pool = await e.ready, raw = await pool.acquire()
    let bad = false
    const q = (sql, params) => {
      let timer
      return Promise.race([raw.select(sql, params), new Promise((_, no) => { timer = setTimeout(() => { bad = true; no(new Error('the catalog query did not answer within 30s')) }, METADATA_MS) })])
        .catch(err => { bad = bad || raw.broken(err); throw raw.error(err, sql) }).finally(() => clearTimeout(timer))
    }
    try { return await fn(q, e.dialect) } finally { if (bad) killRaw(raw); raw.release(bad) }
  }

  // the schema the connection's user works in
  currentSchema(name) { return this._meta(name, async (q, d) => { const r = await q(d.currentSchemaSQL()); return r[0] ? String(r[0][0]) : '' }) }

  // the schemas that hold user objects (the database's own ones are left out unless all is set)
  schemas(name, all) { return this._meta(name, async (q, d) => (await q(d.schemasSQL(all))).map(r => String(r[0]))) }

  // Tables and views. schema "" means the user's current schema, "*" all user schemas.
  async tables(name, schema, search, limit) {
    if (!schema) schema = await this.currentSchema(name)
    return this._meta(name, async (q, d) => {
      const like = likePattern(search), all = schema === '*'
      const rows = await q(d.tablesSQL(all), all ? [like] : [schema, like])
      const out = []; let truncated = false
      for (const r of rows) {
        if (out.length >= limit) { truncated = true; break }
        const t = { schema: String(r[0]), name: String(r[1]), type: String(r[2]) }
        if (r[3]) t.comment = String(r[3])
        out.push(t)
      }
      return { tables: out, truncated }
    })
  }

  // columns, keys and indexes of one table or view
  async describe(name, schema, table) {
    if (!schema) schema = await this.currentSchema(name)
    return this._meta(name, async (q, d) => {
      let info = await describeExact(q, d.meta(), schema, table)
      const f = d.foldName(table)
      if (!info.columns.length && table !== f) info = await describeExact(q, d.meta(), schema, f) // unquoted names: upper case in Oracle, lower in Postgres
      if (!info.columns.length) throw new Error(`table or view ${schema}.${table} not found (or no access)`)
      return info
    })
  }
}

// turns a search word into an upper-case LIKE pattern ("*" and "%" are wildcards)
function likePattern(q) {
  q = String(q || '').trim().toUpperCase().replace(/\*/g, '%')
  if (q === '') return '%'
  return q.includes('%') ? q : '%' + q + '%'
}

const num = v => (v === null || v === undefined ? null : Number(v))
function typeName(dt, charLen, prec, scale) {
  switch (dt) {
    case 'VARCHAR2': case 'NVARCHAR2': case 'CHAR': case 'NCHAR': if (charLen > 0) return `${dt}(${charLen})`; break
    case 'NUMBER': if (prec > 0) return scale ? `NUMBER(${prec},${scale})` : `NUMBER(${prec})`
  }
  return dt
}

async function describeExact(q, meta, schema, table) {
  const args = [schema, table], info = { schema, name: table, type: '', columns: [] }
  for (const r of await q(meta.object, args)) { info.type = String(r[0]); if (r[1]) info.comment = String(r[1]) }
  for (const r of await q(meta.columns, args)) {
    const col = { name: String(r[0]), type: typeName(String(r[1]), num(r[2]), num(r[3]), num(r[4])), nullable: r[5] === 'Y' }
    if (r[6]) col.comment = String(r[6])
    info.columns.push(col)
  }
  if (!info.columns.length) return info
  // primary / unique / foreign keys
  const order = [], cols = new Map()
  for (const r of await q(meta.keys, args)) {
    const k = r[0] + '\u0000' + r[1]
    if (!cols.has(k)) { cols.set(k, []); order.push({ name: String(r[0]), typ: String(r[1]), k }) }
    cols.get(k).push(String(r[2]))
  }
  const refTable = new Map(), refCols = new Map()
  for (const r of await q(meta.fkRefs, args)) { refTable.set(r[0], r[1] + '.' + r[2]); if (!refCols.has(r[0])) refCols.set(r[0], []); refCols.get(r[0]).push(String(r[3])) }
  const pk = new Set()
  for (const k of order) {
    const c = cols.get(k.k)
    if (k.typ === 'P') { info.primaryKey = c; c.forEach(x => pk.add(x)) }
    else if (k.typ === 'U') (info.unique = info.unique || []).push({ name: k.name, columns: c })
    else if (k.typ === 'R') { const fk = { name: k.name, columns: c }; if (refTable.has(k.name)) fk.ref = `${refTable.get(k.name)}(${refCols.get(k.name).join(', ')})`; (info.foreignKeys = info.foreignKeys || []).push(fk) }
  }
  for (const c of info.columns) if (pk.has(c.name)) c.pk = true
  // indexes
  const idx = new Map()
  for (const r of await q(meta.indexes, args)) {
    if (!idx.has(r[0])) idx.set(r[0], { name: String(r[0]), unique: r[1] === 'UNIQUE', columns: [] })
    idx.get(r[0]).columns.push(String(r[2]))
  }
  if (idx.size) info.indexes = [...idx.values()]
  return info
}

module.exports = { Manager, BusyError, wire, likePattern, typeName, goDuration }
