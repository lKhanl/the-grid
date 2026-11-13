// Tests of the MCP config tools (service_* / runtime_*): edit.cjs's grid.yaml-key functions directly, then the tools against a real Grid.
// Run: node --test test/mcpconfig.test.cjs      (starts a Grid on a free port with a temporary grid.yaml)
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), { spawn } = require('child_process')
const E = require('../src/edit.cjs')
const { McpServer, TOOLS } = require('../src/mcp.cjs')

const YAML_TEXT = `name: test
# runtimes
runtimes:
  java17: { home: ./jdk }

services:
  # the api
  api:
    cwd: ./app
    command: node -e "setInterval(() => {}, 1000)"  # keep alive
    url: http://localhost:1

  worker:
    command: node -e "1"
    depends_on: [api]
`
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridmcpcfg-'))
  fs.mkdirSync(path.join(dir, 'app')); fs.mkdirSync(path.join(dir, 'jdk', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'jdk', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), '')
  const file = path.join(dir, 'grid.yaml'); fs.writeFileSync(file, YAML_TEXT)
  return file
}
const read = f => fs.readFileSync(f, 'utf8')

test('addServiceRaw: grid.yaml keys, checked, comments kept', () => {
  const f = workspace()
  assert.equal(E.addServiceRaw(f, 'orders', { type: 'spring-boot', cwd: './app', runtime: 'java17', spring: { profiles: ['local'] }, ready: { port: 8081 } }), true)
  const t = read(f)
  assert.match(t, /# the api/); assert.match(t, /# keep alive/)
  assert.deepEqual(E.readServiceRaw(f, 'orders'), { type: 'spring-boot', cwd: './app', spring: { profiles: ['local'] }, runtime: 'java17', ready: { port: 8081 } })
  assert.throws(() => E.addServiceRaw(f, 'orders', { command: 'x' }), /already exists/)
  assert.throws(() => E.addServiceRaw(f, 'b', { tpye: 'node' }), /unknown setting "tpye"/)
  assert.throws(() => E.addServiceRaw(f, 'b', { command: 'x', spring: { profile: 'a' } }), /unknown setting "spring.profile"/)
  assert.throws(() => E.addServiceRaw(f, 'b', { type: 'node' }), /node.script' is required/) // the loader's check: nothing written
  assert.throws(() => E.addServiceRaw(f, 'b', { command: 'x', runtime: 'nope' }), /unknown runtime "nope"/)
  assert.throws(() => E.addServiceRaw(f, 'b c', { command: 'x' }), /invalid name/)
  assert.throws(() => E.addServiceRaw(f, 'b', 'x'), /expected an object/)
  assert.equal(Object.keys(E.readSection(f, 'services')).join(), 'api,worker,orders')
})

test('editServiceRaw: merge, null removes, rename follows depends_on, no-op is reported', () => {
  const f = workspace()
  E.addServiceRaw(f, 'orders', { type: 'spring-boot', spring: { profiles: ['local'], args: '--x' }, env: { A: '1', B: '2' }, url: 'http://u' })
  assert.equal(E.editServiceRaw(f, 'orders', { spring: { jvm_args: '-Xmx1g', args: null }, env: { B: null, C: '3' }, url: null }), true)
  assert.deepEqual(E.readServiceRaw(f, 'orders'), { type: 'spring-boot', spring: { profiles: ['local'], jvm_args: '-Xmx1g' }, env: { A: '1', C: '3' } })
  assert.equal(E.editServiceRaw(f, 'orders', { env: { A: '1' } }), false)
  // the type changes: the old block goes
  E.editServiceRaw(f, 'orders', { type: 'node', node: { script: 'dev' } })
  assert.deepEqual(E.readServiceRaw(f, 'orders'), { type: 'node', node: { script: 'dev' }, env: { A: '1', C: '3' } })
  E.editServiceRaw(f, 'api', { description: 'main' }, 'core')
  assert.match(read(f), /depends_on: \[core\]/); assert.match(read(f), /# keep alive/)
  assert.throws(() => E.editServiceRaw(f, 'nope', {}), /not found/)
  assert.throws(() => E.editServiceRaw(f, 'core', { ready: {} }), /'ready' needs 'port' or 'log'|ready/)
})

test('runtimes: add, edit (rename keeps the type), remove with detach', () => {
  const f = workspace()
  E.addRuntimeRaw(f, 'node20', { home: '/n', env: { NODE_OPTIONS: '--max-old-space-size=4096' } })
  assert.deepEqual(E.readRuntimeRaw(f, 'node20'), { home: '/n', env: { NODE_OPTIONS: '--max-old-space-size=4096' } })
  assert.throws(() => E.addRuntimeRaw(f, 'x', { home: '/x', typ: 'java' }), /unknown setting "typ"/)
  assert.throws(() => E.addRuntimeRaw(f, 'x', {}), /home folder is required/)
  E.addServiceRaw(f, 'svc', { command: 'x', runtime: 'java17' })
  E.editRuntimeRaw(f, 'java17', {}, 'corretto') // the name no longer says java: the type is written
  assert.deepEqual(E.readRuntimeRaw(f, 'corretto'), { type: 'java', home: './jdk' })
  assert.equal(E.readServiceRaw(f, 'svc').runtime, 'corretto')
  assert.throws(() => E.deleteRuntime(f, 'corretto'), /used by svc/)
  E.deleteRuntime(f, 'corretto', true)
  assert.equal(E.readServiceRaw(f, 'svc').runtime, undefined)
  assert.match(read(f), /runtimes:\n  node20:/) // no blank line left above the new first entry
})

test('the tool list: names and required arguments', () => {
  const by = Object.fromEntries(TOOLS.map(t => [t.name, t]))
  for (const n of ['service_add', 'service_edit', 'service_remove', 'runtimes', 'runtime_add', 'runtime_edit', 'runtime_remove']) assert.ok(by[n], n)
  assert.deepEqual(by.service_add.inputSchema.required, ['name', 'config'])
  assert.deepEqual(by.service_edit.inputSchema.required, ['name'])
})

// ---- the tools against a running Grid ----
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })
async function startGrid(file) {
  const port = await freePort()
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'grid.cjs'), 'serve', '--no-browser', `--config=${file}`, '-p', String(port)], { env: { ...process.env, GRID_NO_UPDATE: '1' }, stdio: 'ignore' })
  const mcp = new McpServer({ port, version: 'test', poll: 50, grace: 200 })
  for (let i = 0; i < 100; i++) { try { await mcp.status(); return { p, mcp } } catch { await new Promise(r => setTimeout(r, 100)) } }
  p.kill(); throw new Error('the Grid did not start')
}
const call = async (mcp, name, args) => { const r = await mcp.handle({ method: 'tools/call', params: { name, arguments: args } }); return { text: r.result.content[0].text, err: r.result.isError } }

test('MCP tools against a running Grid', async t => {
  const f = workspace(), { p, mcp } = await startGrid(f)
  t.after(() => p.kill())
  let r = await call(mcp, 'service_add', { name: 'orders', config: { type: 'jar', jar: { file: 'app.jar' }, runtime: 'java17' } })
  assert.equal(r.err, false, r.text); assert.match(r.text, /orders added/); assert.match(r.text, /settings \(change them with service_edit\):\n  type: jar/)
  assert.match((await mcp.status()), /orders: stopped/) // applied without reload
  r = await call(mcp, 'service_add', { name: 'bad', config: '{"type": "node"}' }) // a JSON string is accepted as the object
  assert.equal(r.err, true); assert.match(r.text, /node.script' is required/)
  assert.doesNotMatch(read(f), /bad:/)

  r = await call(mcp, 'restart', { service: 'api', action: 'start', wait: 5 }); assert.match(r.text, /running/)
  r = await call(mcp, 'service_edit', { name: 'api', change: { url: 'http://localhost:2' } })
  assert.match(r.text, /running with the old settings; restart it/)
  r = await call(mcp, 'service_edit', { name: 'api', change: { url: 'http://localhost:2' } }); assert.match(r.text, /nothing changed/)
  r = await call(mcp, 'service_edit', { name: 'api', rename: 'x' }); assert.equal(r.err, true); assert.match(r.text, /stop api before renaming/)
  r = await call(mcp, 'service_remove', { name: 'api' }); assert.equal(r.err, true); assert.match(r.text, /stop it first/)
  await call(mcp, 'restart', { service: 'api', action: 'stop' })
  r = await call(mcp, 'service_remove', { name: 'api' }); assert.equal(r.err, true); assert.match(r.text, /"worker" depends on "api"/)
  r = await call(mcp, 'service_remove', { name: 'orders' }); assert.equal(r.err, false, r.text)
  assert.doesNotMatch(await mcp.status(), /orders/)

  r = await call(mcp, 'runtime_add', { name: 'node20', config: { home: '/does/not/exist' } }); assert.match(r.text, /PROBLEM: home .* not found/)
  r = await call(mcp, 'runtimes', {}); assert.match(r.text, /java17: java - ok\n  home: \.\/jdk/); assert.match(r.text, /node20: node - PROBLEM/)
  r = await call(mcp, 'runtime_edit', { name: 'node20', change: { home: './app' } }); assert.match(r.text, /node20 saved/)
  r = await call(mcp, 'runtime_remove', { name: 'node20' }); assert.equal(r.err, false, r.text)
  assert.match(read(f), /# the api/)
})
