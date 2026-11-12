// Loads and validates grid.yaml, the way internal/config does in the Go runner.
const fs = require('fs'), path = require('path')
const YAML = require('yaml')
const { WIN, fileExists, resolvePath, readEnvFile, parseDuration } = require('./util.cjs')

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const RUNTIME_TYPES = { java: { homeVars: ['JAVA_HOME'], exe: 'java' }, node: { homeVars: [], exe: 'node' }, script: { homeVars: [], exe: '' } }

const str = v => v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
const strMap = (v, what) => {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} must be a mapping`)
  const o = {}; for (const [k, x] of Object.entries(v)) o[k] = str(x); return o
}
// `key: value` or `key: [a, b]`
const strList = v => v === undefined || v === null ? [] : Array.isArray(v) ? v.map(str) : str(v) ? [str(v)] : []
const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : null

function inferType(name) {
  const n = name.toLowerCase()
  for (const [p, t] of [['java', 'java'], ['jdk', 'java'], ['jre', 'java'], ['node', 'node']]) if (n.startsWith(p)) return t
  return 'script'
}

function normalizeRuntime(dir, name, raw) {
  raw = obj(raw) || {}
  const rt = { name, type: str(raw.type).trim().toLowerCase(), home: str(raw.home), bin: str(raw.bin), env: strMap(raw.env, 'env') }
  if (!rt.home.trim()) throw new Error("'home' is required")
  rt.home = resolvePath(dir, rt.home)
  if (!rt.type) rt.type = inferType(name)
  if (!RUNTIME_TYPES[rt.type]) throw new Error(`unknown type "${rt.type}" (use java, node or script)`)
  if (rt.bin) rt.bin = resolvePath(rt.home, rt.bin)
  return rt
}

function binDir(rt) {
  if (rt.bin) return rt.bin
  const bin = path.join(rt.home, 'bin')
  if ((rt.type === 'node' || rt.type === 'script') && !fs.existsSync(bin)) return rt.home // the Windows node zip keeps node.exe in the root
  return bin
}
function executable(rt) {
  const exe = RUNTIME_TYPES[rt.type].exe; if (!exe) return ''
  const dir = binDir(rt)
  if (WIN) { for (const ext of ['.exe', '.cmd', '.bat']) if (fileExists(path.join(dir, exe + ext))) return path.join(dir, exe + ext); return path.join(dir, exe + '.exe') }
  return path.join(dir, exe)
}
// returns an error message or ''
function checkRuntime(rt) {
  if (!fs.existsSync(rt.home)) return `home ${rt.home} not found`
  const exe = executable(rt)
  return exe && !fileExists(exe) ? `${exe} not found` : ''
}
function runtimeVars(rt) {
  const v = {}
  for (const k of RUNTIME_TYPES[rt.type].homeVars) v[k] = rt.home
  return Object.assign(v, rt.env)
}

function normalizeService(dir, name, raw) {
  raw = obj(raw) || {}
  const s = {
    name, group: str(raw.group), description: str(raw.description), type: str(raw.type).trim().toLowerCase(), command: str(raw.command),
    cwd: raw.cwd ? resolvePath(dir, str(raw.cwd)) : dir, shell: str(raw.shell), env: strMap(raw.env, 'env'), envFile: raw.env_file ? resolvePath(dir, str(raw.env_file)) : '',
    encoding: str(raw.encoding).toLowerCase(), dependsOn: strList(raw.depends_on), restart: str(raw.restart), maxRestarts: Number(raw.max_restarts) || 0,
    autostart: raw.autostart === true, stopTimeout: parseDuration(raw.stop_timeout), url: str(raw.url),
    changes: raw.changes === false ? false : true, changesIgnore: strList(raw.changes_ignore), color: raw.color !== false, runtime: strList(raw.runtime),
    ready: null, readyRegexp: null,
  }
  if (!s.type) s.type = 'custom'
  const sp = obj(raw.spring), nd = obj(raw.node), sc = obj(raw.script), jr = obj(raw.jar)
  switch (s.type) {
    case 'custom': if (!s.command.trim()) throw new Error("'command' is required"); break
    case 'spring-boot': {
      const o = sp || {}
      s.spring = { module: str(o.module), profiles: strList(o.profiles), jvmArgs: str(o.jvm_args), args: str(o.args), mode: str(o.mode) || 'package',
        skipTests: o.skip_tests === undefined || o.skip_tests === null ? true : o.skip_tests !== false, offline: o.offline === true, alwaysBuild: o.always_build === true }
      if (!['package', 'run'].includes(s.spring.mode)) throw new Error('spring.mode must be package or run')
      break
    }
    case 'node': {
      if (!nd || !str(nd.script).trim()) throw new Error("'node.script' is required (a script from package.json, e.g. dev)")
      s.node = { script: str(nd.script), args: str(nd.args), install: str(nd.install) || 'if-changed', packageManager: str(nd.package_manager) || 'auto' }
      if (!['if-changed', 'always', 'never'].includes(s.node.install)) throw new Error('node.install must be if-changed, always or never')
      if (!['auto', 'npm', 'yarn', 'pnpm'].includes(s.node.packageManager)) throw new Error('node.package_manager must be auto, npm, yarn or pnpm')
      break
    }
    case 'script':
      if (!sc || !str(sc.file).trim()) throw new Error("'script.file' is required")
      s.script = { file: str(sc.file), args: str(sc.args) }; break
    case 'jar':
      if (!jr || !str(jr.file).trim()) throw new Error("'jar.file' is required")
      s.jar = { file: str(jr.file), jvmArgs: str(jr.jvm_args), args: str(jr.args) }; break
    default: throw new Error(`unknown type "${s.type}" (use spring-boot, node, script, jar or custom)`)
  }
  if (s.encoding === '' || s.encoding === 'auto') s.encoding = 'auto'
  else if (s.encoding === 'utf-8' || s.encoding === 'utf8') s.encoding = 'utf-8'
  else if (s.encoding === 'cp1254' || s.encoding === 'windows-1254') s.encoding = 'cp1254'
  else throw new Error(`unknown encoding "${str(raw.encoding)}" (use auto, utf-8 or cp1254)`)
  if (s.restart === '' || s.restart === 'no' || s.restart === 'never') s.restart = 'no'
  else if (!['on-failure', 'always'].includes(s.restart)) throw new Error(`unknown restart policy "${s.restart}" (use no, on-failure or always)`)
  if (!(s.maxRestarts > 0)) s.maxRestarts = 5
  if (!(s.stopTimeout > 0)) s.stopTimeout = 10000
  const r = obj(raw.ready)
  if (raw.ready !== undefined && raw.ready !== null) {
    const port = Number(r && r.port) || 0, log = r ? str(r.log) : ''
    if (!port && !log) throw new Error("'ready' needs 'port' or 'log'")
    s.ready = { port, log, timeout: parseDuration(r.timeout) }
    if (log) { try { s.readyRegexp = new RegExp(log) } catch (e) { throw new Error('ready.log: ' + e.message) } }
    if (!(s.ready.timeout > 0)) s.ready.timeout = 180000
  }
  return s
}

function validateDeps(services) {
  const by = new Map(services.map(s => [s.name, s]))
  for (const s of services) for (const d of s.dependsOn) if (!by.has(d)) throw new Error(`service "${s.name}" depends on unknown service "${d}"`)
  const color = new Map()
  const visit = (name, trail) => {
    if (color.get(name) === 1) throw new Error(`dependency cycle: ${[...trail, name].join(' -> ')}`)
    if (color.get(name) === 2) return
    color.set(name, 1); for (const d of by.get(name).dependsOn) visit(d, [...trail, name]); color.set(name, 2)
  }
  for (const s of services) visit(s.name, [])
}

// Throws an Error with a readable message when the file is invalid.
function load(file) {
  const abs = path.resolve(file), dir = path.dirname(abs)
  let raw
  try { raw = YAML.parse(fs.readFileSync(abs, 'utf8')) } catch (e) { throw new Error(`${abs}: ${e.message}`) }
  raw = obj(raw) || {}
  const cfg = { name: str(raw.name), env: strMap(raw.env, 'env'), envFile: raw.env_file ? resolvePath(dir, str(raw.env_file)) : '', runtimes: new Map(), services: [], path: abs, dir }
  if (raw.runtimes !== undefined && raw.runtimes !== null) {
    if (!obj(raw.runtimes)) throw new Error(`${abs}: 'runtimes' must be a mapping of name -> runtime`)
    for (const [name, v] of Object.entries(raw.runtimes)) {
      try { cfg.runtimes.set(name, normalizeRuntime(dir, name, v)) } catch (e) { throw new Error(`runtime "${name}": ${e.message}`) }
    }
  }
  if (!obj(raw.services)) throw new Error(`${abs}: 'services' must be a mapping of name -> service`)
  for (const [name, v] of Object.entries(raw.services)) {
    if (!NAME_RE.test(name)) throw new Error(`${abs}: invalid service name "${name}": use letters, digits, '.', '_' or '-' (starting with a letter or digit)`)
    try {
      const s = normalizeService(dir, name, v), seen = {}
      for (const rn of s.runtime) {
        const rt = cfg.runtimes.get(rn); if (!rt) throw new Error(`unknown runtime "${rn}" (define it under 'runtimes')`)
        if (rt.type !== 'script') { if (seen[rt.type]) throw new Error(`runtimes "${seen[rt.type]}" and "${rn}" are both ${rt.type}; pick one`); seen[rt.type] = rn }
      }
      cfg.services.push(s)
    } catch (e) { throw new Error(`service "${name}": ${e.message}`) }
  }
  validateDeps(cfg.services)
  return cfg
}

// ---- child environment: OS env < color hints < global env files/env < runtimes < service env file < service env ----
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
function environ(cfg, sc) {
  const keys = new Map(), vals = new Map() // folded key -> original key / value
  const fold = k => WIN ? k.toUpperCase() : k
  const get = k => vals.get(fold(k))
  const set = (k, v) => { const f = fold(k); if (!keys.has(f)) keys.set(f, k); vals.set(f, v) }
  // values may reference ${OTHER}; applied in sorted key order; only that form is expanded so '$' survives in passwords
  const merge = o => { for (const k of Object.keys(o).sort()) set(k, o[k].replace(ENV_REF, (_, n) => get(n) || '')) }
  for (const [k, v] of Object.entries(process.env)) if (k) set(k, v)
  if (sc.color !== false) {
    for (const [k, v] of Object.entries({ FORCE_COLOR: '1', CLICOLOR_FORCE: '1', SPRING_OUTPUT_ANSI_ENABLED: 'ALWAYS', PY_COLORS: '1' })) if (get(k) === undefined) set(k, v)
  }
  const envFile = f => { try { return readEnvFile(f) } catch (e) { throw new Error('env_file: ' + e.message) } }
  if (cfg.envFile) merge(envFile(cfg.envFile))
  merge(cfg.env)
  const bins = []
  for (const name of sc.runtime || []) {
    const rt = cfg.runtimes.get(name); if (!rt) throw new Error(`unknown runtime "${name}"`)
    const err = checkRuntime(rt); if (err) throw new Error(`runtime ${name}: ${err}`)
    merge(runtimeVars(rt)); bins.push(binDir(rt))
  }
  if (bins.length) set('PATH', [...bins, get('PATH') || ''].join(path.delimiter))
  if (sc.envFile) merge(envFile(sc.envFile))
  merge(sc.env || {})
  const out = {}; for (const [f, v] of vals) out[keys.get(f)] = v
  return out
}

module.exports = { load, environ, binDir, checkRuntime, NAME_RE }
