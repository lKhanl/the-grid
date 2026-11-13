// MCP server (port of internal/mcp): lets an AI agent see and restart the services of a running Grid and, for the connections the user shared,
// look into the databases. It only talks to the Grid's HTTP API (X-Grid: mcp), so the Grid must be running. Two transports share the tools:
//   stdio:            `grid.bundle.cjs mcp [-p port] [--wait secs]`, one JSON-RPC message per line (serveStdio)
//   Streamable HTTP:  POST /mcp on the running Grid (handleHttp, wired in grid.cjs), JSON responses only, no sessions
// Kept deliberately small (a few tools, short plain-text answers) so that modest models handle it reliably and spend few tokens.
const http = require('http')
const YAML = require('yaml')
const { where } = require('./dbstore.cjs')

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] // newest first
const DEFAULT_VERSION = '2024-11-05' // what a client that does not say gets (like the Go version)
const MAX_LINE_LEN = 400, MAX_LOG_TEXT = 8000
const MAX_CELL_LEN = 120, MAX_DB_TEXT = 12000, DEFAULT_DB_ROWS = 50, MAX_DB_ROWS = 500

const DB_INSTRUCTIONS = ' Databases the user shared are reachable with db_list, db_tables, db_describe and db_query (read-only; always describe a table before querying it).'
const CONFIG_INSTRUCTIONS = ' The services and runtimes are defined in the Grid\'s config file (grid.yaml): never open, read or edit that file (or its .bak / .tmp) yourself. describe shows a service\'s settings and runtimes lists the runtimes; to change them use service_add, service_edit, service_remove, runtime_add, runtime_edit and runtime_remove. The Grid checks every change, keeps the file\'s comments, and applies it at once (no reload needed); a running service uses its new settings after a restart.'
const INSTRUCTIONS = "Controls the services of The Grid. Use restart after changing a service's code, then read the log tail it returns (only what that start produced). To look into a problem use logs with level=error, grep or since_restart instead of reading many lines; describe tells where a service lives and how it runs." + CONFIG_INSTRUCTIONS + DB_INSTRUCTIONS + ' Builds can be slow: if restart says the service is still building or starting, that is NOT a failure; call wait (never restart again) until it is running.'

// the settings of a service, as the agent writes them (grid.yaml's keys)
const SERVICE_SETTINGS = 'Settings use grid.yaml\'s keys. ' +
  'type: spring-boot | node | script | jar | custom (default custom). cwd: the project folder (absolute, or relative to the config file). ' +
  'command: the command line, only for type custom. ' +
  'spring: {module (Maven module, multi-module projects), profiles: [..], jvm_args, args, mode: package | run (default package: mvn package then java -jar), skip_tests (default true), offline, always_build}. ' +
  'node: {script (package.json script, required, e.g. dev), args, install: if-changed | always | never, package_manager: auto | npm | yarn | pnpm}. ' +
  'script: {file (required), args}. jar: {file (required), jvm_args, args}. ' +
  'runtime: a runtime name or a list of them (see runtimes; at most one java and one node). env: {NAME: value}. env_file: a .env file. ' +
  'encoding: auto | utf-8 | cp1254 (cp1254 for Windows Java logs with Turkish characters). depends_on: [service names started first]. ' +
  'ready: {port: 8080} or {log: regex of a log line}, optional timeout like 3m; without it the service counts as running at once. ' +
  'restart: no | on-failure | always, max_restarts. autostart: true starts it with the Grid. stop_timeout: e.g. 10s. url: link shown in the UI. ' +
  'group, description: shown in the UI. shell: the shell for the command. changes: false stops watching the folder for changes, changes_ignore: [glob patterns].'
const RUNTIME_SETTINGS = 'Settings: type: java | node | script (default from the name: java*/jdk*/jre* = java, node* = node, else script). ' +
  'home: the installation folder (required; for java the JAVA_HOME). bin: the folder with the executables, if not home/bin. env: {NAME: value} set for the services that use it.'
const RENAME = { type: 'string', description: 'new name, to rename it (references to it are renamed too)' }

const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) })
const SERVICE = { type: 'string', description: 'service name, see status' }
const CONNECTION = { type: 'string', description: 'connection name, see db_list' }
const TOOLS = [
  { name: 'status', description: 'List the services of The Grid with their state (running, building, crashed, stopped...).', inputSchema: obj({}) },
  {
    name: 'logs',
    description: "Last lines of a service's log (colors removed). To save tokens, filter instead of reading everything: level=error shows only errors and exceptions, grep a regex, since_restart only what the latest start produced.",
    inputSchema: obj({
      service: SERVICE,
      lines: { type: 'integer', description: 'how many lines (default 100, max 500)' },
      level: { type: 'string', enum: ['error', 'warn'], description: "only lines that look like errors (ERROR, FATAL, exceptions, 'Caused by', FAILED) or, with warn, also warnings" },
      grep: { type: 'string', description: 'only lines matching this regular expression (case-insensitive)' },
      since_restart: { type: 'boolean', description: 'only lines since the latest start / restart (build output included), no old crashes' },
      context: { type: 'integer', description: 'with level / grep: also show this many lines after each match, e.g. 5 for a stack trace (default 0, max 20)' },
    }, ['service']),
  },
  { name: 'describe', description: 'Everything known about one service: state, folder, build and run command, URL, readiness check, dependencies, runtimes, and its settings as written in the config.', inputSchema: obj({ service: SERVICE }, ['service']) },
  {
    name: 'restart',
    description: 'Restart a service (or start / stop it), wait until it is running or has failed, and return the result with the last log lines. Use after changing code. Slow builds: if the answer says STILL BUILDING / STARTING, it is not a failure; call wait, do not restart again.',
    inputSchema: obj({
      service: SERVICE,
      action: { type: 'string', enum: ['restart', 'start', 'stop'], description: 'default restart' },
      wait: { type: 'integer', description: 'max seconds to wait (default 40)' },
    }, ['service']),
  },
  {
    name: 'reload',
    description: 'Re-read the config and the saved database connections after the USER changed those files by hand. Not needed after the service_* / runtime_* tools, which apply their change at once. Removed services are stopped; running services keep running and use their new settings at the next restart.',
    inputSchema: obj({}),
  },
  {
    name: 'service_add',
    description: 'Add a new service to the Grid (it is checked and saved in the config; it starts stopped). ' + SERVICE_SETTINGS + ' Example: {"name": "orders-api", "config": {"type": "spring-boot", "cwd": "C:/dev/orders", "runtime": "java17", "spring": {"profiles": ["local"]}, "ready": {"port": 8081}, "url": "http://localhost:8081"}}',
    inputSchema: obj({
      name: { type: 'string', description: "new service name: letters, digits, '.', '_' or '-'" },
      config: { type: 'object', description: 'the settings (grid.yaml keys, see the tool description)' },
    }, ['name', 'config']),
  },
  {
    name: 'service_edit',
    description: 'Change settings of a service. Give only what changes; null removes a setting. spring, node, script, jar and env are merged key by key (null removes one key there); other values are replaced as a whole. Settings not mentioned and comments in the config stay as they are. Call describe first to see the current settings. ' + SERVICE_SETTINGS,
    inputSchema: obj({
      name: SERVICE,
      change: { type: 'object', description: 'settings to change, e.g. {"spring": {"profiles": ["local", "debug"]}, "ready": {"port": 8085}, "url": null}' },
      rename: RENAME,
    }, ['name']),
  },
  {
    name: 'service_remove',
    description: 'Remove a service from the config. It must be stopped first (restart action=stop), and no other service may depend on it.',
    inputSchema: obj({ name: SERVICE }, ['name']),
  },
  { name: 'runtimes', description: 'List the runtimes (JDKs, Node installations, tool folders) with their settings and whether their folder is found.', inputSchema: obj({}) },
  {
    name: 'runtime_add',
    description: 'Add a runtime that services can use with their runtime setting. ' + RUNTIME_SETTINGS + ' Example: {"name": "java17", "config": {"home": "C:/tools/jdk-17"}}',
    inputSchema: obj({
      name: { type: 'string', description: "new runtime name: letters, digits, '.', '_' or '-'" },
      config: { type: 'object', description: 'the settings (see the tool description)' },
    }, ['name', 'config']),
  },
  {
    name: 'runtime_edit',
    description: 'Change settings of a runtime. Give only what changes; null removes a setting; env is merged key by key. ' + RUNTIME_SETTINGS,
    inputSchema: obj({
      name: { type: 'string', description: 'runtime name, see runtimes' },
      change: { type: 'object', description: 'settings to change, e.g. {"home": "C:/tools/jdk-17.0.12"}' },
      rename: RENAME,
    }, ['name']),
  },
  {
    name: 'runtime_remove',
    description: 'Remove a runtime from the config. If services use it this fails, unless detach is true: then it is also taken off those services.',
    inputSchema: obj({ name: { type: 'string', description: 'runtime name, see runtimes' }, detach: { type: 'boolean', description: 'also remove it from the services that use it' } }, ['name']),
  },
  {
    name: 'wait',
    description: 'Keep waiting for a service that restart reported as still building or starting. Returns when it is running or has failed, with the last log lines.',
    inputSchema: obj({ service: SERVICE, wait: { type: 'integer', description: 'max seconds to wait (default 40)' } }, ['service']),
  },
  { name: 'db_list', description: 'List the database connections shared with you (name, where, user, and whether you may change data). Start here.', inputSchema: obj({}) },
  {
    name: 'db_tables',
    description: "Find tables and views of a connection. Without schema: the connection's own schema; schema=* searches every user schema. search is a name fragment (case-insensitive, * wildcard).",
    inputSchema: obj({
      connection: CONNECTION,
      schema: { type: 'string', description: "schema (owner); default the connection's own, * for all" },
      search: { type: 'string', description: 'part of a table name' },
    }, ['connection']),
  },
  {
    name: 'db_describe',
    description: 'Columns (type, null, primary key, comment), keys and indexes of one table or view. Use before writing a query.',
    inputSchema: obj({
      connection: CONNECTION,
      table: { type: 'string', description: 'table or view name' },
      schema: { type: 'string', description: "schema (owner); default the connection's own" },
    }, ['connection', 'table']),
  },
  {
    name: 'db_query',
    description: 'Run one SELECT (or WITH) statement and get the rows as text. Read-only: nothing is changed. Always limit the result yourself (WHERE, FETCH FIRST n ROWS ONLY); at most max_rows rows come back.',
    inputSchema: obj({
      connection: CONNECTION,
      sql: { type: 'string', description: 'one SELECT / WITH statement' },
      max_rows: { type: 'integer', description: 'default 50, max 500' },
    }, ['connection', 'sql']),
  },
  {
    name: 'db_execute',
    description: 'Run one statement that changes data or structure (INSERT, UPDATE, DELETE, DDL) and commit it. Only works on connections whose owner allowed read & write for AI (see db_list). Think twice: there is no undo.',
    inputSchema: obj({ connection: CONNECTION, sql: { type: 'string', description: 'one statement' } }, ['connection', 'sql']),
  },
]

// an object argument; some models send it as a JSON string
function objArg(v, key, optional) {
  if ((v === undefined || v === null) && optional) return {}
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { throw new Error(`${key} must be an object, not text`) } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${key} must be an object of settings`)
  return v
}
// settings as indented YAML lines (what an agent knows best)
function yamlBlock(o) {
  const t = YAML.stringify(o && Object.keys(o).length ? o : {}, { lineWidth: 0 }).replace(/\n+$/, '')
  return t.split('\n').map(l => '  ' + l).join('\n')
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const str = (a, k) => (typeof a[k] === 'string' ? a[k] : '')
function intArg(a, key, def, min, max) {
  let n = def; const v = a[key]
  if (typeof v === 'number') n = Math.trunc(v)
  else if (typeof v === 'string') { const x = parseInt(v, 10); if (!Number.isNaN(x)) n = x }
  return Math.max(min, Math.min(max, n))
}

const inProgress = s => s === 'starting' || s === 'building'
const label = v => ((v.status === 'crashed' || v.status === 'exited') && v.exitCode !== undefined && v.exitCode !== null ? `${v.status} (exit ${v.exitCode})` : v.status)
function humanBytes(n) {
  if (n >= 2 ** 30) return (n / 2 ** 30).toFixed(1) + ' GB'
  if (n >= 2 ** 20) return (n / 2 ** 20).toFixed(0) + ' MB'
  return (n / 1024).toFixed(0) + ' KB'
}
// " cpu 12% mem 512 MB" for a running process tree, else ""
function resources(v) {
  if (!v.mem && (v.cpu === undefined || v.cpu === null)) return ''
  let s = ''
  if (v.cpu !== undefined && v.cpu !== null) s += ` cpu ${Math.round(v.cpu)}%`
  if (v.mem > 0) s += ` mem ${humanBytes(v.mem)}`
  return s
}

// joins lines into one answer that stays small: long lines are cut, and when everything is still too long only the newest part is kept
function shorten(lines) {
  let text = lines.map(l => (l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) + ' ...' : l)).join('\n')
  if (text.length > MAX_LOG_TEXT) text = '... (older lines cut)\n' + text.slice(text.length - MAX_LOG_TEXT)
  return text
}

const ERROR_RE = /(\b(error|fatal|severe|panic|failed|failure)\b|exception\b|caused by:)/i
const WARN_RE = /\bwarn(ing)?\b/i
// the line test of a filter; null means "no filter"
function matcher(f) {
  const tests = []
  if (f.level === 'error') tests.push(l => ERROR_RE.test(l))
  else if (f.level === 'warn') tests.push(l => ERROR_RE.test(l) || WARN_RE.test(l))
  else if (f.level) throw new Error('level must be error or warn')
  if (f.grep) {
    let re; try { re = new RegExp(f.grep, 'i') } catch (e) { throw new Error('grep is not a valid regular expression: ' + e.message) }
    tests.push(l => re.test(l))
  }
  return tests.length ? l => tests.every(t => t(l)) : null
}
// keeps the matching lines (plus `context` lines after each), newest `limit` of them
function filterLines(lines, match, context, limit) {
  const keep = new Array(lines.length).fill(false)
  let matches = 0
  lines.forEach((l, i) => { if (match(l)) { matches++; for (let k = i; k <= i + context && k < lines.length; k++) keep[k] = true } })
  let out = [], gap = false
  lines.forEach((l, i) => {
    if (!keep[i]) { gap = true; return }
    if (gap && context > 0 && out.length) out.push('--') // like grep -A: a "--" between separate groups
    gap = false; out.push(l)
  })
  if (out.length > limit) out = out.slice(out.length - limit)
  if (out.length && out[0] === '--') out = out.slice(1)
  return { out, matches }
}

// keeps a cell on one line and cuts it to n characters
function oneLine(s, n) {
  s = s.split(/\s+/).filter(Boolean).join(' ')
  const r = [...s]
  return r.length > n ? r.slice(0, n).join('') + '...' : s
}
const colNames = r => (r.columns || []).map(c => c.name).join(' | ')
// a result as small plain text: header, rows, and a footer that says whether everything is there
function renderRows(r) {
  const rows = r.rows || []
  if (!rows.length) return `0 rows (${r.ms} ms). Columns: ${colNames(r)}`
  let out = colNames(r) + '\n', shown = 0
  for (const row of rows) {
    const line = row.map(c => (c === null ? 'NULL' : oneLine(c, MAX_CELL_LEN))).join(' | ') + '\n'
    if (out.length + line.length > MAX_DB_TEXT) break
    out += line; shown++
  }
  if (shown < rows.length) out += `... only ${shown} of ${rows.length} rows fit; select fewer columns or add a WHERE.`
  else if (r.truncated) out += `... first ${shown} rows; more exist. Add a WHERE or aggregate.`
  else out += `${shown} rows (${r.ms} ms).`
  return out
}

class McpServer {
  // opts: { port, base, version, defaultWait (ms), poll, grace, progress } (the times are for tests)
  constructor(opts) {
    this.base = opts.base || `http://127.0.0.1:${opts.port}`
    this.version = opts.version || '0'
    this.poll = opts.poll || 500; this.grace = opts.grace || 3000
    // how long restart / wait block when the agent gives no `wait`: kept under the typical 60 s tool timeout of MCP clients, so a slow build
    // (VDI) comes back as "still building", not as a timeout the agent reads as a failure
    this.defaultWait = opts.defaultWait || 40000
    this.progress = opts.progress || 3000 // how often a progress notification is sent while waiting
  }

  // ---- the Grid's HTTP API ----
  request(method, path, body) {
    return new Promise((ok, no) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
      const headers = { 'X-Grid': 'mcp' }
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length }
      const url = new URL(path, this.base)
      const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, timeout: 130000 }, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode >= 300) {
            let msg = ''; try { msg = JSON.parse(text).error } catch { /* not json */ }
            return no(new Error(msg || `${res.statusCode} ${http.STATUS_CODES[res.statusCode] || ''}`.trim()))
          }
          ok(text)
        })
      })
      req.on('timeout', () => req.destroy(new Error('the Grid did not answer in time')))
      req.on('error', e => no(e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' ? new Error(`The Grid is not running at ${this.base} (start it with: grid)`) : e))
      if (data) req.write(data)
      req.end()
    })
  }
  get(path) { return this.request('GET', path) }
  async services() { return JSON.parse(await this.get('/api/state')).services || [] }
  async find(name) {
    const list = await this.services(), v = list.find(x => x.name === name)
    if (v) return v
    throw new Error(`unknown service "${name}". Services: ${list.map(x => x.name).sort().join(', ')}`)
  }

  // ---- JSON-RPC ----
  // one request object -> { result } | { error } ; notify(method, params) sends a notification (progress) to the client, null = none
  async handle(req, notify) {
    switch (req.method) {
      case 'initialize': {
        const asked = req.params && typeof req.params.protocolVersion === 'string' ? req.params.protocolVersion : ''
        const v = !asked ? DEFAULT_VERSION : SUPPORTED.includes(asked) ? asked : SUPPORTED[0]
        return { result: { protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'grid', version: this.version }, instructions: INSTRUCTIONS } }
      }
      case 'ping': return { result: {} }
      case 'tools/list': return { result: { tools: TOOLS } }
      case 'tools/call': {
        const p = req.params
        if (!p || typeof p !== 'object' || typeof p.name !== 'string') return { error: { code: -32602, message: 'bad params' } }
        const tok = p._meta && p._meta.progressToken
        let progress = null
        if (notify && tok !== undefined && tok !== null) { let n = 0; progress = message => notify('notifications/progress', { progressToken: tok, progress: ++n, message }) }
        try { return { result: toolResult(await this.call(p.name, p.arguments && typeof p.arguments === 'object' ? p.arguments : {}, progress), false) } } catch (e) { return { result: toolResult(e.message, true) } }
      }
    }
    return { error: { code: -32601, message: 'method not found: ' + req.method } }
  }

  async call(name, args, progress) {
    switch (name) {
      case 'status': return this.status()
      case 'logs': return this.logs(str(args, 'service'), {
        lines: intArg(args, 'lines', 100, 1, 500), context: intArg(args, 'context', 0, 0, 20),
        level: str(args, 'level'), grep: str(args, 'grep'), sinceRestart: args.since_restart === true,
      })
      case 'describe': return this.describe(str(args, 'service'))
      case 'restart': return this.restart(str(args, 'service'), str(args, 'action') || 'restart', this.waitArg(args), progress)
      case 'wait': return this.waitTool(str(args, 'service'), this.waitArg(args), progress)
      case 'reload': return this.reload()
      case 'service_add': return this.serviceAdd(str(args, 'name'), args.config)
      case 'service_edit': return this.serviceEdit(str(args, 'name'), args.change, str(args, 'rename'))
      case 'service_remove': return this.serviceRemove(str(args, 'name'))
      case 'runtimes': return this.runtimes()
      case 'runtime_add': return this.runtimeAdd(str(args, 'name'), args.config)
      case 'runtime_edit': return this.runtimeEdit(str(args, 'name'), args.change, str(args, 'rename'))
      case 'runtime_remove': return this.runtimeRemove(str(args, 'name'), args.detach === true)
      case 'db_list': return this.dbList()
      case 'db_tables': return this.dbTables(str(args, 'connection'), str(args, 'schema'), str(args, 'search'))
      case 'db_describe': return this.dbDescribe(str(args, 'connection'), str(args, 'schema'), str(args, 'table'))
      case 'db_query': return this.dbQuery(str(args, 'connection'), str(args, 'sql'), intArg(args, 'max_rows', DEFAULT_DB_ROWS, 1, MAX_DB_ROWS), false)
      case 'db_execute': return this.dbQuery(str(args, 'connection'), str(args, 'sql'), DEFAULT_DB_ROWS, true)
    }
    throw new Error(`unknown tool "${name}"`)
  }
  // the wait budget in ms: the agent's `wait` seconds, else the default
  waitArg(args) { return 'wait' in args ? intArg(args, 'wait', Math.round(this.defaultWait / 1000), 1, 600) * 1000 : this.defaultWait }

  // ---- services ----
  async status() {
    const list = await this.services()
    if (!list.length) return 'No services.'
    return list.map(v => {
      let s = `${v.name}: ${label(v)}`
      if (inProgress(v.status) && v.startedAt > 0) s += ` (for ${Math.floor((Date.now() - v.startedAt) / 1000)}s)`
      if (v.type && v.type !== 'custom') s += ` [${v.type}]`
      if (v.url) s += ' ' + v.url
      return s + resources(v)
    }).join('\n')
  }

  // re-reads grid.yaml (and the database connections) and says what changed
  async reload() {
    const before = await this.services()
    let st
    try { st = JSON.parse(await this.request('POST', '/api/reload')) } catch (e) { throw new Error('grid.yaml not reloaded: ' + e.message) }
    const was = new Set(before.map(v => v.name)), services = st.services || [], runtimes = st.runtimes || []
    const added = []
    for (const v of services) { if (!was.has(v.name)) added.push(v.name); was.delete(v.name) }
    const removed = [...was].sort()
    let out = `grid.yaml reloaded: ${services.length} services, ${runtimes.length} runtimes.`
    if (added.length) out += `\nadded: ${added.join(', ')} (stopped; start them with restart action=start)`
    if (removed.length) out += `\nremoved (stopped): ${removed.join(', ')}`
    for (const r of runtimes) if (r.error) out += `\nruntime ${r.name}: ${r.error}`
    out += '\nRunning services use changed settings at their next restart.'
    return out + '\n' + (await this.dbReload())
  }
  // re-reads the saved database connections; the text says what changed (or why not)
  async dbReload() {
    let r
    try { r = JSON.parse(await this.request('POST', '/api/dbconn/reload')) } catch (e) { return 'database connections not reloaded: ' + e.message }
    let text = `database connections reloaded: ${r.total}.`
    for (const [label, names] of [['added', r.added], ['removed', r.removed], ['changed (reconnect on next use)', r.changed]]) if (names && names.length) text += `\n${label}: ${names.join(', ')}`
    return text
  }

  // up to n plain log lines (colors removed by the Grid)
  async fetchLogs(service, n, sinceStart) {
    const t = (await this.get(`/api/services/${encodeURIComponent(service)}/logs?tail=${n}${sinceStart ? '&since=start' : ''}`)).replace(/\n+$/, '')
    return t === '' ? [] : t.split('\n')
  }
  async tail(service, n, sinceStart) { return shorten(await this.fetchLogs(service, n, sinceStart)) }

  async logs(service, f) {
    await this.find(service)
    const match = matcher(f)
    if (!match) { // plain tail
      const t = await this.tail(service, f.lines, f.sinceRestart)
      return t.trim() === '' ? '(no log lines yet)' : t
    }
    // a filter looks through the whole history the Grid keeps, not just the last lines
    const all = await this.fetchLogs(service, 100000, f.sinceRestart)
    const { out, matches } = filterLines(all, match, f.context, f.lines)
    const where = f.sinceRestart ? 'since the latest start' : 'in the log'
    if (!matches) return `No matching lines ${where} (${all.length} lines checked).`
    let head = `${matches} matching lines ${where}`
    if (matches > f.lines) head += ` (showing the last ${f.lines})`
    return head + ':\n' + shorten(out)
  }

  async describe(service) {
    const v = await this.find(service)
    let b = `${v.name}: ${label(v)}`
    if (inProgress(v.status) && v.startedAt > 0) b += ` (for ${Math.floor((Date.now() - v.startedAt) / 1000)}s)`
    const line = (k, val) => { if (val !== undefined && val !== null && String(val).trim() !== '') b += `\n${k}: ${val}` }
    line('type', v.type); line('group', v.group); line('description', v.description); line('folder', v.cwd); line('build', v.build); line('run', v.command)
    line('url', v.url); line('ready when', v.ready); line('depends on', (v.dependsOn || []).join(', ')); line('runtimes', (v.runtimes || []).join(', '))
    if (v.pid > 0) line('pid', v.pid)
    if (v.restarts > 0) line('auto restarts', v.restarts)
    line('resources', resources(v).trim()); line('log file', v.logFile)
    try {
      const raw = JSON.parse(await this.get(`/api/config/raw/services/${encodeURIComponent(service)}`))
      b += '\nsettings (change them with service_edit):\n' + yamlBlock(raw)
    } catch { /* the rest is still useful */ }
    return b
  }

  // ---- editing the config (services and runtimes) through the Grid, which checks, saves and applies every change ----
  async serviceAdd(name, config) {
    if (!name) throw new Error('name is required')
    await this.request('POST', '/api/config/raw/services', { name, config: objArg(config, 'config') })
    return `service ${name} added (stopped; start it with restart action=start).\n` + (await this.describe(name))
  }
  async serviceEdit(name, change, rename) {
    const before = await this.find(name)
    const r = JSON.parse(await this.request('PATCH', `/api/config/raw/services/${encodeURIComponent(name)}`, { change: objArg(change, 'change', true), rename }))
    const now = rename || name
    if (!r.changed) return `nothing changed: ${name} already has these settings.`
    let out = rename && rename !== name ? `service ${name} renamed to ${now} and saved.` : `service ${now} saved.`
    if (before.status !== 'stopped' && before.status !== 'exited' && before.status !== 'crashed') out += ` It is ${before.status} with the old settings; restart it to use the new ones.`
    return out + '\n' + (await this.describe(now))
  }
  async serviceRemove(name) {
    const v = await this.find(name)
    if (!['stopped', 'exited', 'crashed'].includes(v.status)) throw new Error(`${name} is ${v.status}; stop it first (restart action=stop), then remove it`)
    await this.request('DELETE', `/api/config/services/${encodeURIComponent(name)}`)
    return `service ${name} removed from the config.`
  }
  async runtimes() {
    const raw = JSON.parse(await this.get('/api/config/raw/runtimes')), names = Object.keys(raw)
    if (!names.length) return 'No runtimes. Add one with runtime_add.'
    const st = JSON.parse(await this.get('/api/state')), info = new Map((st.runtimes || []).map(r => [r.name, r]))
    const users = new Map()
    for (const v of st.services || []) for (const r of v.runtimes || []) users.set(r, [...(users.get(r) || []), v.name])
    return names.map(n => {
      const i = info.get(n) || {}
      let s = `${n}: ${i.type || ''}${i.error ? ' - PROBLEM: ' + i.error : ' - ok'}`
      if (users.has(n)) s += `\n  used by: ${users.get(n).join(', ')}`
      return s + '\n' + yamlBlock(raw[n])
    }).join('\n')
  }
  async runtimeLine(name) {
    const st = JSON.parse(await this.get('/api/state')), r = (st.runtimes || []).find(x => x.name === name)
    if (!r) return ''
    return r.error ? `\nPROBLEM: ${r.error} (services using it will not start)` : `\n${r.type} at ${r.home}: found.`
  }
  async runtimeAdd(name, config) {
    if (!name) throw new Error('name is required')
    await this.request('POST', '/api/config/raw/runtimes', { name, config: objArg(config, 'config') })
    return `runtime ${name} added.` + (await this.runtimeLine(name))
  }
  async runtimeEdit(name, change, rename) {
    if (!name) throw new Error('name is required')
    const r = JSON.parse(await this.request('PATCH', `/api/config/raw/runtimes/${encodeURIComponent(name)}`, { change: objArg(change, 'change', true), rename }))
    if (!r.changed) return `nothing changed: ${name} already has these settings.`
    const now = rename || name
    return (rename && rename !== name ? `runtime ${name} renamed to ${now} and saved.` : `runtime ${now} saved.`) + ' Running services use it after a restart.' + (await this.runtimeLine(now))
  }
  async runtimeRemove(name, detach) {
    if (!name) throw new Error('name is required')
    await this.request('DELETE', `/api/config/runtimes/${encodeURIComponent(name)}${detach ? '?detach=1' : ''}`)
    return `runtime ${name} removed from the config.`
  }

  async restart(service, action, wait, progress) {
    if (!['restart', 'start', 'stop'].includes(action)) throw new Error('action must be restart, start or stop')
    const before = await this.find(service)
    await this.request('POST', `/api/do/${encodeURIComponent(service)}/${action}`)
    return this.report(service, action, before.startedAt || 0, wait, progress)
  }
  // keeps waiting for a service that is already starting (after restart timed out)
  async waitTool(service, wait, progress) {
    const cur = await this.find(service)
    return this.report(service, 'wait', cur.startedAt || 0, wait, progress)
  }
  async report(service, action, oldStart, wait, progress) {
    const { final, outcome } = await this.waitFor(service, action, oldStart, wait, progress)
    let b = `${service}: ${outcome}`
    if (final && !inProgress(final.status)) b += ` (status: ${label(final)})`
    if (action !== 'stop') {
      try { const t = await this.tail(service, 40, true); if (t.trim() !== '') b += '\n--- last log lines ---\n' + t } catch { /* the answer is still useful */ }
    }
    return b
  }
  // polls until the service is up, has failed, or the time is over
  async waitFor(service, action, oldStart, max, progress) {
    const start = Date.now(), deadline = start + max
    await sleep(this.poll) // let the action take effect before reading the state
    let runningSince = 0, lastProgress = 0
    for (;;) {
      let cur
      try { cur = await this.find(service) } catch (e) { return { final: null, outcome: 'could not read state: ' + e.message } }
      switch (cur.status) {
        case 'stopped': case 'exited': case 'crashed':
          return { final: cur, outcome: action === 'stop' ? 'stopped' : 'FAILED, it is not running' }
        case 'running':
          if (action === 'stop') break
          if ((cur.startedAt || 0) !== oldStart || action !== 'restart') {
            // no readiness check means "running" starts at once: wait a bit to catch an early crash
            if (!runningSince) runningSince = Date.now()
            if (Date.now() - runningSince >= this.grace) return { final: cur, outcome: 'running' }
          }
      }
      if (Date.now() > deadline) {
        const secs = Math.round((Date.now() - start) / 1000)
        if (inProgress(cur.status)) return { final: cur, outcome: `STILL ${cur.status.toUpperCase()} after ${secs}s. This is NOT a failure, the service is just slow. Call the wait tool to keep waiting; do not restart it again.` }
        return { final: cur, outcome: `not ready after ${secs}s` }
      }
      if (progress && Date.now() - lastProgress >= this.progress) { lastProgress = Date.now(); progress(`${service}: ${cur.status}, ${Math.floor((Date.now() - start) / 1000)}s`) }
      await sleep(this.poll)
    }
  }

  // ---- databases: the AI sees only the connections marked as shared in the Grid, and the Grid itself enforces read-only access ----
  async dbList() {
    const list = JSON.parse(await this.get('/api/ai/db'))
    if (!list.length) return 'No database connections are shared with AI. In the Grid: Database panel, edit a connection, set "MCP access" to read-only.'
    return list.map(v => {
      let w = where(v)
      if (w.length > 60) w = w.slice(0, 60) + '...' // a full TNS descriptor
      return `${v.name}: ${v.kind} ${w} as ${v.user}, ${v.mcp === 'readwrite' ? 'read & write' : 'read-only'}`
    }).join('\n')
  }
  async dbTables(conn, schema, search) {
    const q = new URLSearchParams({ schema, q: search, limit: '200' })
    const r = JSON.parse(await this.get(`/api/ai/db/${encodeURIComponent(conn)}/tables?${q}`))
    if (!r.tables || !r.tables.length) return 'No tables or views found. Try a shorter search, or schema=* to look in every schema.'
    let out = ''
    for (const t of r.tables) out += `${t.schema}.${t.name} (${t.type.toLowerCase()})${t.comment ? ' - ' + oneLine(t.comment, 100) : ''}\n`
    if (r.truncated) out += '... more exist: narrow the search.\n'
    return out.replace(/\n+$/, '')
  }
  async dbDescribe(conn, schema, table) {
    const q = new URLSearchParams({ schema, table })
    const t = JSON.parse(await this.get(`/api/ai/db/${encodeURIComponent(conn)}/describe?${q}`))
    let out = `${t.schema}.${t.name} (${t.type.toLowerCase()})`
    if (t.comment) out += ' - ' + oneLine(t.comment, 150)
    out += '\ncolumns:\n'
    for (const c of t.columns || []) out += `  ${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.pk ? ' PK' : ''}${c.comment ? ' - ' + oneLine(c.comment, 100) : ''}\n`
    for (const k of t.unique || []) out += `unique ${k.name}: (${k.columns.join(', ')})\n`
    for (const k of t.foreignKeys || []) out += `foreign key ${k.name}: (${k.columns.join(', ')}) -> ${k.ref}\n`
    for (const ix of t.indexes || []) out += `index ${ix.name}${ix.unique ? ' unique' : ''}: (${ix.columns.join(', ')})\n`
    return out.replace(/\n+$/, '')
  }
  async dbQuery(conn, sql, maxRows, write) {
    const r = JSON.parse(await this.request('POST', `/api/ai/db/${encodeURIComponent(conn)}/query`, { sql, maxRows, write }))
    if (r.kind === 'update') return `${r.rowsAffected || 0} rows affected, committed (${r.ms} ms).`
    return renderRows(r)
  }
}

function toolResult(text, isError) { return { content: [{ type: 'text', text }], isError } }

// One message of a transport (an object; arrays are batches). Returns the response (object / array) or null when nothing is to be sent back.
async function dispatch(server, msg, notify) {
  if (Array.isArray(msg)) {
    if (!msg.length) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'empty batch' } }
    const out = (await Promise.all(msg.map(m => dispatch(server, m, notify)))).filter(Boolean)
    return out.length ? out : null
  }
  if (!msg || typeof msg !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }
  if (typeof msg.method !== 'string') { // a response to a request of ours (there are none) is ignored, anything else is malformed
    return 'result' in msg || 'error' in msg ? null : { jsonrpc: '2.0', id: msg.id === undefined ? null : msg.id, error: { code: -32600, message: 'invalid request' } }
  }
  if (msg.id === undefined) return null // a notification: no answer
  const r = await server.handle(msg, notify)
  return { jsonrpc: '2.0', id: msg.id, ...(r.error ? { error: r.error } : { result: r.result === undefined ? {} : r.result }) }
}

// ---- stdio: one JSON-RPC message per line on stdin / stdout; stdout carries only protocol messages ----
function serveStdio(server, input = process.stdin, output = process.stdout) {
  return new Promise(done => {
    let buf = '', pending = 0, ended = false
    output.on('error', () => {}) // the client went away (EPIPE): nothing left to tell it
    const write = v => output.write(JSON.stringify(v) + '\n')
    const notify = (method, params) => write({ jsonrpc: '2.0', method, params })
    const finish = () => { if (ended && pending === 0) output.write('', () => done()) } // the last answer is out before the process exits (pipes on Windows)
    const line = l => {
      l = l.trim()
      if (!l) return
      let msg
      try { msg = JSON.parse(l) } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
      pending++ // tools/call can wait for a restart: other requests are not blocked
      dispatch(server, msg, notify).then(r => { if (r) write(r) }, e => write({ jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32603, message: e.message } })).finally(() => { pending--; finish() })
    }
    input.setEncoding('utf8')
    input.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); line(l) } })
    input.on('end', () => { if (buf.trim()) line(buf); buf = ''; ended = true; finish() })
  })
}

// ---- Streamable HTTP (POST /mcp on the Grid): a request, notification or batch in, application/json out; no sessions, no streaming ----
// grid.cjs has checked the Host header; X-Grid is not required (MCP clients do not send it). The guard against DNS rebinding and against a web
// page POSTing to localhost is here: a foreign Origin is refused, and the body must be application/json (a browser cannot send that cross-site
// without a CORS preflight, which this server never allows).
const MAX_BODY = 4 << 20
async function handleHttp(server, req, res) {
  const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(body === undefined ? undefined : JSON.stringify(body)) }
  const rpcErr = (code, status, message) => send(status, { jsonrpc: '2.0', id: null, error: { code, message } })
  const origin = req.headers.origin
  let foreign = req.headers['sec-fetch-site'] === 'cross-site'
  if (origin) { try { foreign = foreign || new URL(origin).host !== req.headers.host } catch { foreign = true } }
  if (foreign) return send(403, { error: 'cross-origin request refused' })
  if (req.method !== 'POST') { // GET would open a server-to-client stream, DELETE would end a session: neither exists here
    res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'use POST' }))
  }
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) return send(415, { error: 'Content-Type must be application/json' })
  const ver = req.headers['mcp-protocol-version']
  if (ver && !SUPPORTED.includes(ver)) return rpcErr(-32600, 400, `unsupported MCP-Protocol-Version ${ver} (supported: ${SUPPORTED.join(', ')})`)
  let n = 0; const chunks = []
  const body = await new Promise((ok, no) => {
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { no(new Error('too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')))
    req.on('error', no)
  }).catch(() => null)
  if (body === null) return rpcErr(-32600, 413, 'request too large')
  let msg
  try { msg = JSON.parse(body) } catch { return rpcErr(-32700, 400, 'parse error') }
  let out
  try { out = await dispatch(server, msg, null) } catch (e) { return rpcErr(-32603, 500, e.message) }
  if (out === null) { res.writeHead(202); return res.end() } // only notifications / responses came in
  return send(200, out)
}

// `grid mcp [-p port] [--wait secs]` (Go's flag package spelling: -p 7070, -p=7070, --p 7070)
function parseFlags(args, defPort) {
  const flags = { port: defPort, wait: 40 }
  for (let i = 0; i < args.length; i++) {
    const m = /^--?(p|wait)(?:=(.*))?$/.exec(args[i])
    if (!m) continue
    const v = m[2] !== undefined ? m[2] : args[++i]
    const n = parseInt(v, 10)
    if (Number.isNaN(n)) { process.stderr.write(`invalid value "${v}" for flag -${m[1]}\n`); process.exit(2) }
    if (m[1] === 'p') flags.port = n; else flags.wait = n
  }
  return flags
}

module.exports = { McpServer, serveStdio, handleHttp, parseFlags, dispatch, TOOLS, INSTRUCTIONS, SUPPORTED, renderRows, filterLines, matcher, shorten, oneLine }
