// Project detection and folder browsing for the "New service" wizard (port of internal/detect, plus the runtime probe).
const fs = require('fs'), path = require('path')
const { execFile } = require('child_process')
const { WIN, fileExists, dirExists } = require('./util.cjs')

const exists = p => { try { fs.statSync(p); return true } catch { return false } }
const readText = p => { try { return fs.readFileSync(p, 'utf8').replace(/^﻿/, '') } catch { return null } }
const readdir = d => { try { return fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) } catch { return [] } }
// a directory entry that is a folder, or a link (symlink, junction) to one
const isDir = (dir, e) => e.isDirectory() || (e.isSymbolicLink() && dirExists(path.join(dir, e.name)))

// ---- a small, forgiving XML reader: enough for pom.xml (no namespaces, DTDs or entities beyond the basics) ----
function parseXml(src) {
  src = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
  const root = { name: '', children: [], text: '' }, stack = [root], re = /<(\/?)([^\s>/]+)([^>]*?)(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(src))) {
    if (m[5] !== undefined) { stack[stack.length - 1].text += m[5]; continue }
    const name = m[2].replace(/^.*:/, '')
    if (m[1]) { // closing tag
      if (stack.length < 2 || stack[stack.length - 1].name !== name) return null
      stack.pop()
    } else {
      const n = { name, children: [], text: '' }
      stack[stack.length - 1].children.push(n)
      if (!m[4]) stack.push(n)
    }
  }
  if (stack.length !== 1 || root.children.length !== 1) return null
  const dec = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  const fix = n => { n.text = dec(n.text).trim(); n.children.forEach(fix) }
  fix(root.children[0]); return root.children[0]
}
const kids = (n, name) => n ? n.children.filter(c => c.name === name) : []
const kid = (n, name) => kids(n, name)[0]
const kidText = (n, name) => { const k = kid(n, name); return k ? k.text : '' }
const via = (n, ...names) => names.reduce((list, nm) => list.flatMap(x => kids(x, nm)), [n])

function readPom(dir) {
  const src = readText(path.join(dir, 'pom.xml')); if (src === null) return null
  const x = parseXml(src); if (!x || x.name !== 'project') return null
  const props = kid(x, 'properties')
  return {
    artifactId: kidText(x, 'artifactId'), packaging: kidText(x, 'packaging'), parentArtifact: kidText(kid(x, 'parent'), 'artifactId'),
    modules: via(x, 'modules', 'module').map(n => n.text), java: [kidText(props, 'java.version'), kidText(props, 'maven.compiler.release'), kidText(props, 'maven.compiler.source')],
    plugins: via(x, 'build', 'plugins', 'plugin').map(n => kidText(n, 'artifactId')), deps: via(x, 'dependencies', 'dependency').map(n => kidText(n, 'artifactId')),
  }
}
function javaVersion(p) {
  for (let v of p.java) { v = v.trim().replace(/^1\./, ''); if (v && !v.includes('${')) return v }
  return ''
}
const hasBootPlugin = p => p.plugins.includes('spring-boot-maven-plugin')
const usesBoot = p => p.parentArtifact === 'spring-boot-starter-parent' || hasBootPlugin(p) || p.deps.some(d => d.startsWith('spring-boot-starter'))

const PKG_RE = /^\s*package\s+([\w.]+)/m
// the @SpringBootApplication class under src/main/{java,kotlin} (first in name order, at most 5000 files looked at)
function mainClass(dir) {
  let seen = 0
  for (const src of ['src/main/java', 'src/main/kotlin']) {
    let found = ''
    const walk = d => {
      for (const e of readdir(d)) {
        if (found || seen > 5000) return
        const p = path.join(d, e.name)
        if (e.isDirectory()) { walk(p); continue }
        const ext = path.extname(e.name)
        if (ext !== '.java' && ext !== '.kt') continue
        seen++
        const t = readText(p)
        if (t === null || !t.includes('@SpringBootApplication')) continue
        const pk = PKG_RE.exec(t)
        found = (pk ? pk[1] + '.' : '') + e.name.slice(0, -ext.length)
      }
    }
    walk(path.join(dir, ...src.split('/')))
    if (found) return found
  }
  return ''
}

const PROP_PORT = /^\s*server\.port\s*[=:]\s*(?:\$\{[^:}]*:)?(\d+)/m, YML_PORT = /^\s+port:\s*["']?(?:\$\{[^:}]*:)?(\d+)/, PROFILE_RE = /^application-([\w.-]+)\.(properties|ya?ml)$/
function springResources(dir) {
  const res = path.join(dir, 'src', 'main', 'resources'); let port = 0
  const props = readText(path.join(res, 'application.properties'))
  if (props !== null) { const m = PROP_PORT.exec(props); if (m) port = Number(m[1]) }
  for (const name of ['application.yml', 'application.yaml']) {
    if (port) break
    const t = readText(path.join(res, name)); if (t === null) continue
    let inServer = false
    for (const line of t.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue
      if (!line.startsWith(' ') && !line.startsWith('\t')) { inServer = line.startsWith('server:'); continue }
      if (inServer) { const m = YML_PORT.exec(line); if (m) { port = Number(m[1]); break } }
    }
  }
  if (!port) port = 8080
  const profiles = []
  for (const e of readdir(res)) { const m = PROFILE_RE.exec(e.name); if (m && !profiles.includes(m[1])) profiles.push(m[1]) }
  return [port, profiles]
}

function spring(root) {
  const rp = readPom(root); if (!rp) return null
  const s = { artifactId: rp.artifactId, javaVersion: javaVersion(rp), wrapper: exists(path.join(root, 'mvnw')) || exists(path.join(root, 'mvnw.cmd')), modules: [] }
  const walk = (dir, rel, p, depth) => {
    if (p.packaging !== 'pom') {
      const main = mainClass(dir)
      if (main || (usesBoot(p) && hasBootPlugin(p))) {
        const m = { path: rel, artifactId: p.artifactId }
        if (main) m.mainClass = main
        const [port, profiles] = springResources(dir); m.port = port
        if (profiles.length) m.profiles = profiles
        s.modules.push(m)
      }
    }
    if (depth >= 3) return
    for (const mod of p.modules) {
      const cd = path.join(dir, ...mod.split('/')), cp = readPom(cd)
      if (!cp) continue
      if (!s.javaVersion) s.javaVersion = javaVersion(cp)
      walk(cd, path.posix.join(rel, mod), cp, depth + 1)
    }
  }
  walk(root, '', rp, 0)
  if (!s.javaVersion) delete s.javaVersion
  return s
}

// ---- node ----
const PORT_ARG = /(?:--port[= ]|-p\s+)(\d{2,5})/
function guessPort(cmd) {
  const m = PORT_ARG.exec(cmd); if (m) return Number(m[1])
  if (cmd.includes('vite')) return 5173
  if (cmd.includes('ng serve')) return 4200
  if (cmd.includes('next dev') || cmd.includes('react-scripts start')) return 3000
  return 0
}
const rank = s => s === 'dev' ? 0 : s === 'start' ? 1 : s === 'serve' ? 2 : ['start:dev', 'dev:local', 'start:local'].includes(s) ? 3 : 10
function node(dir) {
  const t = readText(path.join(dir, 'package.json')); if (t === null) return null
  let pj; try { pj = JSON.parse(t) } catch { return null }
  if (!pj || typeof pj !== 'object') return null
  const commands = {}; if (pj.scripts && typeof pj.scripts === 'object') for (const [k, v] of Object.entries(pj.scripts)) if (typeof v === 'string') commands[k] = v
  const n = { name: typeof pj.name === 'string' ? pj.name : '', scripts: [], commands, packageManager: 'npm', ports: {}, installed: exists(path.join(dir, 'node_modules')) }
  const ev = pj.engines && typeof pj.engines.node === 'string' ? pj.engines.node : ''
  const nvm = readText(path.join(dir, '.nvmrc'))
  const nv = nvm !== null ? nvm.trim() : ev; if (nv) n.nodeVersion = nv
  if (exists(path.join(dir, 'pnpm-lock.yaml'))) n.packageManager = 'pnpm'; else if (exists(path.join(dir, 'yarn.lock'))) n.packageManager = 'yarn'
  for (const [name, cmd] of Object.entries(commands)) { n.scripts.push(name); const p = guessPort(cmd); if (p > 0) n.ports[name] = p }
  n.scripts.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
  return n
}

// ---- scripts and jars ----
const SCRIPT_EXT = ['.bat', '.cmd', '.ps1', '.sh', '.py']
const scripts = dir => readdir(dir).filter(e => !isDir(dir, e) && SCRIPT_EXT.includes(path.extname(e.name).toLowerCase()) && !e.name.startsWith('mvnw') && !e.name.startsWith('gradlew')).map(e => e.name)
function jars(dir) {
  const out = []
  for (const sub of ['', 'target', 'build/libs']) {
    const d = path.join(dir, ...sub.split('/').filter(Boolean))
    for (const e of readdir(d)) {
      const n = e.name; if (isDir(d, e) || !n.endsWith('.jar') || n.startsWith('original-')) continue
      const base = n.slice(0, -4)
      if (['-sources', '-javadoc', '-tests', '-plain'].some(x => base.endsWith(x))) continue
      out.push(path.posix.join(sub, n))
    }
  }
  return out
}

// Inspects a project folder.
function detectDir(dir) {
  const r = { dir, exists: false, suggested: 'custom' }
  if (!dirExists(dir)) return r
  r.exists = true
  const sp = spring(dir), nd = node(dir), sc = scripts(dir), jr = jars(dir)
  if (sp) r.spring = sp
  if (nd) r.node = nd
  if (sc.length) r.scripts = sc
  if (jr.length) r.jars = jr
  if (sp && sp.modules.length) r.suggested = 'spring-boot'
  else if (nd && nd.scripts.length) r.suggested = 'node'
  else if (sc.length) r.suggested = 'script'
  else if (jr.length) r.suggested = 'jar'
  return r
}

// ---- folder browsing ----
const SKIP_DIRS = new Set(['node_modules', 'target', 'build', 'dist', 'out', 'bin', 'obj'])
// drive letters that exist (Windows only)
function roots() {
  if (!WIN) return []
  const out = []
  for (let c = 65; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { fs.statSync(d); out.push(d) } catch {} }
  return out
}
const cmpLower = (a, b) => { a = a.toLowerCase(); b = b.toLowerCase(); return a < b ? -1 : a > b ? 1 : 0 }

// The sub-folders of dir (Maven and Node projects marked) and its *.yml / *.yaml files. Never reads file contents.
function listDir(dir) {
  const l = { path: dir, dirs: [], files: [] }
  const rs = roots(); if (rs.length) l.roots = rs
  const parent = path.dirname(dir); if (parent !== dir) l.parent = parent
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { l.error = e.code ? `${e.code}: cannot read ${dir}` : e.message; return l }
  for (const e of entries) {
    const n = e.name, ext = path.extname(n).toLowerCase(), dirLike = isDir(dir, e)
    if (!dirLike && (ext === '.yml' || ext === '.yaml') && !n.startsWith('.')) {
      if (e.isFile() || e.isSymbolicLink()) l.files.push(n)
      continue
    }
    if (!dirLike || n.startsWith('.') || n.startsWith('$') || SKIP_DIRS.has(n)) continue
    const en = { name: n }, p = path.join(dir, n)
    if (exists(path.join(p, 'pom.xml'))) en.kind = 'maven'
    else if (exists(path.join(p, 'package.json'))) en.kind = 'node'
    l.dirs.push(en)
  }
  l.files.sort(cmpLower); l.dirs.sort((a, b) => cmpLower(a.name, b.name))
  return l
}

// ---- runtime probe ----
function listTools(dir) {
  const out = [], seen = new Set()
  for (const e of readdir(dir)) {
    const p = path.join(dir, e.name); let st; try { st = fs.statSync(p) } catch { continue }
    if (st.isDirectory()) continue
    let name = e.name
    if (WIN) {
      const ext = path.extname(name).toLowerCase()
      if (!['.exe', '.cmd', '.bat', '.ps1'].includes(ext)) continue
      name = name.slice(0, -ext.length)
    } else if (!(st.mode & 0o111)) continue
    if (seen.has(WIN ? name.toLowerCase() : name)) continue
    seen.add(WIN ? name.toLowerCase() : name); out.push(name)
    if (out.length === 12) break
  }
  return out
}

// Runs `java -version` / `node --version` and resolves with the first line that looks like a version ('' on failure).
function runtimeVersion(exe, type, vars) {
  const arg = type === 'java' ? '-version' : type === 'node' ? '--version' : ''
  if (!arg) return Promise.resolve('')
  return new Promise(ok => {
    const env = { ...process.env, ...vars }, done = (e, so, se) => {
      for (let line of `${so || ''}\n${se || ''}`.split('\n')) {
        line = line.trim()
        if (line && !line.startsWith('Picked up') && /\d+(\.\d+)+/.test(line)) return ok(line)
      }
      ok('')
    }
    const opts = { env, timeout: 15000, windowsHide: true }
    try {
      // .cmd / .bat cannot be started directly (Node refuses since 2024); they go through cmd.exe
      if (WIN && /\.(cmd|bat)$/i.test(exe)) execFile(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `""${exe}" ${arg}"`], { ...opts, windowsVerbatimArguments: true }, done)
      else execFile(exe, [arg], opts, done)
    } catch (e) { ok('') }
  })
}

module.exports = { detectDir, listDir, roots, listTools, runtimeVersion }
