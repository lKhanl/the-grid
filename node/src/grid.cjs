// The Grid (Node version): supervisor + the existing React UI + CLI, single file.
const fs = require('fs'), path = require('path'), http = require('http'), net = require('net')
const { spawn, execFile } = require('child_process')
const { load: loadConfig, environ, checkRuntime } = require('./config.cjs')
const { Service } = require('./service.cjs')
const { stripAnsi } = require('./util.cjs')
const { createApi } = require('./api.cjs')
const { createGit } = require('./git.cjs')
const { openStore, createWorkspaces, gridDir } = require('./workspaces.cjs')
const { createStats } = require('./stats.cjs')
const { createDb } = require('./db.cjs')
const { McpServer, serveStdio, handleHttp: mcpHttp, parseFlags } = require('./mcp.cjs')
const WIN = process.platform === 'win32'
const VERSION = require('./version.cjs')
const update = require('./update.cjs')
const [cmd = 'serve', ...args] = process.argv.slice(2)
const PORT = parseFlags(args, Number(process.env.GRID_PORT || 18900)).port // -p wins over $GRID_PORT
if (cmd === 'mcp') mcpStdio()
else if (cmd === 'serve') update.maybeUpdateOnServe(VERSION).then(restarted => { if (!restarted) serve() }, () => serve()) // the check never blocks serve for long and never throws
else if (cmd === 'update') update.updateCmd(args, VERSION).catch(e => { console.error('update: ' + e.message); process.exit(1) })
else if (cmd === 'version' || cmd === '--version' || cmd === '-v') console.log(VERSION)
else cli()

// `mcp`: the MCP server on stdin / stdout for an AI agent; it talks to the running Grid on -p / $GRID_PORT
function mcpStdio() {
  const f = parseFlags(args, PORT)
  serveStdio(new McpServer({ port: f.port, version: VERSION, defaultWait: f.wait > 0 ? f.wait * 1000 : undefined })).then(() => process.exit(0))
}

function loadUI() { // embedded (bundle) or ./ui next to the script (dev)
  try { return require('./ui-embed.cjs') } catch {}
  const root = path.join(__dirname, '..', '..', 'web', 'dist'); const m = {}
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name); e.isDirectory() ? walk(p) : m['/' + path.relative(root, p).split(path.sep).join('/')] = fs.readFileSync(p).toString('base64')
  })
  walk(root); return m
}
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', json: 'application/json', woff2: 'font/woff2' }


const LOG_LINE_OPTIONS = [1000, 2500, 5000, 10000]

function serve() {
  const { WebSocketServer } = require('ws')
  let nodePty = null
  try { nodePty = require('node-pty') } catch (e) { console.error('node-pty not available, terminals use plain pipes:', e.message.split('\n')[0]) }
  const flag = args.find(a => a.startsWith('--config='))
  // ~/.grid/state.json: recent workspaces (shared with the Go version); null when there is no usable home folder
  let store = null; try { store = openStore() } catch (e) { console.error('warning: no ~/.grid state (recent workspaces disabled):', e.message) }
  // --config wins; else ./grid.yaml; else the last opened workspace
  let cfgFile = path.resolve(flag ? flag.slice(9) : 'grid.yaml')
  if (!flag && !fs.existsSync(cfgFile) && store) { try { cfgFile = store.last() || cfgFile } catch {} }
  let base = path.dirname(cfgFile)
  const ui = loadUI()
  let cfg, svcs = {}
  const clients = new Set()
  const settings = { logLines: 1000, logFiles: false }
  const send = ev => { const d = `data: ${JSON.stringify(ev)}\n\n`; for (const r of clients) r.write(d) }

  // what Service needs from its manager
  const mgr = {
    send, get: n => svcs[n], logLines: () => settings.logLines, environ: sc => environ(cfg, sc),
    get config() { return cfg },
  }
  const state = () => ({
    version: VERSION, name: cfg.name || 'Grid', configPath: cfgFile, logLines: settings.logLines,
    logLineOptions: LOG_LINE_OPTIONS,
    runtimes: [...cfg.runtimes.values()].map(rt => ({ name: rt.name, type: rt.type, home: rt.home, error: checkRuntime(rt) || undefined })),
    services: Object.values(svcs).map(v => v.info()),
    features: db.features(), logFileMax: 0, logFiles: settings.logFiles,
  })
  const snapshot = (withLogs) => {
    const ev = { type: 'snapshot', state: state(), terms: [...terms.values()].map(termInfo) }
    if (withLogs) { ev.logs = {}; for (const v of Object.values(svcs)) ev.logs[v.name] = v.tail(settings.logLines) }
    return ev
  }
  // Reads the file; running services keep running with the old settings, the new ones apply on their next start.
  // Services removed from the file are stopped and dropped. Throws when the file is invalid (nothing changes).
  async function load() {
    const next = loadConfig(cfgFile), old = svcs; svcs = {}; cfg = next
    for (const s of next.services) {
      if (old[s.name]) { svcs[s.name] = old[s.name]; svcs[s.name].setConfig(s); delete old[s.name] } else svcs[s.name] = new Service(mgr, s)
    }
    await Promise.all(Object.values(old).map(v => v.stop().catch(() => {})))
  }
  try { cfg = loadConfig(cfgFile); for (const s of cfg.services) svcs[s.name] = new Service(mgr, s) } catch (e) { console.error(e.message); process.exit(1) }
  if (store) { try { store.touch(cfg.path, cfg.name) } catch (e) { console.error('~/.grid state:', e.message) } }

  // Replaces the whole workspace (port of Manager.Switch): the new file is loaded first (nothing changes when it is invalid), then
  // its services take the place of the old ones, which are stopped. Terminals stay open. cfg is a new object, which empties git's cache.
  async function switchTo(file) {
    const next = loadConfig(file), old = svcs
    cfg = next; cfgFile = next.path; base = next.dir; svcs = {}
    for (const s of next.services) svcs[s.name] = new Service(mgr, s)
    await Promise.all(Object.values(old).map(v => v.stop().catch(() => {})))
    send(snapshot(false))
  }

  // editing grid.yaml, wizard helpers, folder picker (api.cjs); after a write the file is read again and the UI gets a snapshot
  const configApi = createApi({ get file() { return cfgFile }, get base() { return base }, svcs: () => svcs, state, reload: async () => { await load(); send(snapshot(false)) } })

  // git changes panel (git.cjs): the repositories of the services' folders; cfg is a new object on every load, which empties its cache
  // recent workspaces and switching (workspaces.cjs)
  const workspaces = createWorkspaces({ store, current: () => cfgFile, switchTo, name: () => cfg.name, state })

  // CPU / memory of the running services' process trees (stats.cjs), sampled only while a UI is connected; fields ride on the service info events
  const stats = createStats({ svcs: () => svcs, clients: () => clients.size, publish: v => v.publish() })

  // the Database panel (db.cjs): saved connections in ~/.grid/connections.json, the SQL sessions, the guarded AI access. Its drivers load on first use;
  // one that cannot be loaded drops its kind from the features
  const db = createDb({ home: gridDir(), onChange: () => send(snapshot(false)) })
  const mcpServer = new McpServer({ port: PORT, version: VERSION }) // for POST /mcp: the same tools as `grid mcp`, calling this server's own API

  const gitApi = createGit({ svcs: () => svcs, generation: () => cfg })

  // "all", a service name or a group name
  function resolve(target) {
    if (target === 'all') return Object.values(svcs)
    if (svcs[target]) return [svcs[target]]
    const g = target.startsWith('group:') ? target.slice(6) : target
    const out = Object.values(svcs).filter(v => v.cfg.group === g)
    if (!out.length) throw new Error(`no service or group named "${target}"`)
    return out
  }
  // start / restart run in the background (they may wait for dependencies); stop waits for the processes to exit
  async function act(target, action) {
    const list = resolve(target), bg = p => p.catch(() => {}) // failures are logged by the service
    switch (action) {
      case 'start': list.forEach(v => bg(v.start())); break
      case 'start-nobuild': list.forEach(v => bg(v.start(true))); break
      case 'restart': list.forEach(v => bg(v.restart())); break
      case 'stop': await Promise.all(list.map(v => v.stop())); break
      case 'clear': list.forEach(v => v.clear()); break
      default: throw new Error(`unknown action "${action}"`)
    }
  }
  const killTree = pid => new Promise(ok => {
    if (WIN) return execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => ok())
    try { process.kill(-pid, 'SIGTERM') } catch {}
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch {} ; ok() }, 1500)
  })


  // ---- terminals: node-pty (real pty / ConPTY) when available, else plain pipes ----
  const terms = new Map(); let termSeq = 0
  const shells = () => WIN
    ? [{ name: 'PowerShell', path: 'powershell.exe' }, { name: 'Command Prompt', path: 'cmd.exe' }]
    : [{ name: path.basename(process.env.SHELL || '/bin/sh'), path: process.env.SHELL || '/bin/sh' }, { name: 'sh', path: '/bin/sh' }]
  const termInfo = t => ({ id: t.id, title: t.title, shell: t.shell, cwd: t.cwd, service: t.service, runtimes: t.runtimes, pid: t.pid, started: t.started, exited: t.exited, exitCode: t.exitCode })
  const sendTerms = () => send({ type: 'terms', terms: [...terms.values()].map(termInfo) })
  function openTerm(o) {
    const sh = o.shell || shells()[0].path
    // a service's terminal gets exactly what the service gets (env, env files, runtimes) in its folder
    const v = o.service && svcs[o.service]
    if (o.service && !v) throw new Error(`unknown service "${o.service}"`)
    const cwd = o.cwd ? path.resolve(base, o.cwd) : v ? v.cfg.cwd : base
    const env = { ...environ(cfg, v ? { ...v.cfg, color: false } : { runtime: o.runtimes || [], color: false }), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'the-grid' }
    const t = { id: 't' + (++termSeq), title: o.service || path.basename(sh), shell: sh, cwd, service: o.service, runtimes: o.runtimes, started: Date.now(), exited: false, hist: Buffer.alloc(0), subs: new Set() }
    const out = b => { t.hist = Buffer.concat([t.hist, b]); if (t.hist.length > 262144) t.hist = t.hist.subarray(-262144); for (const f of t.subs) f(b) }
    const done = code => { t.exited = true; t.exitCode = code; t.pid = undefined; for (const f of t.subs) f(null); sendTerms() }
    if (nodePty) {
      const p = nodePty.spawn(sh, [], { name: 'xterm-256color', cols: o.cols || 100, rows: o.rows || 28, cwd, env, useConpty: true })
      t.pid = p.pid; p.onData(d => out(Buffer.from(d))); p.onExit(e => done(e.exitCode))
      t.write = b => p.write(b.toString()); t.resize = (c, r) => { try { p.resize(c, r) } catch {} }; t.kill = () => { try { p.kill() } catch {} }
    } else {
      const p = spawn(sh, WIN ? [] : ['-i'], { cwd, env, windowsHide: true })
      t.pid = p.pid; p.stdout.on('data', out); p.stderr.on('data', out); p.on('exit', done)
      t.write = b => { const s = b.toString().replace(/\r/g, '\n'); out(Buffer.from(s.replace(/\n/g, '\r\n'))); p.stdin.write(s) } // local echo, no tty
      t.resize = () => {}; t.kill = () => killTree(p.pid)
    }
    terms.set(t.id, t); sendTerms(); return t
  }
  const wss = new WebSocketServer({ noServer: true })

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    const body = () => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b ? JSON.parse(b) : {})) })
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return json({ error: 'bad host' }, 403)
    // MCP over HTTP: clients such as Claude Code do not send X-Grid, so it has its own guard (Host above, Origin and Content-Type in mcp.cjs)
    if (p === '/mcp') return mcpHttp(mcpServer, req, res).catch(e => json({ error: e.message }, 500))
    if (req.method !== 'GET' && !req.headers['x-grid']) return json({ error: 'missing X-Grid header' }, 403)
    try {
      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(`data: ${JSON.stringify(snapshot(true))}\n\n`)
        const ping = setInterval(() => res.write(': ping\n\n'), 15000)
        clients.add(res); return req.on('close', () => { clearInterval(ping); clients.delete(res) })
      }
      if (p === '/api/state') return json(state())
      let m
      if (req.method === 'POST' && (m = p.match(/^\/api\/do\/([^/]+)\/([^/]+)$/))) {
        try { await act(decodeURIComponent(m[1]), m[2]); return json({ ok: true }) } catch (e) { return json({ error: e.message }, 400) }
      }
      if ((m = p.match(/^\/api\/services\/([^/]+)\/logs$/))) {
        const v = svcs[decodeURIComponent(m[1])]; if (!v) return json({ error: 'unknown service' }, 404)
        const n = parseInt(u.searchParams.get('tail')) || 200
        const e = u.searchParams.get('since') === 'start' ? v.sinceStart(n) : v.tail(n) // since=start: only what the latest start produced
        if (u.searchParams.get('format') === 'json') return json(e)
        const raw = u.searchParams.get('raw') === '1'
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(e.map(x => (x.s === 'sys' ? '[grid] ' : '') + (raw ? x.line : stripAnsi(x.line))).join('\n') + '\n')
      }
      if (p === '/api/reload' && req.method === 'POST') {
        try { await load() } catch (e) { return json({ error: e.message }, 400) }
        send(snapshot(false)); return json(state())
      }
      if (p === '/api/settings' && req.method === 'PUT') {
        const b = await body()
        if (b.logLines === undefined && b.logFiles === undefined) return json({ error: 'expected logLines and/or logFiles' }, 400)
        if (b.logLines !== undefined && !LOG_LINE_OPTIONS.includes(b.logLines)) return json({ error: `logLines must be one of [${LOG_LINE_OPTIONS.join(' ')}]` }, 400)
        if (b.logLines !== undefined) { settings.logLines = b.logLines; Object.values(svcs).forEach(v => v.setMax()) }
        if (b.logFiles !== undefined) settings.logFiles = !!b.logFiles // remembered only: the node runner writes no log files
        send(snapshot(false)); return json(state())
      }
      if (await configApi.handle(req, res, u, json)) return
      if (await gitApi.handle(req, res, u, json)) return
      if (await workspaces.handle(req, res, u, json)) return
      if (await db.handle(req, res, u, json)) return
      if (p === '/api/terms/shells') return json(shells())
      if (p === '/api/terms' && req.method === 'GET') return json([...terms.values()].map(termInfo))
      if (p === '/api/terms' && req.method === 'POST') { try { return json(termInfo(openTerm(await body()))) } catch (e) { return json({ error: e.message }, 400) } }
      if ((m = p.match(/^\/api\/terms\/([^/]+)$/)) && req.method === 'DELETE') {
        const t = terms.get(m[1]); if (!t) return json({ error: 'unknown terminal' }, 404)
        if (!t.exited) t.kill(); terms.delete(t.id); sendTerms(); return json({ ok: true })
      }
      if (p.startsWith('/api/')) return json({ error: 'not implemented in the node poc' }, 501)
      const f = ui[p === '/' ? '/index.html' : p]
      if (!f) { res.statusCode = 404; return res.end('not found') }
      res.writeHead(200, { 'content-type': MIME[p.split('.').pop()] || (p === '/' ? MIME.html : 'application/octet-stream') }); res.end(Buffer.from(f, 'base64'))
    } catch (e) { json({ error: e.message }, 500) }
  })
  server.on('upgrade', (req, sock, head) => {
    const m = req.url.match(/^\/api\/terms\/([^/]+)\/ws$/), t = m && terms.get(m[1])
    const host = req.headers.host || '', origin = req.headers.origin
    if (!t || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || (origin && new URL(origin).host !== host)) { sock.destroy(); return }
    wss.handleUpgrade(req, sock, head, ws => {
      if (t.hist.length) ws.send(t.hist)
      const sub = b => { if (b === null) ws.send(JSON.stringify({ t: 'exit' })); else if (ws.readyState === 1) ws.send(b) }
      if (t.exited) ws.send(JSON.stringify({ t: 'exit' })); else t.subs.add(sub)
      ws.on('message', (data, isBin) => {
        if (t.exited) return
        if (isBin) t.write(Buffer.from(data))
        else { try { const c = JSON.parse(data.toString()); if (c.t === 'r') t.resize(c.c, c.r) } catch {} }
      })
      ws.on('close', () => t.subs.delete(sub))
    })
  })
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`The Grid ${VERSION} http://127.0.0.1:${PORT}  (config: ${cfgFile})`)
    for (const v of Object.values(svcs)) if (v.cfg.autostart) v.start().catch(() => {})
    if (!args.includes('--no-browser')) execFile(WIN ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open', WIN ? ['/c', 'start', '', `http://127.0.0.1:${PORT}`] : [`http://127.0.0.1:${PORT}`], () => {})
  })
  const bye = async () => { stats.close(); await db.close().catch(() => {}); terms.forEach(t => !t.exited && t.kill()); await Promise.all(Object.values(svcs).map(v => v.stop().catch(() => {}))); process.exit(0) }
  process.on('SIGINT', bye); process.on('SIGTERM', bye)
}

function cli() {
  const act = ['start', 'stop', 'restart'].includes(cmd)
  const get = p => new Promise(ok => http.get({ host: '127.0.0.1', port: PORT, path: p }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => ok(b)) }).on('error', e => { console.error('grid not running:', e.message); process.exit(1) }))
  if (cmd === 'status') return get('/api/state').then(b => JSON.parse(b).services.forEach(s => console.log(s.name.padEnd(16), s.status.padEnd(10), s.pid || '')))
  if (cmd === 'logs') return get(`/api/services/${args[0]}/logs?tail=${args[1] || 50}`).then(console.log)
  if (act) { const r = http.request({ host: '127.0.0.1', port: PORT, path: `/api/do/${args[0]}/${cmd}`, method: 'POST', headers: { 'x-grid': 'cli' } }, res => res.pipe(process.stdout)); r.end(); return }
  console.log('usage: grid [serve [--no-browser] [--config=file]] | status | logs <svc> [n] | start|stop|restart <svc|all> | update [--check] [--force] | version')
}
