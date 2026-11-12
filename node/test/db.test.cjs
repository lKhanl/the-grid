// Ports of the Go tests of internal/db (store, dsn / tnsnames, sqltext, format, dialects, the UI session, AI access) against the Node modules.
// Run: node --test node/test/      (no database needed: the manager tests use a fake driver that logs what reaches the "database")
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const T = require('../src/sqltext.cjs')
const { formatCell, formatTime, pgTimestamptz } = require('../src/dbformat.cjs')
const { openStore, normalize, where, parseTNSNames, lookupTNS } = require('../src/dbstore.cjs')
const { Manager, likePattern, typeName } = require('../src/dbmanager.cjs')
const { Pool, oraCell, pgConfig, pgSslAttempts } = require('../src/dbdrivers.cjs')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'griddb-'))
const ora = (o = {}) => ({ name: 'dev', host: 'h', service: 's', user: 'u', ...o })

// ---- store ----
test('store: passwords and names', () => {
  const dir = tmp(), s = openStore(dir)
  const c = s.put('', ora({ password: 'secret' }))
  assert.equal(c.port, 1521); assert.equal(c.mcp, 'readonly'); assert.equal(c.kind, 'oracle')
  assert.throws(() => s.put('', ora({ name: 'DEV' })), /already exists/)
  s.put('dev', ora({ name: 'dev2', host: 'h2' })) // an empty password keeps the stored one; a rename is allowed
  const got = s.get('DEV2'); assert.equal(got.password, 'secret'); assert.equal(got.host, 'h2')
  assert.equal(s.get('dev'), undefined)
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'connections.json')).mode & 0o777, 0o600)
  assert.equal(openStore(dir).list().length, 1)
  s.del('dev2'); assert.equal(s.list().length, 0)
  for (const bad of [{ name: '' }, { host: '' }, { mode: 'sid' }, { mode: 'tns' }, { user: '' }, { mcp: 'sometimes' }, { kind: 'mysql' }]) assert.throws(() => s.put('', ora(bad)), undefined, JSON.stringify(bad))
})
test('store: reload sees outside edits, a broken file changes nothing, unknown fields survive', () => {
  const dir = tmp(), s = openStore(dir)
  for (const n of ['dev', 'test']) s.put('', ora({ name: n }))
  const other = openStore(dir)
  other.put('dev', ora({ name: 'dev', host: 'h2' })); other.del('test'); other.put('', ora({ name: 'qa' }))
  assert.deepEqual(s.reload(), { added: ['qa'], removed: ['test'], changed: ['dev'] })
  assert.equal(s.get('dev').host, 'h2')
  const f = path.join(dir, 'connections.json'), d = JSON.parse(fs.readFileSync(f)); d.future = 1; d.connections[0].extra = { a: 1 }; fs.writeFileSync(f, JSON.stringify(d))
  s.reload(); s.put('qa', ora({ name: 'qa', host: 'q' }))
  const again = JSON.parse(fs.readFileSync(f)); assert.equal(again.future, 1); assert.deepEqual(again.connections[0].extra, { a: 1 })
  fs.writeFileSync(f, '{oops')
  assert.throws(() => s.reload()); assert.equal(s.list().length, 2)
})
test('store: order and groups', () => {
  const s = openStore(tmp()); for (const n of ['a', 'b', 'c']) s.put('', ora({ name: n }))
  s.order(['c', 'a'], { c: 'g1', a: 'g1' })
  assert.deepEqual(s.list().map(c => c.name + '/' + c.group), ['c/g1', 'a/g1', 'b/'])
})
test('views never carry passwords', async () => {
  const { m } = fake({ password: 'secret' }); const v = m.views()
  assert.equal(v.length, 1); assert.equal(v[0].password, undefined); assert.equal(v[0].hasPassword, true)
})
test('postgres normalize / where / ssl modes', () => {
  const c = normalize({ name: 'pg', kind: 'postgres', host: 'h', database: 'app', user: 'u', mode: 'tns', service: 'stale' })
  assert.equal(c.port, 5432); assert.equal(c.sslMode, 'prefer'); assert.equal(c.mode, ''); assert.equal(c.service, ''); assert.equal(where(c), 'h:5432/app')
  assert.throws(() => normalize({ name: 'x', kind: 'postgres', host: 'h', user: 'u' }))
  assert.throws(() => normalize({ name: 'x', kind: 'postgres', host: 'h', database: 'd', user: 'u', sslMode: 'maybe' }))
  assert.deepEqual(pgSslAttempts('disable'), [false]); assert.equal(pgSslAttempts('prefer')[1], false)
  const cfg = pgConfig({ host: 'h', port: 5433, database: 'app', user: 'u', password: `it's a \\ pass word=1` }, false) // no quoting needed: values are passed as they are
  assert.equal(cfg.password, `it's a \\ pass word=1`); assert.equal(cfg.port, 5433)
})

// ---- tnsnames.ora ----
test('tnsnames: parsing, aliases, descriptors', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'tnsnames.ora'), `
# a comment
PROD, PROD_ALIAS =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = prod.example)(PORT = 1521))   # trailing comment
    (CONNECT_DATA = (SERVICE_NAME = prod.example))
  )

TEST=(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=test)(PORT=1521))(CONNECT_DATA=(SID=T1)))
ORCL.WORLD=(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=w)(PORT=1)))
IFILE=more.ora
`)
  fs.writeFileSync(path.join(dir, 'more.ora'), 'EXTRA=(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=x)(PORT=2)))')
  const all = parseTNSNames(fs.readFileSync(path.join(dir, 'tnsnames.ora'), 'utf8'), dir)
  assert.equal(all.size, 5); assert.match(all.get('PROD_ALIAS'), /HOST=prod\.example/); assert.match(all.get('TEST'), /SID=T1/); assert.ok(all.has('EXTRA'))
  assert.ok(!/comment| /.test(all.get('PROD')), 'the descriptor must be clean')
  assert.match(lookupTNS('prod', dir), /prod\.example/) // case-insensitive
  assert.match(lookupTNS('orcl', path.join(dir, 'tnsnames.ora')), /HOST=w/) // a file works too, and a default domain is optional
  assert.throws(() => lookupTNS('nope', dir), /not found/)
})

// ---- SQL text ----
test('sqltext: isQuery / prepare', () => {
  for (const [sql, want] of Object.entries({ 'select 1 from dual': true, '  SELECT * FROM t': true, '-- hi\nselect 1': true, '/* c */ WITH a AS (SELECT 1 FROM dual) SELECT * FROM a': true,
    '(select 1 from dual)': true, 'update t set a=1': false, 'insert into t values (1)': false, 'BEGIN null; END;': false, '': false })) assert.equal(T.isQuery(sql), want, sql)
  for (const [i, want] of Object.entries({ 'select 1 from dual;': 'select 1 from dual', 'select 1 from dual ;\n': 'select 1 from dual', "select 'a;' from dual;": "select 'a;' from dual",
    'BEGIN\n  null;\nEND;': 'BEGIN\n  null;\nEND;', 'update t set a=1;;': 'update t set a=1' })) assert.equal(T.prepare(i), want, i)
})
test('sqltext: read-only check (Oracle)', () => {
  for (const s of ['SELECT * FROM t;', "select ';' from dual", '/* x; y */ select 1 from dual', '-- a; b\nselect 1 from dual', 'WITH a AS (SELECT 1 FROM dual) SELECT * FROM a', "select 'for update' from dual", 'select "FOR UPDATE" from t']) assert.doesNotThrow(() => T.checkReadOnly(s), s)
  for (const s of ['DELETE FROM t', 'update t set a = 1', 'select 1 from dual; delete from t', 'SELECT * FROM t FOR UPDATE', 'select * from t for  update nowait', 'BEGIN dbms_output.put_line(1); END;',
    'drop table t', 'truncate table t', '', '   ;', 'CALL p()', 'merge into t using x on (1=1) when matched then update set a=1']) assert.throws(() => T.checkReadOnly(s), undefined, s)
})
test('sqltext: typed COMMIT / ROLLBACK, DDL', () => {
  assert.equal(T.txControl('commit;'), 'COMMIT'); assert.equal(T.txControl('  Rollback work '), 'ROLLBACK'); assert.equal(T.txControl('rollback to savepoint s1'), ''); assert.equal(T.txControl('select 1'), '')
  assert.ok(T.isDDL('create table x (a number)')); assert.ok(!T.isDDL('update t set a=1'))
})
test('sqltext: PostgreSQL masking', () => {
  const input = `select $$a;b$$, $fn$ x; 'y' $fn$, 'c;d', E'it\\'s;', "q;" /* a /* nested; */ still; */ from t where id = $1 -- e;`
  const m = T.maskPG(input)
  assert.equal(m.length, input.length); assert.ok(!m.includes(';')); assert.ok(m.includes('$1')); assert.ok(m.includes('from t where id'))
  assert.ok(T.maskPG('select v$x from t; delete from u').includes('delete'), 'an identifier with $ is not a dollar quote')
})
test('sqltext: PostgreSQL statement kinds', () => {
  const d = T.pg
  for (const [sql, want] of Object.entries({
    'select 1': [true, true], 'WITH a AS (SELECT 1) SELECT * FROM a': [true, true], 'with d as (delete from t returning *) select * from d': [true, false], 'select * into t2 from t': [true, false],
    'values (1), (2)': [true, true], 'show search_path': [true, true], 'explain select 1': [true, true], 'explain analyze delete from t': [true, false],
    'insert into t values (1) returning id': [true, false], "insert into t values ('returning')": [false, false], 'update t set a = 1': [false, false], 'do $$ begin perform 1; end $$': [false, false],
  })) assert.deepEqual([d.returnsRows(sql), d.isRead(sql)], want, sql)
  for (const [sql, want] of Object.entries({ commit: 'COMMIT', 'END;': 'COMMIT', 'commit work': 'COMMIT', abort: 'ROLLBACK', 'rollback transaction': 'ROLLBACK', begin: 'BEGIN', 'BEGIN;': 'BEGIN',
    'start transaction': 'BEGIN', 'begin isolation level serializable': 'BEGIN ISOLATION LEVEL SERIALIZABLE', 'rollback to savepoint a': '', 'commit and chain': '', 'select 1': '', start: '' })) assert.equal(d.txControl(sql), want, sql)
  for (const [sql, want] of Object.entries({ 'vacuum t': true, VACUUM: true, 'create database x': true, 'create index concurrently i on t (a)': true, "alter system set work_mem = '64MB'": true, 'create index i on t (a)': false, 'alter table t add b int': false })) assert.equal(d.noTx(sql), want, sql)
  assert.equal(d.prepare('select 1;; \n'), 'select 1')
})
test('sqltext: PostgreSQL read-only check', () => {
  const d = T.pg
  for (const s of ["select ';' from t", 'select $$;$$', 'show all', 'explain select * from t', 'values (1)', "select 'for update'"]) assert.doesNotThrow(() => d.checkReadOnly(s), s)
  for (const s of ['delete from t', 'select 1; delete from t', 'select * from t for update', 'select * from t for share', 'select * from t for no key update', 'with d as (delete from t returning *) select * from d',
    'select * into t2 from t', 'explain analyze delete from t', 'do $$ begin delete from t; end $$', 'begin', 'call p()', '']) assert.throws(() => d.checkReadOnly(s), undefined, s)
  assert.doesNotThrow(() => d.checkSingle('create function f() returns int as $$ select 1; $$ language sql'))
  assert.throws(() => d.checkSingle('update t set a = 1; delete from t'))
})

// ---- cell text ----
test('format: cells', () => {
  const ts = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
  for (const [v, typ, want] of [[null, '', null], [9007199254740993n, 'NUMBER', '9007199254740993'], [1234.5, 'NUMBER', '1234.5'], [1e21, 'NUMBER', '1000000000000000000000'], [1e-7, '', '0.0000001'], [-1.5e-10, '', '-0.00000000015'],
    ['x', 'VARCHAR2', 'x'], [ts, 'DATE', '2026-01-02 03:04:05'], [ts, 'TIMESTAMP WITH TIME ZONE', '2026-01-02 03:04:05 +00:00'], [Buffer.from([1, 2, 255]), 'RAW', '0x0102FF'], [true, '', 'true'],
    [Buffer.alloc(20, 0xab), 'BLOB', '0x' + 'AB'.repeat(16) + '... (20 bytes)'], [NaN, '', 'NaN'], [new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 120)), 'TIMESTAMP', '2026-01-02 03:04:05.12']]) assert.equal(formatCell(v, typ), want, String(v))
  assert.equal(formatTime(ts, 'TIMESTAMP'), '2026-01-02 03:04:05')
})
test('postgres timestamptz is shown in this machine\'s zone, like Go', () => {
  const lo = new Date(2026, 0, 2, 3, 4, 5), off = -lo.getTimezoneOffset(), sign = off < 0 ? '-' : '+', hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0'), mm = String(Math.abs(off) % 60).padStart(2, '0')
  assert.equal(pgTimestamptz('2026-01-02 03:04:05.123456+00').slice(-6), ` ${sign}${hh}:${mm}`.slice(-6)) // winter time here
  assert.equal(pgTimestamptz('2026-01-02 03:04:05.5+05:30').includes('.5 '), true)
  assert.equal(pgTimestamptz('infinity'), 'infinity'); assert.equal(pgTimestamptz('0044-03-15 10:00:00+00 BC'), '0044-03-15 10:00:00+00 BC')
  const utc = process.env.TZ === 'UTC' || off === 0
  if (utc) assert.equal(pgTimestamptz('2026-01-02 03:04:05-03'), '2026-01-02 06:04:05 +00:00')
})
test('oracle cells: text numbers, local wall clock, intervals', () => {
  assert.equal(oraCell('.5', 'NUMBER'), '0.5'); assert.equal(oraCell('-.25', 'NUMBER'), '-0.25'); assert.equal(oraCell('12345678901234567890123456789', 'NUMBER'), '12345678901234567890123456789')
  assert.equal(oraCell(new Date(2026, 0, 2, 3, 4, 5), 'DATE'), '2026-01-02 03:04:05'); assert.equal(oraCell(new Date(2026, 0, 2, 3, 4, 5, 500), 'TIMESTAMP'), '2026-01-02 03:04:05.5')
  assert.equal(oraCell({ days: 1, hours: 2, minutes: 3, seconds: 4, fseconds: 500000000 }, 'INTERVAL DAY TO SECOND'), '+01 02:03:04.500000'); assert.equal(oraCell(1.100000023841858, 'BINARY_FLOAT'), '1.1')
  assert.equal(likePattern(' *ab*c '), '%AB%C'); assert.equal(likePattern(''), '%'); assert.equal(likePattern('emp'), '%EMP%'); assert.equal(typeName('NUMBER', null, 10, 2), 'NUMBER(10,2)'); assert.equal(typeName('VARCHAR2', 40), 'VARCHAR2(40)')
})

// ---- the UI session and AI access, against a fake driver ----
function fake(connOverrides = {}, kind = 'oracle') {
  const f = { log: [], block: null, stuck: false, execErr: null, rows: [['1', 'a'], ['2', null], ['3', 'c']] }
  class Raw {
    constructor() { this.dead = false }
    async hold() { if (f.block) { if (f.stuck) await f.block; else await Promise.race([f.block, new Promise((_, no) => { this.abort = () => no(new Error('cancelled')) })]) } }
    async query(sql, { maxRows, offset = 0 }) {
      f.log.push('Q: ' + sql); await this.hold()
      const r = f.rows.slice(offset), truncated = r.length > maxRows
      return { columns: [{ name: 'ID', type: 'NUMBER' }, { name: 'V', type: 'VARCHAR2' }], rows: r.slice(0, maxRows), truncated }
    }
    async exec(sql) { f.log.push('X: ' + sql); if (f.execErr) { const e = f.execErr(sql); if (e) throw e } await this.hold(); return { rowsAffected: 3 } }
    async select() { return [] }
    async begin() { f.log.push('BEGIN') } async commit() { f.log.push('COMMIT') } async rollback() { f.log.push('ROLLBACK') } async reset() {}
    async cancel() { if (this.abort) this.abort() }
    release(bad) { this.pool.release(this, bad) } destroy() { this.dead = true }
    error(e) { return e } broken() { return false }
  }
  const text = kind === 'oracle' ? T.oracle : T.pg
  const dialect = { kind, load() {}, error: e => e, text, foldName: n => n.toUpperCase(), openPool: async () => new Pool(async () => new Raw()), hello: async () => 'hi', connectOnce: async () => new Raw() }
  const store = openStore(tmp())
  store.put('', kind === 'oracle' ? ora({ name: 't', ...connOverrides }) : { name: 't', kind, host: 'h', database: 'app', user: 'u', ...connOverrides })
  const m = new Manager(store, { dialects: { [kind]: dialect }, aiTimeoutMs: 80 })
  return { m, f, store }
}
const run = (m, sql, max = 10, off = 0, sec = 1) => m.run('t', sql, max, off, sec)
const log = f => f.log.join('|')

test('run: truncation, NULL stays NULL', async () => {
  const { m } = fake()
  let r = await run(m, 'select * from t;', 2); assert.equal(r.kind, 'rows'); assert.equal(r.rows.length, 2); assert.equal(r.truncated, true); assert.equal(r.columns[0].name, 'ID')
  r = await run(m, 'select * from t', 10); assert.ok(!r.truncated); assert.equal(r.rows.length, 3); assert.equal(r.rows[1][1], null)
})
test('run: auto-commit off needs commit', async () => {
  const { m, f } = fake({ autoCommit: false })
  assert.equal((await run(m, 'select 1 from dual')).inTx, false) // a plain query starts no transaction
  const r = await run(m, 'update t set a = 1'); assert.equal(r.kind, 'update'); assert.equal(r.rowsAffected, 3); assert.equal(r.inTx, true)
  assert.deepEqual([m.views()[0].inTx, m.views()[0].connected], [true, true])
  await m.commit('t'); assert.match(log(f), /BEGIN\|X: update t set a = 1\|COMMIT/)
  await run(m, 'delete from t'); await m.rollback('t'); assert.ok(log(f).endsWith('X: delete from t|ROLLBACK'))
  assert.equal(m.views()[0].inTx, false)
})
test('run: auto-commit on runs directly', async () => {
  const { m, f } = fake({ autoCommit: true }); const r = await run(m, 'update t set a = 1'); assert.equal(r.inTx, false); assert.ok(!f.log.includes('BEGIN'))
})
test('run: busy, cancel, timeout', async () => {
  const { m, f } = fake(); let release; f.block = new Promise(ok => { release = ok })
  const p = run(m, 'select slow from dual', 10, 0, 60); await new Promise(r => setTimeout(r, 20))
  await assert.rejects(run(m, 'select 2 from dual'), e => e.busy)
  m.cancel('t'); await assert.rejects(p, /stopped/)
  f.block = null; assert.equal((await run(m, 'select 3 from dual')).rows.length, 3) // the session works again afterwards
  f.block = new Promise(() => {}); await assert.rejects(run(m, 'select slow from dual', 10, 0, 0.05).catch(e => { throw e }), /stopped after .*s \(timeout\)/)
  release && release()
})
test('run: stop answers at once even if the driver cannot interrupt, and the transaction is lost', async () => {
  const { m, f } = fake({ autoCommit: false }); await run(m, 'update t set a = 1')
  f.block = new Promise(() => {}); f.stuck = true
  const p = run(m, 'select slow from dual', 10, 0, 60); await new Promise(r => setTimeout(r, 20))
  const t0 = Date.now(); m.cancel('t')
  await assert.rejects(p, e => /stopped/.test(e.message) && /rolled back/.test(e.message)); assert.ok(Date.now() - t0 < 1000)
  f.block = null; f.stuck = false
  const r = await run(m, 'select 1 from dual'); assert.equal(r.inTx, false)
})
test('run: typed COMMIT / ROLLBACK and DDL end the transaction (Oracle)', async () => {
  const { m, f } = fake({ autoCommit: false }), go = async s => { const r = await run(m, s); return r }
  assert.ok((await go('update t set a = 1')).inTx)
  let r = await go('commit;'); assert.equal(r.inTx, false); assert.equal(r.kind, 'update')
  await go('update t set a = 2'); assert.equal((await go('  Rollback work ')).inTx, false)
  await go('update t set a = 3'); assert.equal((await go('create table x (a number)')).inTx, false)
  for (const want of ['X: update t set a = 1|COMMIT', 'X: update t set a = 2|ROLLBACK', 'X: create table x (a number)|COMMIT']) assert.ok(log(f).includes(want), want)
  await go('update t set a = 4'); assert.ok((await go('rollback to savepoint s1')).inTx) // an ordinary statement
  await m.rollback('t'); assert.equal((await go('commit')).inTx, false)
})
test('run: paging', async () => {
  const { m } = fake(); const first = await run(m, 'select * from t;', 1, 0), next = await run(m, 'select * from t;', 1, 1)
  assert.equal(next.offset, 1); assert.equal(next.rows.length, 1); assert.notEqual(next.rows[0][0], first.rows[0][0])
  const past = await run(m, 'select * from t;', 5, 1000); assert.equal(past.rows.length, 0); assert.ok(!past.truncated)
})
test('forget rolls back', async () => {
  const { m, f } = fake({ autoCommit: false }); await run(m, 'update t set a = 1'); await m.forget('t')
  assert.ok(log(f).endsWith('ROLLBACK')); assert.equal(m.views()[0].connected, false)
})
test('postgres: statement savepoints, typed BEGIN, no-tx statements', async () => {
  const { m, f } = fake({}, 'postgres'); f.execErr = q => (q.includes('bad') ? new Error('column "bad" does not exist') : null)
  assert.ok((await run(m, 'update t set a = 1')).inTx)
  await assert.rejects(run(m, 'update t set bad = 1'), /does not exist/)
  assert.ok((await run(m, 'create table x (a int)')).inTx) // Postgres DDL is transactional
  assert.ok((await run(m, 'savepoint mine')).inTx)
  await m.commit('t')
  assert.equal(log(f), 'BEGIN|X: SAVEPOINT grid_stmt|X: update t set a = 1|X: RELEASE SAVEPOINT grid_stmt|X: SAVEPOINT grid_stmt|X: update t set bad = 1|X: ROLLBACK TO SAVEPOINT grid_stmt|' +
    'X: SAVEPOINT grid_stmt|X: create table x (a int)|X: RELEASE SAVEPOINT grid_stmt|X: savepoint mine|COMMIT')
  const a = fake({ autoCommit: true }, 'postgres')
  assert.ok((await run(a.m, 'begin isolation level serializable;')).inTx); await run(a.m, 'update t set a = 1'); assert.equal((await run(a.m, 'end')).inTx, false)
  assert.ok(log(a.f).startsWith('BEGIN|X: SET TRANSACTION ISOLATION LEVEL SERIALIZABLE|X: SAVEPOINT grid_stmt|X: update t set a = 1|') && log(a.f).endsWith('COMMIT'))
  const b = fake({}, 'postgres'); const r = await run(b.m, 'vacuum analyze t'); assert.equal(r.inTx, false); assert.equal(log(b.f), 'X: vacuum analyze t')
})
test('AI: read-only connections get a READ ONLY transaction and SELECT / WITH only', async () => {
  const { m, f } = fake({ mcp: 'readonly' })
  assert.equal((await m.aiQuery('t', 'select * from t', 10, false)).rows.length, 3)
  assert.ok(log(f).startsWith('BEGIN|X: SET TRANSACTION READ ONLY|Q: select * from t|ROLLBACK'), log(f))
  const before = f.log.length
  for (const sql of ['delete from t', 'select 1 from dual; delete from t', 'select * from t for update', 'begin null; end;']) await assert.rejects(m.aiQuery('t', sql, 10, false), undefined, sql)
  assert.deepEqual(f.log.slice(before).filter(e => e.startsWith('Q:') || (e.startsWith('X:') && !e.includes('READ ONLY'))), []) // refused statements never reach the database
  await assert.rejects(m.aiQuery('t', 'update t set a=1', 10, true), /read-only/)
})
test('AI: off and read-write', async () => {
  const { m, f, store } = fake({ mcp: 'off' })
  await assert.rejects(m.aiQuery('t', 'select 1 from dual', 10, false), /not shared/)
  store.put('t', { ...store.get('t'), mcp: 'readwrite' }) // the level is re-read on every call: no reconnect
  const r = await m.aiQuery('t', 'update t set a = 1', 10, true); assert.equal(r.rowsAffected, 3)
  assert.match(log(f), /BEGIN\|X: update t set a = 1\|COMMIT$/)
  await assert.rejects(m.aiQuery('t', 'update a set x=1; delete from b', 10, true), /one statement/)
})
test('AI: the timeout answers even if the driver cannot interrupt', async () => {
  const { m, f } = fake({ mcp: 'readonly' }); f.block = new Promise(() => {}); f.stuck = true
  const t0 = Date.now(); await assert.rejects(m.aiQuery('t', 'select slow from dual', 10, false), /timeout/); assert.ok(Date.now() - t0 < 1000)
})
test('postgres AI: data-modifying CTE is not read-only', async () => {
  const { m, f } = fake({ mcp: 'readonly' }, 'postgres')
  await m.aiQuery('t', 'select * from t;', 10, false)
  await assert.rejects(m.aiQuery('t', 'with d as (delete from t returning *) select * from d', 10, false))
  assert.equal(log(f), 'BEGIN|X: SET TRANSACTION READ ONLY|Q: select * from t|ROLLBACK')
})
