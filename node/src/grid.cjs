// The Grid - Node PoC v2: supervisor + the existing React UI + CLI, single file.
const fs = require('fs'), path = require('path'), http = require('http'), net = require('net')
const { spawn, execFile } = require('child_process')
const YAML = require('yaml')
const { WebSocketServer } = require('ws')
let nodePty = null
try { nodePty = require('node-pty') } catch (e) { console.error('node-pty not available, terminals use plain pipes:', e.message.split('\n')[0]) }
const WIN = process.platform === 'win32'
const VERSION = '0.0.1-nodepoc'
const PORT = Number(process.env.GRID_PORT || 18900)
const [cmd = 'serve', ...args] = process.argv.slice(2)
if (cmd !== 'serve') cli(); else serve()

function loadUI() { // embedded (bundle) or ./ui next to the script (dev)
  try { return require('./ui-embed.cjs') } catch {}
  const root = path.join(__dirname, '..', '..', 'web', 'dist'); const m = {}
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name); e.isDirectory() ? walk(p) : m['/' + path.relative(root, p).split(path.sep).join('/')] = fs.readFileSync(p).toString('base64')
  })
  walk(root); return m
}
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', json: 'application/json', woff2: 'font/woff2' }

function serve() {
  const flag = args.find(a => a.startsWith('--config='))
  const cfgFile = path.resolve(flag ? flag.slice(9) : 'grid.yaml')
  const base = path.dirname(cfgFile)
  const ui = loadUI()
  let cfg, svcs = {}
  const clients = new Set()
  const settings = { logLines: 1000, logFiles: false }
  const send = ev => { const d = `data: ${JSON.stringify(ev)}\n\n`; for (const r of clients) r.write(d) }

  const info = v => ({
    name: v.name, group: v.s.group || '', description: v.s.description, status: v.state, pid: v.pid || undefined,
    exitCode: v.exitCode, startedAt: v.startedAt, restarts: v.restarts, type: v.s.type || 'custom',
    command: v.s.command || '', cwd: path.resolve(base, v.s.cwd || '.'), url: v.s.url,
    dependsOn: v.s.depends_on, ready: v.s.ready && (v.s.ready.port ? 'port ' + v.s.ready.port : 'log /' + v.s.ready.log + '/'),
  })
  const state = () => ({
    version: VERSION, name: cfg.name || 'Grid', configPath: cfgFile, logLines: settings.logLines,
    logLineOptions: [500, 1000, 2000, 5000], runtimes: [], services: Object.values(svcs).map(info),
    features: [], logFileMax: 0, logFiles: settings.logFiles,
  })
  function load() {
    cfg = YAML.parse(fs.readFileSync(cfgFile, 'utf8'))
    const old = svcs; svcs = {}
    for (const [name, s] of Object.entries(cfg.services || {}))
      svcs[name] = old[name] ? Object.assign(old[name], { s }) : { name, s, state: 'stopped', pid: null, logs: [], seq: 0, restarts: 0 }
  }
  load()

  const emit = (v, stream, line) => {
    const entry = { seq: ++v.seq, t: Date.now(), s: stream, line }
    v.logs.push(entry); if (v.logs.length > 5000) v.logs.shift()
    send({ type: 'log', service: v.name, entry })
  }
  const setState = (v, st) => { v.state = st; send({ type: 'service', info: info(v) }) }
  const pipeLines = (v, stream, kind) => {
    const d = new TextDecoder(process.env.GRID_ENC || 'utf-8'); let buf = ''
    stream.on('data', c => {
      buf += d.decode(c, { stream: true }); let i
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); emit(v, kind, l); v.onLine && v.onLine(l) }
    })
  }
  const waitPort = (port, ms) => new Promise((ok, no) => {
    const t0 = Date.now()
    const t = () => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); ok() }); c.on('error', () => { c.destroy(); Date.now() - t0 > ms ? no(new Error('port timeout')) : setTimeout(t, 200) }) }
    t()
  })
  const waitLog = (v, re, ms) => new Promise((ok, no) => {
    const rx = new RegExp(re); const t = setTimeout(() => no(new Error('log timeout')), ms)
    v.onLine = l => { if (rx.test(l)) { clearTimeout(t); v.onLine = null; ok() } }
  })
  async function start(name) {
    const v = svcs[name]; if (!v) throw new Error('unknown service ' + name)
    if (['running', 'starting'].includes(v.state)) return
    for (const d of v.s.depends_on || []) await start(d)
    setState(v, 'starting'); v.startedAt = Date.now(); v.exitCode = undefined
    emit(v, 'sys', 'starting: ' + v.s.command)
    const env = { ...process.env, ...cfg.env, ...v.s.env }
    const p = v.proc = spawn(v.s.command, { shell: true, cwd: path.resolve(base, v.s.cwd || '.'), env, detached: !WIN, windowsHide: true })
    v.pid = p.pid; pipeLines(v, p.stdout, 'out'); pipeLines(v, p.stderr, 'err')
    p.on('exit', code => {
      const wanted = v.state === 'stopping'; v.pid = null; v.exitCode = code
      emit(v, 'sys', `exited with code ${code}`); setState(v, wanted ? 'stopped' : code === 0 ? 'exited' : 'crashed')
    })
    const r = v.s.ready, ms = 120000
    try {
      if (r && r.port) await waitPort(r.port, ms); else if (r && r.log) await waitLog(v, r.log, ms)
      if (v.state === 'starting') setState(v, 'running')
    } catch (e) { emit(v, 'sys', e.message) }
  }
  const killTree = pid => new Promise(ok => {
    if (WIN) return execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => ok())
    try { process.kill(-pid, 'SIGTERM') } catch {}
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch {} ; ok() }, 1500)
  })
  async function stop(name) {
    const v = svcs[name]; if (!v) throw new Error('unknown service ' + name)
    if (!v.pid) return
    setState(v, 'stopping'); await killTree(v.pid)
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  async function act(target, action) {
    const names = target === 'all' ? Object.keys(svcs) : target.startsWith('group:') ? Object.keys(svcs).filter(n => (svcs[n].s.group || '') === target.slice(6)) : [target]
    if (action === 'clear') return names.forEach(n => { svcs[n].logs = [] })
    for (const n of names) {
      if (!svcs[n]) throw new Error('unknown service ' + n)
      if (action === 'stop') await stop(n)
      else if (action === 'restart') { await stop(n); await sleep(300); svcs[n].restarts++; start(n) }
      else if (action === 'start' || action === 'start-nobuild') start(n)
      else throw new Error('unknown action ' + action)
    }
  }


  // ---- terminals: node-pty (real pty / ConPTY) when available, else plain pipes ----
  const terms = new Map(); let termSeq = 0
  const shells = () => WIN
    ? [{ name: 'PowerShell', path: 'powershell.exe' }, { name: 'Command Prompt', path: 'cmd.exe' }]
    : [{ name: path.basename(process.env.SHELL || '/bin/sh'), path: process.env.SHELL || '/bin/sh' }, { name: 'sh', path: '/bin/sh' }]
  const termInfo = t => ({ id: t.id, title: t.title, shell: t.shell, cwd: t.cwd, service: t.service, runtimes: t.runtimes, pid: t.pid, started: t.started, exited: t.exited, exitCode: t.exitCode })
  const sendTerms = () => send({ type: 'terms', terms: [...terms.values()].map(termInfo) })
  function openTerm(o) {
    const sh = o.shell || shells()[0].path
    const cwd = o.cwd ? path.resolve(base, o.cwd) : base
    const env = { ...process.env, ...cfg.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'the-grid' }
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
    if (req.method !== 'GET' && !req.headers['x-grid']) return json({ error: 'missing X-Grid header' }, 403)
    try {
      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const logs = {}; for (const v of Object.values(svcs)) logs[v.name] = v.logs.slice(-settings.logLines)
        res.write(`data: ${JSON.stringify({ type: 'snapshot', state: state(), logs, terms: [...terms.values()].map(termInfo) })}\n\n`)
        clients.add(res); return req.on('close', () => clients.delete(res))
      }
      if (p === '/api/state') return json(state())
      let m
      if (req.method === 'POST' && (m = p.match(/^\/api\/do\/([^/]+)\/([^/]+)$/))) {
        try { await act(decodeURIComponent(m[1]), m[2]); return json({ ok: true }) } catch (e) { return json({ error: e.message }, 400) }
      }
      if ((m = p.match(/^\/api\/services\/([^/]+)\/logs$/))) {
        const v = svcs[decodeURIComponent(m[1])]; if (!v) return json({ error: 'unknown service' }, 404)
        const e = v.logs.slice(-(Number(u.searchParams.get('tail')) || 200))
        if (u.searchParams.get('format') === 'json') return json(e)
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(e.map(x => (x.s === 'sys' ? '[grid] ' : '') + x.line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n') + '\n')
      }
      if (p === '/api/reload' && req.method === 'POST') { load(); send({ type: 'snapshot', state: state(), terms: [...terms.values()].map(termInfo) }); return json({ ok: true }) }
      if (p === '/api/settings' && req.method === 'PUT') { Object.assign(settings, await body()); send({ type: 'snapshot', state: state(), terms: [...terms.values()].map(termInfo) }); return json(state()) }
      if (p === '/api/workspaces') return json({ workspaces: [] })
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
    for (const [n, s] of Object.entries(cfg.services || {})) if (s.autostart) start(n)
    if (!args.includes('--no-browser')) execFile(WIN ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open', WIN ? ['/c', 'start', '', `http://127.0.0.1:${PORT}`] : [`http://127.0.0.1:${PORT}`], () => {})
  })
  const bye = async () => { terms.forEach(t => !t.exited && t.kill()); await Promise.all(Object.keys(svcs).map(n => stop(n).catch(() => {}))); process.exit(0) }
  process.on('SIGINT', bye); process.on('SIGTERM', bye)
}

function cli() {
  const act = ['start', 'stop', 'restart'].includes(cmd)
  const get = p => new Promise(ok => http.get({ host: '127.0.0.1', port: PORT, path: p }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => ok(b)) }).on('error', e => { console.error('grid not running:', e.message); process.exit(1) }))
  if (cmd === 'status') return get('/api/state').then(b => JSON.parse(b).services.forEach(s => console.log(s.name.padEnd(16), s.status.padEnd(10), s.pid || '')))
  if (cmd === 'logs') return get(`/api/services/${args[0]}/logs?tail=${args[1] || 50}`).then(console.log)
  if (act) { const r = http.request({ host: '127.0.0.1', port: PORT, path: `/api/do/${args[0]}/${cmd}`, method: 'POST', headers: { 'x-grid': 'cli' } }, res => res.pipe(process.stdout)); r.end(); return }
  console.log('usage: grid [serve [--no-browser] [--config=file]] | status | logs <svc> [n] | start|stop|restart <svc|all>')
}
