// Saved database connections: ~/.grid/connections.json (same file and format as the Go version, port of internal/db/store.go + dsn.go parts),
// connection validation, and tnsnames.ora reading. Fields this code does not know (the Go version is older than the UI) are kept as they are.
const fs = require('fs'), os = require('os'), path = require('path')

const MCP_OFF = 'off', MCP_READONLY = 'readonly', MCP_READWRITE = 'readwrite'
const KINDS = ['oracle', 'postgres']
const SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,63}$/
// the fields of a connection in file order; the others are kept untouched. [name, empty-means-omit]
const FIELDS = [['name'], ['kind'], ['mode', 1], ['host', 1], ['port', 1], ['service', 1], ['sid', 1], ['tns', 1], ['tnsAdmin', 1], ['database', 1], ['sslMode', 1],
  ['user'], ['password', 1], ['autoCommit'], ['mcp'], ['group', 1]]

const str = v => (v === undefined || v === null ? '' : String(v))
const same = (a, b) => a.toLowerCase() === b.toLowerCase()

// Fills defaults and validates; returns a new connection object holding the known fields only (the caller keeps the unknown ones).
function normalize(input) {
  const c = {
    name: str(input.name).trim(), kind: str(input.kind), mode: str(input.mode), host: str(input.host).trim(), port: Number(input.port) || 0,
    service: str(input.service).trim(), sid: str(input.sid).trim(), tns: str(input.tns).trim(), tnsAdmin: str(input.tnsAdmin).trim(),
    database: str(input.database).trim(), sslMode: str(input.sslMode), user: str(input.user).trim(), password: str(input.password),
    autoCommit: !!input.autoCommit, mcp: str(input.mcp), group: str(input.group).trim(),
  }
  if (!NAME_RE.test(c.name)) throw new Error('name: letters, digits, space, _ . - (1-64 characters, starting with a letter or digit)')
  if (!c.kind) c.kind = 'oracle'
  if (!KINDS.includes(c.kind)) throw new Error(`kind "${c.kind}" is not supported (${KINDS.join(', ')})`)
  if (c.kind === 'oracle') {
    if (!c.mode) c.mode = 'service'
    c.database = c.sslMode = ''
    switch (c.mode) {
      case 'service': if (!c.host || !c.service) throw new Error('host and service name are required'); break
      case 'sid': if (!c.host || !c.sid) throw new Error('host and SID are required'); break
      case 'tns': if (!c.tns) throw new Error('a TNS descriptor or alias is required'); break
      default: throw new Error(`mode "${c.mode}": use service, sid or tns`)
    }
    if (c.mode !== 'tns' && !c.port) c.port = 1521
  } else {
    c.mode = c.service = c.sid = c.tns = c.tnsAdmin = ''
    if (!c.host || !c.database) throw new Error('host and database are required')
    if (!c.port) c.port = 5432
    if (!c.sslMode) c.sslMode = 'prefer'
    if (!SSL_MODES.includes(c.sslMode)) throw new Error(`SSL mode "${c.sslMode}": use ${SSL_MODES.join(', ')}`)
  }
  if (!c.user) throw new Error('user is required')
  if (!c.mcp) c.mcp = MCP_READONLY
  else if (![MCP_OFF, MCP_READONLY, MCP_READWRITE].includes(c.mcp)) throw new Error(`mcp "${c.mcp}": use off, readonly or readwrite`)
  return c
}

// the connection's address for display: "db:1521/ORCLPDB1", "db:5432/orders", "h:1521 SID X", "TNS alias"
function where(c) {
  if (c.kind === 'postgres') return `${c.host}:${c.port}/${c.database}`
  if (c.mode === 'sid') return `${c.host}:${c.port} SID ${c.sid}`
  if (c.mode === 'tns') return 'TNS ' + c.tns
  return `${c.host}:${c.port}/${c.service}`
}

// as the file holds it: known fields in order (empty optional ones left out), then whatever else the entry had
function toRaw(c, extra) {
  const o = {}
  for (const [k, omit] of FIELDS) {
    const v = c[k]
    if (omit && (v === '' || v === 0 || v === undefined)) continue
    o[k] = v
  }
  return { ...o, ...extra }
}
const unknownFields = raw => { const x = {}; for (const k of Object.keys(raw || {})) if (!FIELDS.some(f => f[0] === k)) x[k] = raw[k]; return x }

function openStore(dir) {
  const file = path.join(dir, 'connections.json')
  let top = {}, conns = [] // conns: { c: normalized, extra: unknown fields }
  const wrap = raw => { // an entry the file holds; one that does not validate is kept as it is (it shows up and fails when used)
    let c; try { c = normalize(raw) } catch { c = { ...raw, name: str(raw.name), kind: str(raw.kind), user: str(raw.user), password: str(raw.password), mcp: str(raw.mcp) || MCP_READONLY, autoCommit: !!raw.autoCommit } }
    return { c, extra: unknownFields(raw), invalid: undefined }
  }
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (d && typeof d === 'object' && !Array.isArray(d)) { top = d; if (Array.isArray(d.connections)) conns = d.connections.filter(x => x && typeof x === 'object').map(wrap) }
  } catch { /* a missing or corrupt file means "none" */ }

  function save() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ ...top, connections: conns.map(e => toRaw(e.c, e.extra)) }, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }
  const find = name => conns.findIndex(e => same(e.c.name, name))
  const snapshot = e => ({ ...e.c })

  return {
    file,
    // in the order of the file (the UI lets the user arrange them)
    list: () => conns.map(snapshot),
    get(name) { const i = find(name); return i < 0 ? undefined : snapshot(conns[i]) },
    // Adds a connection, or replaces the one called old (rename allowed). An empty password keeps the stored one.
    put(old, input) {
      const c = normalize(input)
      let idx = -1
      conns.forEach((e, i) => {
        if (old && same(e.c.name, old)) idx = i
        else if (same(e.c.name, c.name)) throw new Error(`a connection called "${c.name}" already exists`)
      })
      if (old && idx < 0) throw new Error(`unknown connection "${old}"`)
      if (idx >= 0) {
        const prev = conns[idx]
        if (!c.password) c.password = prev.c.password
        if (input.group === undefined) c.group = str(prev.c.group) // an older client does not know groups
        conns[idx] = { c, extra: prev.extra }
      } else conns.push({ c, extra: {} })
      save()
      return { ...c }
    },
    del(name) {
      const i = find(name)
      if (i < 0) throw new Error(`unknown connection "${name}"`)
      conns.splice(i, 1); save()
    },
    // The UI's drag & drop: the connections in the order of names (those not mentioned follow in their old order) and, per name, a new group
    // ("" = no group).
    order(names, groups) {
      if (!Array.isArray(names)) throw new Error('expected names')
      const out = [], seen = new Set()
      for (const n of names) { const i = find(String(n)); if (i >= 0 && !seen.has(i)) { seen.add(i); out.push(conns[i]) } }
      conns.forEach((e, i) => { if (!seen.has(i)) out.push(e) })
      for (const [n, g] of Object.entries(groups && typeof groups === 'object' ? groups : {})) {
        const e = out.find(x => same(x.c.name, n)); if (e) e.c.group = str(g).trim()
      }
      conns = out; save()
    },
    // Re-reads the file after it was edited outside the Grid. A missing file means none; a corrupt or invalid one is an error and changes nothing.
    // Returns the names that were added, removed or changed.
    reload() {
      let d = {}
      try { d = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
        if (e.code !== 'ENOENT') throw new Error(`${file}: ${e.message}`)
      }
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(`${file}: expected an object`)
      const raws = Array.isArray(d.connections) ? d.connections : [], next = [], seen = new Set()
      for (const raw of raws) {
        let c
        try { c = normalize(raw || {}) } catch (e) { throw new Error(`connection "${str(raw && raw.name)}": ${e.message}`) }
        if (seen.has(c.name.toLowerCase())) throw new Error(`two connections are called "${c.name}"`)
        seen.add(c.name.toLowerCase())
        next.push({ c, extra: unknownFields(raw) })
      }
      const old = new Map(conns.map(e => [e.c.name.toLowerCase(), e.c])), added = [], changed = []
      for (const { c } of next) {
        const prev = old.get(c.name.toLowerCase())
        if (!prev) added.push(c.name)
        else if (FIELDS.some(([k]) => prev[k] !== c[k])) changed.push(c.name)
        old.delete(c.name.toLowerCase())
      }
      const removed = [...old.values()].map(c => c.name)
      top = d; conns = next
      return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
    },
  }
}

// ---- tnsnames.ora ----

// alias -> "(DESCRIPTION=...)" for every entry. Understands comments (#), several aliases for one entry ("A, B = (...)"), nested parentheses and
// IFILE=other.ora includes (resolved against `dir`). Keys keep the spelling of the file.
function parseTNSNames(text, dir, depth = 0) {
  const s = text.split('\n').map(l => { const i = l.indexOf('#'); return i >= 0 ? l.slice(0, i) : l }).join('\n')
  const out = new Map()
  let i = 0
  while (i < s.length) {
    const eq = s.indexOf('=', i)
    if (eq < 0) break
    const names = s.slice(i, eq).trim()
    let j = eq + 1
    while (j < s.length && ' \t\n\r'.includes(s[j])) j++
    if (j >= s.length || s[j] !== '(') {
      if (/^ifile$/i.test(names) && dir && depth < 5) { // IFILE = path
        let e = s.indexOf('\n', j); if (e < 0) e = s.length
        const inc = s.slice(j, e).trim().replace(/^["']|["']$/g, '')
        try { for (const [k, v] of parseTNSNames(fs.readFileSync(path.resolve(dir, inc), 'utf8'), path.dirname(path.resolve(dir, inc)), depth + 1)) out.set(k, v) } catch { /* unreadable include */ }
        i = e; continue
      }
      i = j; continue
    }
    let depthP = 0, k = j
    for (; k < s.length; k++) {
      if (s[k] === '(') depthP++
      else if (s[k] === ')') { depthP--; if (depthP === 0) { k++; break } }
    }
    const desc = s.slice(j, k).split(/\s+/).join('')
    for (const n of names.split(',')) { const a = n.trim(); if (a) out.set(a, desc) }
    i = k
  }
  return out
}

// The tnsnames.ora a path points at: the file itself, or the one in that folder.
const tnsFile = p => { try { return fs.statSync(p).isDirectory() ? path.join(p, 'tnsnames.ora') : p } catch { return p } }

// where an alias is looked for: the connection's own path, $TNS_ADMIN, $ORACLE_HOME/network/admin
function tnsDirs(admin) {
  const dirs = []
  if (admin) dirs.push(admin)
  if (process.env.TNS_ADMIN) dirs.push(process.env.TNS_ADMIN)
  if (process.env.ORACLE_HOME) dirs.push(path.join(process.env.ORACLE_HOME, 'network', 'admin'))
  return dirs
}
function readTNS(file) { return parseTNSNames(fs.readFileSync(file, 'utf8'), path.dirname(file)) }

// the aliases of a tnsnames.ora (file or folder) for the form's picker
function listTNSAliases(p) {
  p = String(p || '').trim()
  if (!p) throw new Error('a path is required')
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1))
  const f = tnsFile(p)
  let text
  try { text = fs.readFileSync(f, 'utf8') } catch (e) { throw new Error(e.code === 'ENOENT' ? `${f} not found` : `${f}: ${e.message}`) }
  return [...parseTNSNames(text, path.dirname(f)).keys()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
}

function lookupTNS(alias, admin) {
  const dirs = tnsDirs(admin)
  if (!dirs.length) throw new Error(`TNS alias "${alias}": set the TNS folder on the connection or the TNS_ADMIN environment variable`)
  const want = alias.toUpperCase()
  for (const d of dirs) {
    let m; try { m = readTNS(tnsFile(d)) } catch { continue }
    const entries = [...m.entries()]
    const hit = entries.find(([k]) => k.toUpperCase() === want) || entries.find(([k]) => k.toUpperCase().startsWith(want + '.')) // "ORCL" finds "ORCL.WORLD"
    if (hit) return hit[1]
  }
  throw new Error(`TNS alias "${alias}" not found in tnsnames.ora (looked in ${dirs.map(tnsFile).join(', ')})`)
}

module.exports = { openStore, normalize, toRaw, where, parseTNSNames, lookupTNS, listTNSAliases, MCP_OFF, MCP_READONLY, MCP_READWRITE, KINDS }
