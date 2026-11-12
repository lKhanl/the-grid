// Tests of update.cjs (the self-update): version compare, manifest validation, URLs, the dist address rules, the Install-now question,
// and an install against a local http server (loopback http is the only non-https address the updater accepts).
// Run: node --test test/update.test.cjs      (needs no network; GRID_HOME is a temporary folder)
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto')
const { PassThrough } = require('stream')
const U = require('../src/update.cjs')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gridupd-'))
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const H64 = 'a'.repeat(64)
const entry = (p, extra) => ({ path: p, sha256: H64, size: 1, ...extra })
const manifest = (files, extra) => ({ version: '0.13.0', tag: 'v0.13.0', files: files || [entry('grid.bundle.cjs')], ...extra })
const bad = (m, re) => assert.throws(() => U.validateManifest(m), re)

test('newer: the Go examples and the edge cases', () => {
  const t = [['0.12.10', '0.12.6', true], ['0.12.6', '0.12.10', false], ['v0.13.0', '0.12.99', true], ['0.13.0', '0.13.0', false],
    ['0.13.0-rc1', '0.13.0', false], ['0.13.1+build5', '0.13.0', true], ['0.13', '0.13.0', false], ['0.13.0.1', '0.13.0', true],
    ['1.0.0', '0.99.99', true], ['0.13.0 dirty', '0.13.0', false], ['v0.13.1', 'v0.13.0', true], ['0.0.2-nodepoc', '0.13.0', false],
    ['x.y', '0.1', false], ['0.13.0', '0.13.0-nodepoc', false], ['10.0.0', '9.9.9', true]]
  for (const [a, b, want] of t) assert.equal(U.newer(a, b), want, `${a} vs ${b}`)
})

test('validateManifest: a good manifest', () => {
  const m = U.validateManifest(manifest([entry('grid.bundle.cjs', { sha256: 'A'.repeat(64) }), entry('node_modules/node-pty/lib/index.js'), entry('drivers/pg.cjs')], { version: '' }))
  assert.equal(m.version, '0.13.0') // from the tag, without the v
  assert.equal(m.files[0].sha256, 'a'.repeat(64)) // lower-cased
  assert.equal(m.files.length, 3); assert.equal(m.total, 3)
  assert.equal(U.validateManifest(manifest(null, { tag: 'release/v0.13.0' })).tag, 'release/v0.13.0')
})

test('validateManifest: tag, version, files', () => {
  for (const tag of ['', 'v1 x', 'v1?x', 'v1#', 'v1;rm', 'v1\\x', 'ü', undefined]) bad(manifest(null, { tag }), /invalid "tag"/)
  bad(manifest(null, { version: '../x' }), /invalid "version"/)
  bad(manifest(null, { version: 'a'.repeat(65) }), /invalid "version"/)
  bad(null, /unexpected format/); bad([], /unexpected format/); bad('x', /unexpected format/)
  bad(manifest([]), /non-empty/); bad(manifest(null, { files: 'x' }), /non-empty/)
  bad(manifest(Array.from({ length: 501 }, (_, i) => entry('f' + i)).concat(entry('grid.bundle.cjs'))), /too many files/)
  bad(manifest([entry('a.js')]), /grid\.bundle\.cjs/)
})

test('validateManifest: paths that must never reach the disk or a URL', () => {
  for (const p of ['../x', 'a/../x', '..', '.', './a', 'a/./b', '/abs', '/etc/passwd', 'C:x', 'C:/x', 'a\\b', '\\a', 'a//b', 'a/', '', 'a b', 'a?b', 'a#b', 'a%2e', 'é.js', 'nul', 'NUL.txt', 'a/com1.js', 'a.', 'x/y.', '~/a', 'a:b']) {
    bad(manifest([entry('grid.bundle.cjs'), entry(p)]), /invalid (file )?"?path/)
  }
  bad(manifest([entry('grid.bundle.cjs'), 5]), /invalid file entry/)
  bad(manifest([entry('grid.bundle.cjs'), entry(undefined)]), /invalid file/)
  bad(manifest([entry('grid.bundle.cjs'), entry('grid.bundle.cjs')]), /duplicate/)
  bad(manifest([entry('grid.bundle.cjs'), entry('GRID.bundle.cjs')]), /duplicate/) // Windows is case-insensitive
  bad(manifest([entry('grid.bundle.cjs'), entry('a'), entry('a/b')]), /both a file and a folder/)
})

test('validateManifest: sha256 and size', () => {
  for (const s of ['a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), '', undefined, 5]) bad(manifest([entry('grid.bundle.cjs', { sha256: s })]), /sha256/)
  for (const size of [-1, 1.5, '1', null, undefined, 64 * 1048576 + 1]) bad(manifest([entry('grid.bundle.cjs', { size })]), /invalid size/)
  const big = Array.from({ length: 5 }, (_, i) => entry('f' + i, { size: 60 * 1048576 }))
  bad(manifest([entry('grid.bundle.cjs'), ...big]), /total size/)
})

test('rawUrl: every segment encoded on its own, the ref encoded', () => {
  assert.equal(U.rawUrl('https://h/raw', 'manifest.json', 'refs/heads/master'), 'https://h/raw/manifest.json?at=refs%2Fheads%2Fmaster')
  assert.equal(U.rawUrl('https://h/raw/', 'node_modules/node-pty/lib/index.js', 'refs/tags/v0.13.0'), 'https://h/raw/node_modules/node-pty/lib/index.js?at=refs%2Ftags%2Fv0.13.0')
  assert.equal(U.rawUrl('https://h/raw', 'a b/c#d/e?f.js', 'refs/tags/v1'), 'https://h/raw/a%20b/c%23d/e%3Ff.js?at=refs%2Ftags%2Fv1')
})

test('distBase: https, or http for loopback only; the env var wins; nothing = off', () => {
  const keep = process.env.GRID_DIST_URL
  try {
    delete process.env.GRID_DIST_URL
    assert.equal(U.distBase(null), null); assert.equal(U.distBase({ base: '' }), null)
    assert.equal(U.distBase({ base: 'https://h.example/raw/' }), 'https://h.example/raw')
    for (const b of ['http://h.example/raw', 'http://127.0.0.1.evil.com/x', 'ftp://h/x', 'not a url', 'file:///etc', 'https://u:p@h/x']) assert.equal(U.distBase({ base: b }), null, b)
    for (const b of ['http://127.0.0.1:1/x', 'http://localhost:2/x', 'http://[::1]:3/x']) assert.equal(U.distBase({ base: b }), b)
    process.env.GRID_DIST_URL = 'https://env.example/r'
    assert.equal(U.distBase({ base: 'https://h.example/raw' }), 'https://env.example/r')
    process.env.GRID_DIST_URL = 'http://env.example/r' // an invalid override does not fall back to the file: updates are off
    assert.equal(U.distBase({ base: 'https://h.example/raw' }), null)
  } finally { if (keep === undefined) delete process.env.GRID_DIST_URL; else process.env.GRID_DIST_URL = keep }
})

function withHome(fn) {
  return async () => {
    const home = tmp(), keep = process.env.GRID_HOME
    process.env.GRID_HOME = home
    try { await fn(home) } finally { if (keep === undefined) delete process.env.GRID_HOME; else process.env.GRID_HOME = keep }
  }
}

test('readInfo / installed', withHome(home => {
  const n = path.join(home, 'node'); fs.mkdirSync(path.join(n, '0.13.0'), { recursive: true })
  assert.equal(U.readInfo(), null)
  fs.writeFileSync(path.join(n, 'install.json'), '{broken'); assert.equal(U.readInfo(), null)
  for (const dir of ['../x', 'a/b', '.', '..', '', '.hidden', 5, undefined]) { fs.writeFileSync(path.join(n, 'install.json'), JSON.stringify({ base: 'https://h/x', dir })); assert.equal(U.readInfo(), null, String(dir)) }
  fs.writeFileSync(path.join(n, 'install.json'), JSON.stringify({ base: 'https://h/x', dir: '0.13.0', version: '0.13.0', wrapper: '../evil.cmd' }))
  const info = U.readInfo(); assert.equal(info.dir, '0.13.0'); assert.equal(info.wrapper, 'grid.cmd') // an odd wrapper name falls back
  const bundle = path.join(n, '0.13.0', 'grid.bundle.cjs'); fs.writeFileSync(bundle, '')
  assert.equal(U.installed(info, bundle), true)
  assert.equal(U.installed(info, path.join(home, 'elsewhere.cjs')), false) // a copy run from the repo
  assert.equal(U.installed(null, bundle), false)
  fs.mkdirSync(path.join(n, 'other')); fs.writeFileSync(path.join(n, 'other', 'grid.bundle.cjs'), '')
  assert.equal(U.installed(info, path.join(n, 'other', 'grid.bundle.cjs')), false) // an old folder is not the active one
  if (process.platform !== 'win32') { // symlinks are resolved
    const ln = path.join(home, 'link.cjs'); fs.symlinkSync(bundle, ln); assert.equal(U.installed(info, ln), true)
  }
}))

test('askInstall: Enter, y, yes, e, evet = yes; anything else = no; end of input = null', async () => {
  const ask = async text => {
    const input = new PassThrough(), output = new PassThrough(); let out = ''; output.on('data', d => out += d)
    const p = U.askInstall(input, output)
    if (text === undefined) input.end(); else input.write(text + '\n')
    const r = await p
    assert.match(out, /Install it now\? \[Y\/n\] /)
    return r
  }
  for (const a of ['', 'y', 'Y', 'yes', 'YES', 'e', 'E', 'evet', 'Evet', '  y  ']) assert.equal(await ask(a), true, JSON.stringify(a))
  for (const a of ['n', 'N', 'no', 'hayir', 'x', 'yy', 'ye']) assert.equal(await ask(a), false, JSON.stringify(a))
  assert.equal(await ask(undefined), null)
})

// ---- install against a local server ----
function serve(files, opts = {}) { // files: { 'a/b.js': Buffer }
  const seen = []
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); seen.push(req.url)
    const want = 'Basic ' + Buffer.from('u:t').toString('base64')
    if (req.headers.authorization !== want) { res.writeHead(401); return res.end() }
    const f = decodeURIComponent(u.pathname.slice('/raw/'.length))
    if (f === 'manifest.json') return res.end(JSON.stringify(opts.manifest || {}))
    if (!(f in files)) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(opts.tamper === f ? Buffer.from('p!') : files[f])
  })
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({ srv, seen, base: `http://127.0.0.1:${srv.address().port}/raw` })))
}
const stop = s => { s.srv.closeAllConnections(); s.srv.close() }
const mk = files => ({ version: '0.14.0', tag: 'v0.14.0', files: Object.entries(files).map(([p, b]) => ({ path: p, sha256: sha(b), size: b.length })) })

test('install: verified, then activated; a mismatch leaves nothing behind', withHome(async home => {
  const files = { 'grid.bundle.cjs': Buffer.from('console.log(1)'), 'drivers/pg.cjs': Buffer.from('pg'), 'node_modules/p/lib/i.js': Buffer.from('x'.repeat(100000)) }
  const man = mk(files), creds = { user: 'u', token: 't' }
  const s = await serve(files)
  try {
    const m = U.validateManifest(man)
    const dir = await U.install(m, s.base, creds, null)
    assert.equal(dir, '0.14.0')
    const n = path.join(home, 'node')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(n, 'install.json'), 'utf8')), { base: s.base, dir: '0.14.0', version: '0.14.0', wrapper: 'grid.cmd' })
    assert.equal(fs.readFileSync(path.join(n, '0.14.0', 'node_modules/p/lib/i.js')).length, 100000)
    const wrapper = fs.readFileSync(path.join(home, 'app', 'grid.cmd'), 'utf8')
    assert.equal(wrapper, `@echo off\r\nnode "${path.join(n, '0.14.0', 'grid.bundle.cjs')}" %*\r\n`)
    assert.ok(s.seen.every(u => u.includes('?at=refs%2Ftags%2Fv0.14.0')))

    // a forced reinstall of the same version gets a suffix; the active folder is never touched
    const info = U.readInfo()
    assert.equal(await U.install(m, s.base, creds, info), '0.14.0_2')
    assert.equal(U.readInfo().dir, '0.14.0_2')

    // one file does not match: nothing is activated, the temporary folder is gone, install.json is as before
    stop(s); const t = await serve(files, { tamper: 'drivers/pg.cjs' })
    const before = fs.readFileSync(path.join(n, 'install.json'), 'utf8')
    await assert.rejects(U.install(m, t.base, creds, U.readInfo()), /drivers\/pg\.cjs: SHA256 mismatch: expected .* got /)
    assert.equal(fs.readFileSync(path.join(n, 'install.json'), 'utf8'), before)
    assert.deepEqual(fs.readdirSync(n).sort(), ['0.14.0', '0.14.0_2', 'install.json'])
    // wrong credentials
    await assert.rejects(U.install(m, t.base, { user: 'u', token: 'bad' }, U.readInfo()), e => e.auth === true)
    assert.deepEqual(fs.readdirSync(n).sort(), ['0.14.0', '0.14.0_2', 'install.json'])
    // a 404
    await assert.rejects(U.install(U.validateManifest(mk({ 'a/missing.cjs': Buffer.from('m'), ...files })), t.base, creds, U.readInfo()), /a\/missing\.cjs: HTTP 404/)
    stop(t)

    // cleanup: old folders go, the active one, a running one and strangers stay
    fs.mkdirSync(path.join(n, '0.9.0')); fs.mkdirSync(path.join(n, 'stranger.dir.with space')); fs.mkdirSync(path.join(n, '.tmp-1-1')); fs.writeFileSync(path.join(n, 'file.txt'), '')
    fs.mkdirSync(path.join(n, '0.8.0')); fs.writeFileSync(path.join(n, '0.8.0', `.run-${process.pid}`), '') // this very process is "running" from it
    U.cleanOld(U.readInfo())
    assert.deepEqual(fs.readdirSync(n).sort(), ['.tmp-1-1', '0.14.0_2', '0.8.0', 'file.txt', 'install.json', 'stranger.dir.with space'])
    fs.utimesSync(path.join(n, '.tmp-1-1'), new Date(0), new Date(0)); U.cleanOld(U.readInfo()) // an old abandoned download goes
    assert.ok(!fs.existsSync(path.join(n, '.tmp-1-1')))
  } finally { stop(s) }
}))

test('fetchManifest: validated, size-limited, and bound by the time limit', withHome(async () => {
  const s = await serve({}, { manifest: manifest([entry('grid.bundle.cjs')]) })
  try {
    const m = await U.fetchManifest(s.base, { user: 'u', token: 't' }, 3000)
    assert.equal(m.version, '0.13.0')
    await assert.rejects(U.fetchManifest(s.base, { user: 'u', token: 'x' }, 3000), e => e.auth && /rejected the credentials/.test(e.message))
  } finally { stop(s) }
  const hang = http.createServer(() => {}); await new Promise(ok => hang.listen(0, '127.0.0.1', ok))
  const t0 = Date.now()
  try { await assert.rejects(U.fetchManifest(`http://127.0.0.1:${hang.address().port}/raw`, { user: 'u', token: 't' }, 300), /timed out/) } finally { hang.closeAllConnections(); hang.close() }
  assert.ok(Date.now() - t0 < 2000)
}))
