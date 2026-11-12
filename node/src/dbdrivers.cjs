// The two database drivers (pure JavaScript, loaded on first use): PostgreSQL through `pg` (+ pg-cursor) and Oracle through `oracledb` in Thin mode
// (no Instant Client; initOracleClient is never called). Each dialect brings its SQL text rules (sqltext.cjs), its catalog queries (port of the
// Go dialects) and a connection pool whose connections ("raw") all speak the same small interface:
//   query(sql, { maxRows, offset }) -> { columns: [{ name, type }], rows: (string|null)[][], truncated }
//   exec(sql, { autoCommit }) -> { rowsAffected }          select(sql, params) -> raw rows (catalog queries)
//   begin() commit() rollback()    cancel() (best effort, from another connection)    release(bad)    destroy()
const fs = require('fs'), os = require('os'), path = require('path')
const text = require('./sqltext.cjs')
const { formatCell, formatNumber, formatBinary, oracleNumber, pgTimestamptz } = require('./dbformat.cjs')
const { lookupTNS } = require('./dbstore.cjs')

const CONNECT_TIMEOUT = 15000
const MAX_CONNS = 8
const IDLE_MS = 5 * 60 * 1000

// ---- a small connection pool: stopped statements keep their connection until the database ends them, idle ones go after 5 minutes ----
class Pool {
  constructor(create, max = MAX_CONNS) { this.create = create; this.max = max; this.idle = []; this.total = 0; this.waiters = []; this.closed = false }
  async acquire() {
    for (;;) {
      if (this.closed) throw new Error('connection closed')
      const e = this.idle.pop()
      if (e) { clearTimeout(e.timer); if (e.raw.dead) { this.total--; e.raw.destroy(); continue } return e.raw }
      if (this.total < this.max) {
        this.total++
        try { const raw = await this.create(); raw.pool = this; return raw } catch (err) { this.total--; this._wake(); throw err }
      }
      await new Promise(ok => this.waiters.push(ok))
    }
  }
  _wake() { const w = this.waiters.shift(); if (w) w() }
  release(raw, bad) {
    if (bad || raw.dead || this.closed) { this.total--; raw.destroy(); this._wake(); return }
    const e = { raw, timer: setTimeout(() => { this.idle = this.idle.filter(x => x !== e); this.total--; raw.destroy() }, IDLE_MS) }
    e.timer.unref && e.timer.unref()
    this.idle.push(e); this._wake()
  }
  async close() {
    this.closed = true
    for (const e of this.idle.splice(0)) { clearTimeout(e.timer); e.raw.destroy() }
    this.total = 0; for (const w of this.waiters.splice(0)) w()
  }
}

// the message of a driver error (an AggregateError of a dual-stack connect attempt has none of its own)
function errMessage(e) {
  if (e && !e.message && Array.isArray(e.errors)) return e.errors.map(x => x.message).filter(Boolean).join('; ') || String(e)
  return (e && e.message) || String(e)
}
const lineCol = (sql, pos) => { // pos: 1-based character position
  const before = sql.slice(0, Math.max(0, pos - 1)).split('\n')
  return { line: before.length, column: before[before.length - 1].length + 1 }
}

// ============================ PostgreSQL ============================

const PG_TYPES = { 16: 'BOOL', 17: 'BYTEA', 18: 'CHAR', 19: 'NAME', 20: 'INT8', 21: 'INT2', 23: 'INT4', 25: 'TEXT', 26: 'OID', 114: 'JSON', 142: 'XML', 650: 'CIDR', 700: 'FLOAT4',
  701: 'FLOAT8', 790: 'MONEY', 829: 'MACADDR', 869: 'INET', 1042: 'BPCHAR', 1043: 'VARCHAR', 1082: 'DATE', 1083: 'TIME', 1114: 'TIMESTAMP', 1184: 'TIMESTAMPTZ', 1186: 'INTERVAL',
  1266: 'TIMETZ', 1560: 'BIT', 1562: 'VARBIT', 1700: 'NUMERIC', 2950: 'UUID', 3802: 'JSONB', 1000: '_BOOL', 1001: '_BYTEA', 1005: '_INT2', 1007: '_INT4', 1009: '_TEXT', 1014: '_BPCHAR',
  1015: '_VARCHAR', 1016: '_INT8', 1021: '_FLOAT4', 1022: '_FLOAT8', 1115: '_TIMESTAMP', 1182: '_DATE', 1185: '_TIMESTAMPTZ', 1231: '_NUMERIC', 2951: '_UUID', 199: '_JSON', 3807: '_JSONB' }

// The drivers are separate files next to the bundle (drivers/pg.cjs, drivers/oracledb.cjs: pure JavaScript, built by build.sh) so that nobody who
// does not use a database pays for parsing them; run from src/ the same path leads to the small wrappers that require the packages.
const driverFile = name => path.join(__dirname, 'drivers', name + '.cjs')

let pgLib = null
function loadPg() {
  if (!pgLib) {
    const { pg, Cursor } = require(driverFile('pg'))
    // Everything comes back as the server's own text (every digit of int8 / numeric, JSON, dates with their zone); only bytea stays binary
    const bytea = pg.types.getTypeParser(17, 'text')
    const parsers = { 16: s => (s === 't' ? 'true' : 'false'), 17: bytea, 700: s => formatNumber(Number(s)), 701: s => formatNumber(Number(s)), 1184: pgTimestamptz }
    const raw = s => s
    pgLib = { pg, Cursor, types: { getTypeParser: oid => parsers[oid] || raw } }
  }
  return pgLib
}

const pgRootCert = () => {
  const cands = [process.env.PGSSLROOTCERT, path.join(os.homedir(), '.postgresql', 'root.crt'), process.env.APPDATA && path.join(process.env.APPDATA, 'postgresql', 'root.crt')]
  for (const f of cands) { try { if (f) return fs.readFileSync(f) } catch { /* next */ } }
  return undefined
}
// libpq's sslmode for node-postgres: [ssl options to try in order]
function pgSslAttempts(mode) {
  const ca = (mode === 'verify-ca' || mode === 'verify-full') ? pgRootCert() : undefined
  const ssl = {
    require: { rejectUnauthorized: false },
    'verify-ca': { rejectUnauthorized: true, ca, checkServerIdentity: () => undefined }, // the chain is checked, the host name is not
    'verify-full': { rejectUnauthorized: true, ca },
  }
  switch (mode) {
    case 'disable': return [false]
    case 'allow': return [false, ssl.require]
    case 'prefer': return [ssl.require, false]
    default: return [ssl[mode]]
  }
}
function pgConfig(c, ssl) {
  const cfg = { host: c.host, port: c.port, database: c.database, user: c.user, ssl, application_name: 'The Grid', connectionTimeoutMillis: CONNECT_TIMEOUT, types: loadPg().types, keepAlive: true }
  if (c.password) cfg.password = c.password
  return cfg
}
async function pgConnect(c, cfgOverride) {
  const { pg } = loadPg()
  let lastErr
  for (const ssl of pgSslAttempts(c.sslMode || 'prefer')) {
    const client = new pg.Client(cfgOverride || pgConfig(c, ssl))
    client.on('error', () => { client.dead = true })
    try { await client.connect(); client.sslUsed = !!ssl; client.cfg = pgConfig(c, ssl); return client } catch (e) {
      lastErr = e; try { client.end().catch(() => {}) } catch { /* gone */ }
      // a refusal by the server's rules (wrong password, no such database) is final; a failed SSL negotiation is not
      if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && e.code !== '28000') break
      if (!/SSL|ssl|TLS|certificate|ECONNRESET|self.signed|handshake/i.test(errMessage(e)) && e.code !== '28000') break
    }
  }
  throw lastErr
}

class PgRaw {
  constructor(client, typeNames) { this.client = client; this.typeNames = typeNames; this.dead = false; client.on('error', () => { this.dead = true }); client.on('end', () => { this.dead = true }) }
  async typeName(oid) {
    if (PG_TYPES[oid]) return PG_TYPES[oid]
    if (!this.typeNames.has(oid)) {
      let n = String(oid)
      try { const r = await this.client.query({ text: 'select typname from pg_type where oid = $1', values: [oid], rowMode: 'array' }); if (r.rows[0]) n = String(r.rows[0][0]).toUpperCase() } catch { /* in a failed transaction: keep the number */ }
      this.typeNames.set(oid, n)
    }
    return this.typeNames.get(oid)
  }
  async query(sql, { maxRows, offset = 0 }) {
    const { Cursor, types } = loadPg()
    const cur = this.client.query(new Cursor(sql, null, { rowMode: 'array', types }))
    const rows = []
    let skipped = 0, truncated = false, fields
    try {
      outer: for (;;) {
        const part = await cur.read(500)
        fields = cur._result && cur._result.fields
        if (!part.length) break
        for (const r of part) {
          if (skipped < offset) { skipped++; continue }
          if (rows.length >= maxRows) { truncated = true; break outer }
          rows.push(r.map(v => (v === null ? null : Buffer.isBuffer(v) ? formatBinary(v) : String(v))))
        }
      }
    } finally { await new Promise(ok => cur.close(() => ok())).catch(() => {}) }
    const columns = []
    for (const f of fields || []) columns.push({ name: f.name, type: await this.typeName(f.dataTypeID) })
    return { columns, rows, truncated }
  }
  async exec(sql) {
    const r = await this.client.query({ text: sql, types: loadPg().types }) // the simple protocol
    const last = Array.isArray(r) ? r[r.length - 1] : r
    return { rowsAffected: (last && last.rowCount) || 0 }
  }
  async select(sql, params) {
    const r = await this.client.query({ text: sql, values: params || [], rowMode: 'array', types: loadPg().types })
    return r.rows
  }
  // what an AI statement may have changed in the session (set_config, SET ROLE, advisory locks ...) must not reach the next user of the connection
  async reset() { await this.client.query('DISCARD ALL') }
  async begin() { await this.client.query('BEGIN') }
  async commit() { await this.client.query('COMMIT') }
  async rollback() { await this.client.query('ROLLBACK') }
  // pg_cancel_backend from a second connection (what the "stop" button needs while the first one is busy)
  async cancel() {
    const pid = this.client.processID
    if (!pid) return
    const c2 = new (loadPg().pg.Client)({ ...this.client.cfg, connectionTimeoutMillis: 5000 })
    c2.on('error', () => {})
    try { await c2.connect(); await c2.query('select pg_cancel_backend($1)', [pid]) } finally { c2.end().catch(() => {}) }
  }
  release(bad) { this.pool.release(this, bad) }
  destroy() { this.dead = true; try { this.client.end().catch(() => {}); this.client.connection && this.client.connection.stream && setTimeout(() => this.client.connection.stream.destroy(), 1000).unref() } catch { /* gone */ } }
  error(e, sql) { return pgError(e, sql) }
  broken(e) { return this.dead || /^(08|57P0[1-3])/.test(e.code || '') || /Connection terminated|ECONNRESET|EPIPE|not queryable|closed/i.test(errMessage(e)) }
}

// pgx's way of printing a server error: "ERROR: relation "x" does not exist (SQLSTATE 42P01)", plus where in the statement
function pgError(e, sql) {
  if (!e || typeof e.code !== 'string' || !/^[0-9A-Z]{5}$/.test(e.code) || !e.severity) return new Error(errMessage(e))
  let msg = `${e.severity}: ${e.message} (SQLSTATE ${e.code})`
  const err = new Error(msg)
  const pos = Number(e.position)
  if (pos > 0 && sql) { const lc = lineCol(sql, pos); err.message += ` [line ${lc.line}, column ${lc.column}]`; err.position = { offset: pos - 1, ...lc } }
  return err
}

const pgDialect = {
  kind: 'postgres',
  load: () => loadPg(), error: e => pgError(e),
  text: text.pg,
  foldName: n => n.toLowerCase(),
  async openPool(c) {
    const client0 = await pgConnect(c)
    const cfg = client0.cfg, typeNames = new Map()
    let first = client0
    const pool = new Pool(async () => {
      if (first) { const f = first; first = null; return new PgRaw(f, typeNames) }
      const cl = new (loadPg().pg.Client)(cfg); cl.on('error', () => {}); cl.cfg = cfg
      await cl.connect(); return new PgRaw(cl, typeNames)
    })
    return pool
  },
  async hello(raw) {
    const r = await raw.select(`SELECT current_user, current_setting('server_version')`)
    return `Connected as ${r[0][0]} (PostgreSQL ${r[0][1]})`
  },
  // a standalone connection for the connection test
  async connectOnce(c) { return new PgRaw(await pgConnect(c), new Map()) },
  currentSchemaSQL: () => `SELECT COALESCE(current_schema(), 'public')`,
  schemasSQL: all => `SELECT n.nspname FROM pg_namespace n ${all ? '' : 'WHERE ' + PG_USER_SCHEMAS} ORDER BY 1`,
  tablesSQL(all) {
    const where = all ? PG_USER_SCHEMAS : 'n.nspname = $1', like = all ? '$1' : '$2'
    return `SELECT n.nspname, c.relname, ${PG_REL_KIND}, obj_description(c.oid, 'pg_class')
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${where} AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition
      AND upper(c.relname) LIKE ${like}
      ORDER BY 1, 2`
  },
  meta: () => ({
    object: `SELECT ${PG_REL_KIND}, obj_description(c.oid, 'pg_class')
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p','v','m','f')`,
    columns: `SELECT a.attname, format_type(a.atttypid, a.atttypmod), NULL::int, NULL::int, NULL::int,
      CASE WHEN a.attnotnull THEN 'N' ELSE 'Y' END, col_description(a.attrelid, a.attnum)
      FROM pg_attribute a WHERE a.attrelid = ${PG_REL} AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    keys: `SELECT con.conname, CASE con.contype WHEN 'p' THEN 'P' WHEN 'u' THEN 'U' ELSE 'R' END, a.attname
      FROM pg_constraint con
      CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      WHERE con.conrelid = ${PG_REL} AND con.contype IN ('p','u','f')
      ORDER BY con.conname, k.ord`,
    fkRefs: `SELECT con.conname, rn.nspname, rc.relname, a.attname
      FROM pg_constraint con
      JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
      CROSS JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
      WHERE con.conrelid = ${PG_REL} AND con.contype = 'f'
      ORDER BY con.conname, k.ord`,
    indexes: `SELECT ic.relname, CASE WHEN i.indisunique THEN 'UNIQUE' ELSE 'NONUNIQUE' END, pg_get_indexdef(i.indexrelid, k.n, true)
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
      CROSS JOIN LATERAL generate_series(1, i.indnatts::int) AS k(n)
      WHERE i.indrelid = ${PG_REL}
      ORDER BY ic.relname, k.n`,
  }),
}
const PG_USER_SCHEMAS = `n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`
const PG_REL_KIND = `CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END`
const PG_REL = `(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2)`

// ============================ Oracle (Thin) ============================

let oraLib = null
function loadOra() {
  if (!oraLib) {
    const oracledb = require(driverFile('oracledb'))
    if (!oracledb.thin) throw new Error('oracledb is not in Thin mode') // never initOracleClient(): Thin needs no Instant Client
    // numbers come as text (every digit of NUMBER(38)), LOBs as text / bytes; the rest in the driver's own types
    const handler = m => {
      switch (m.dbType) {
        case oracledb.DB_TYPE_NUMBER: return { type: oracledb.STRING }
        case oracledb.DB_TYPE_CLOB: case oracledb.DB_TYPE_NCLOB: return { type: oracledb.STRING }
        case oracledb.DB_TYPE_BLOB: return { type: oracledb.BUFFER }
      }
      return undefined
    }
    oraLib = { oracledb, handler }
  }
  return oraLib
}

// A DATE / TIMESTAMP arrives as a JS Date built from the wall-clock fields in the local zone: read them back the same way.
const p2 = n => String(n).padStart(2, '0')
function oraDate(d, type) {
  let s = `${String(d.getFullYear()).padStart(4, '0')}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  const ms = d.getMilliseconds()
  if (ms && type !== 'DATE') s += '.' + String(ms).padStart(3, '0').replace(/0+$/, '')
  return s
}
function oraCell(v, type) {
  if (v === null || v === undefined) return null
  if (v instanceof Date) {
    if (type === 'TIMESTAMP WITH LOCAL TIME ZONE') { // the instant, in this machine's zone (the session zone of a Thin connection)
      const off = -v.getTimezoneOffset(), a = Math.abs(off)
      return `${oraDate(v, type)} ${off < 0 ? '-' : '+'}${p2(Math.floor(a / 60))}:${p2(a % 60)}`
    }
    if (type === 'TIMESTAMP WITH TIME ZONE') { // Thin hands over the instant, the zone it was stored with is not known: UTC
      const u = new Date(v.getTime() + v.getTimezoneOffset() * 60000)
      return oraDate(u, type) + ' +00:00'
    }
    return oraDate(v, type)
  }
  if (typeof v === 'string' && type === 'NUMBER') return oracleNumber(v)
  if (typeof v === 'number' && type === 'BINARY_FLOAT') return formatNumber(float32Shortest(v))
  return formatCell(v, type)
}
function float32Shortest(x) { // 1.100000023841858 (a float32 read as double) -> 1.1
  if (!Number.isFinite(x)) return x
  for (let p = 1; p <= 9; p++) { const y = Number(x.toPrecision(p)); if (Math.fround(y) === x) return y }
  return x
}

class OraRaw {
  constructor(conn) { this.conn = conn; this.dead = false }
  async query(sql, { maxRows, offset = 0 }) {
    const { oracledb, handler } = loadOra()
    const r = await this.conn.execute(sql, [], { resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY, fetchTypeHandler: handler, fetchArraySize: Math.max(2, Math.min(500, offset + maxRows + 1)) })
    const rs = r.resultSet
    const columns = rs.metaData.map(m => ({ name: m.name, type: m.dbTypeName || '' }))
    const rows = []
    let skipped = 0, truncated = false
    try {
      outer: for (;;) {
        const part = await rs.getRows(200)
        if (!part.length) break
        for (const row of part) {
          if (skipped < offset) { skipped++; continue }
          if (rows.length >= maxRows) { truncated = true; break outer }
          rows.push(row.map((v, i) => oraCell(v, columns[i].type)))
        }
      }
    } finally { await rs.close().catch(() => {}) }
    return { columns, rows, truncated }
  }
  async exec(sql, { autoCommit } = {}) {
    const r = await this.conn.execute(sql, [], { autoCommit: !!autoCommit })
    return { rowsAffected: r.rowsAffected || 0 }
  }
  async select(sql, params) {
    const { oracledb } = loadOra()
    const r = await this.conn.execute(sql, params || [], { outFormat: oracledb.OUT_FORMAT_ARRAY })
    return r.rows
  }
  async reset() { /* a SELECT cannot change an Oracle session */ }
  async begin() { /* an Oracle transaction starts with its first statement */ }
  async commit() { await this.conn.commit() }
  async rollback() { await this.conn.rollback() }
  async cancel() { await this.conn.break() }
  release(bad) { this.pool.release(this, bad) }
  destroy() { this.dead = true; this.conn.close({ drop: true }).catch(() => {}) }
  error(e, sql) { return oraError(e, sql) }
  broken(e) { return this.dead || /NJS-500|NJS-503|NJS-510|NJS-521|NJS-040|DPI-1010|DPI-1080|ORA-0(3113|3114|3135|0028|1012|2396)|ORA-1(2170|2547)|closed|ECONNRESET|EPIPE/.test(String(e && (e.code || '') + ' ' + errMessage(e))) }
}

// ORA-00942: table or view does not exist, plus where in the statement (the "Help: ..." line the driver adds is left out)
function oraError(e, sql) {
  const msg = errMessage(e).split('\n').filter(l => !/^Help: https?:\/\//.test(l)).join('\n').trim()
  const err = new Error(msg)
  // the driver reports a 0-based character offset; 0 is also what "no position" looks like, so it counts only for the syntax errors (ORA-009xx)
  if (sql && typeof e.offset === 'number' && (e.offset > 0 || (e.errorNum >= 900 && e.errorNum <= 999))) {
    const lc = lineCol(sql, e.offset + 1) // the Go driver said "error occur at position: N" (0-based): same words, plus line and column
    err.message += `\n error occur at position: ${e.offset} (line ${lc.line}, column ${lc.column})`; err.position = { offset: e.offset, ...lc }
  }
  return err
}

function oraConnectString(c) {
  const host = c.host && c.host.includes(':') && !c.host.startsWith('[') ? `[${c.host}]` : c.host
  switch (c.mode) {
    case 'service': return `${host}:${c.port}/${c.service}`
    case 'sid': return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${c.host})(PORT=${c.port}))(CONNECT_DATA=(SID=${c.sid})))`
    case 'tns': return c.tns.trim().startsWith('(') ? c.tns.trim() : lookupTNS(c.tns, c.tnsAdmin)
  }
  throw new Error(`mode "${c.mode}"`)
}

async function oraConnect(c) {
  const { oracledb } = loadOra()
  const conn = await oracledb.getConnection({ user: c.user, password: c.password, connectString: oraConnectString(c), transportConnectTimeout: CONNECT_TIMEOUT / 1000 })
  const raw = new OraRaw(conn)
  // timestamps and intervals as strings without NLS surprises are the driver's job; nothing to set on the session
  return raw
}

const oracleDialect = {
  kind: 'oracle',
  load: () => loadOra(), error: e => oraError(e),
  text: text.oracle,
  foldName: n => n.toUpperCase(),
  async openPool(c) {
    oraConnectString(c) // an unknown alias fails here, not on the first statement
    return new Pool(() => oraConnect(c))
  },
  async hello(raw) {
    const r = await raw.select(`SELECT sys_context('USERENV','SESSION_USER') FROM dual`)
    let version = ''
    try { version = (await raw.select(`SELECT version FROM product_component_version WHERE ROWNUM = 1`))[0][0] } catch { /* best effort */ }
    return 'Connected as ' + r[0][0] + (version ? ` (Oracle ${version})` : '')
  },
  connectOnce: c => oraConnect(c),
  currentSchemaSQL: () => `SELECT sys_context('USERENV','CURRENT_SCHEMA') FROM dual`,
  schemasSQL: all => all ? `SELECT username FROM all_users ORDER BY username` : `SELECT username FROM all_users WHERE oracle_maintained = 'N' ORDER BY username`,
  tablesSQL(all) {
    const where = all ? `o.owner IN (SELECT username FROM all_users WHERE oracle_maintained = 'N')` : 'o.owner = :1', like = all ? ':1' : ':2'
    return `SELECT o.owner, o.object_name, o.object_type, tc.comments
      FROM all_objects o LEFT JOIN all_tab_comments tc ON tc.owner = o.owner AND tc.table_name = o.object_name
      WHERE ${where} AND o.object_type IN ('TABLE','VIEW','MATERIALIZED VIEW')
      AND o.object_name LIKE ${like}
      ORDER BY o.owner, o.object_name`
  },
  meta: () => ({
    object: `SELECT o.object_type, tc.comments FROM all_objects o
      LEFT JOIN all_tab_comments tc ON tc.owner = o.owner AND tc.table_name = o.object_name
      WHERE o.owner = :1 AND o.object_name = :2 AND o.object_type IN ('TABLE','VIEW','MATERIALIZED VIEW') AND ROWNUM = 1`,
    columns: `SELECT c.column_name, c.data_type, c.char_length, c.data_precision, c.data_scale, c.nullable, cc.comments
      FROM all_tab_columns c LEFT JOIN all_col_comments cc
        ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
      WHERE c.owner = :1 AND c.table_name = :2 ORDER BY c.column_id`,
    keys: `SELECT ac.constraint_name, ac.constraint_type, acc.column_name
      FROM all_constraints ac JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name
      WHERE ac.owner = :1 AND ac.table_name = :2 AND ac.constraint_type IN ('P','U','R')
      ORDER BY ac.constraint_name, acc.position`,
    fkRefs: `SELECT ac.constraint_name, rc.owner, rc.table_name, rcc.column_name
      FROM all_constraints ac
      JOIN all_constraints rc ON rc.owner = ac.r_owner AND rc.constraint_name = ac.r_constraint_name
      JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name
      WHERE ac.owner = :1 AND ac.table_name = :2 AND ac.constraint_type = 'R'
      ORDER BY ac.constraint_name, rcc.position`,
    indexes: `SELECT i.index_name, i.uniqueness, ic.column_name
      FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
      WHERE i.table_owner = :1 AND i.table_name = :2 ORDER BY i.index_name, ic.column_position`,
  }),
}

const dialects = { postgres: pgDialect, oracle: oracleDialect }
module.exports = { dialects, Pool, errMessage, pgError, oraError, oraCell, loadPg, loadOra, pgConfig, pgSslAttempts, PG_TYPES }
