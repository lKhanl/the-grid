// Typed services: derives the build and run commands every time a service starts (port of config/plan.go).
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const { WIN, fileExists } = require('./util.cjs')

const BUILD_STAMP = '.grid-build', INSTALL_STAMP = '.grid-install'

const quote = s => s === '' || /[ \t&()\[\]{}^=;!'+,`~%$]/.test(s) ? '"' + s + '"' : s
const join = (...parts) => parts.map(p => String(p || '').trim()).filter(Boolean).join(' ')
const fromSlash = p => p.split('/').join(path.sep)
const mtime = p => { try { return fs.statSync(p).mtimeMs } catch { return 0 } }
const pad = n => String(n).padStart(2, '0')
const clock = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

// the project's wrapper is preferred, like IntelliJ does
function mavenCmd(root) {
  if (WIN) return fileExists(path.join(root, 'mvnw.cmd')) ? quote(path.join(root, 'mvnw.cmd')) : 'mvn'
  return fileExists(path.join(root, 'mvnw')) ? 'sh ' + quote(path.join(root, 'mvnw')) : 'mvn'
}

// newest runnable jar in dir (skips sources, javadoc, tests, plain)
function findBootJar(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { throw new Error(`no build output: ${dir} not found`) }
  const list = []
  for (const e of entries) {
    if (e.isDirectory() || !e.name.endsWith('.jar')) continue
    const base = e.name.slice(0, -4)
    if (['-sources', '-javadoc', '-tests', '-plain'].some(x => base.endsWith(x))) continue
    list.push({ p: path.join(dir, e.name), m: mtime(path.join(dir, e.name)) })
  }
  if (!list.length) throw new Error(`no jar in ${dir}; is <packaging> jar and spring-boot-maven-plugin set up?`)
  return list.sort((a, b) => b.m - a.m)[0].p
}

// Nothing that goes into the jar (src/ folders, pom.xml files, .mvn/) changed since the last build Grid ran.
function buildIsFresh(root, stamp) {
  const built = mtime(stamp); if (!built) return [false, '']
  let newest = 0
  const walk = (dir, rel) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory() && ['target', '.git', 'node_modules', '.idea', '.gradle', '.vscode'].includes(e.name)) continue
      const r = rel ? rel + '/' + e.name : e.name, full = path.join(dir, e.name)
      const counts = e.name === 'pom.xml' || r === 'src' || r === '.mvn' || r.startsWith('.mvn/') || r.startsWith('src/') || r.includes('/src/') || r.endsWith('/src')
      if (counts) newest = Math.max(newest, mtime(full))
      if (e.isDirectory()) walk(full, r)
    }
  }
  walk(root, '')
  if (newest > built) return [false, '']
  return [true, `build skipped: nothing changed in src/ or pom.xml since the last build at ${clock(new Date(built))} ("Always rebuild" forces it)`]
}

function springPlan(s, check) {
  const o = s.spring, root = s.cwd, mod = o.module ? path.join(root, ...o.module.split('/')) : root
  const mvn = mavenCmd(root)
  let flags = '-B -ntp -Dstyle.color=always'; if (o.offline) flags += ' -o'
  const profiles = o.profiles.join(',')
  if (o.mode === 'run') {
    const extra = []
    if (profiles) extra.push('-Dspring-boot.run.profiles=' + profiles)
    if (o.jvmArgs) extra.push('"-Dspring-boot.run.jvmArguments=' + o.jvmArgs + '"')
    if (o.args) extra.push('"-Dspring-boot.run.arguments=' + o.args + '"')
    const cmd = join(mvn, flags, 'spring-boot:run', extra.join(' '))
    return { runPreview: cmd, run: () => ({ cmd, cwd: mod }) }
  }
  // -Dmaven.test.skip also skips compiling the tests (-DskipTests only skips running them)
  let build = join(mvn, flags, o.skipTests ? '-Dmaven.test.skip=true' : '', 'package')
  if (o.module) build += ' -pl ' + quote(o.module) + ' -am'
  const runFor = jar => join('java', o.jvmArgs, '-jar', quote(jar), profiles ? '--spring.profiles.active=' + profiles : '', o.args)
  // A stamp records when the last successful build started; the jar's own date can't be used (reproducible builds).
  const stamp = path.join(mod, 'target', BUILD_STAMP)
  let buildCmd = build, note = '', afterBuild = null
  if (check && !o.alwaysBuild) {
    const started = new Date()
    afterBuild = () => {
      try { fs.mkdirSync(path.dirname(stamp), { recursive: true }); fs.writeFileSync(stamp, started.toISOString()); fs.utimesSync(stamp, started, started) } catch {}
    }
    let hasJar = true; try { findBootJar(path.join(mod, 'target')) } catch { hasJar = false }
    if (hasJar) { const [fresh, why] = buildIsFresh(root, stamp); if (fresh) { buildCmd = ''; note = why; afterBuild = null } }
  }
  return {
    build: buildCmd, note, afterBuild, buildCwd: root, buildPreview: build, runPreview: runFor(path.join(o.module, 'target', '*.jar')),
    run: () => ({ cmd: runFor(findBootJar(path.join(mod, 'target'))), cwd: mod }),
  }
}

const packageManager = (dir, configured) => configured && configured !== 'auto' ? configured
  : fileExists(path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : fileExists(path.join(dir, 'yarn.lock')) ? 'yarn' : 'npm'

function depsHash(dir) {
  const h = crypto.createHash('sha256')
  for (const f of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']) {
    try { const b = fs.readFileSync(path.join(dir, f)); h.update(f); h.update(b) } catch {}
  }
  return h.digest('hex')
}

function nodePlan(s, check) {
  const o = s.node, dir = s.cwd, pm = packageManager(dir, o.packageManager)
  let run = join(pm, 'run', o.script)
  if (o.args) run += (pm === 'npm' ? ' -- ' : ' ') + o.args
  const p = { runPreview: run, run: () => ({ cmd: run, cwd: dir }) }
  const install = pm + ' install', stamp = path.join(dir, 'node_modules', INSTALL_STAMP)
  if (o.install === 'always') p.buildPreview = install
  else if (o.install === 'if-changed') p.buildPreview = install + '   (only when package.json or the lock file changed)'
  else return p
  if (!check) return p
  let need = o.install === 'always'
  if (!need) { let old = null; try { old = fs.readFileSync(stamp, 'utf8').trim() } catch {} need = old !== depsHash(dir) }
  if (need) {
    Object.assign(p, { build: install, buildCwd: dir })
    p.afterBuild = () => { try { fs.mkdirSync(path.dirname(stamp), { recursive: true }); fs.writeFileSync(stamp, depsHash(dir)) } catch {} }
  }
  return p
}

function scriptPlan(s) {
  const o = s.script, dir = s.cwd
  const file = path.isAbsolute(o.file) ? o.file : path.join(dir, fromSlash(o.file))
  let cmd
  switch (path.extname(file).toLowerCase()) {
    case '.bat': case '.cmd': cmd = join(quote(file), o.args); break
    case '.ps1': cmd = join(WIN ? 'powershell' : 'pwsh', '-NoLogo -NoProfile -ExecutionPolicy Bypass -File', quote(file), o.args); break
    case '.sh': cmd = join('bash', quote(file), o.args); break
    case '.py': cmd = join(WIN ? 'py' : 'python3', quote(file), o.args); break
    case '.js': case '.mjs': case '.cjs': cmd = join('node', quote(file), o.args); break
    default: cmd = join(quote(file), o.args)
  }
  return { runPreview: cmd, run: () => { if (!fileExists(file)) throw new Error(`script ${file} not found`); return { cmd, cwd: dir } } }
}

// minimal filepath.Glob: * ? [...] in any path segment
function glob(pattern) {
  const root = path.parse(pattern).root, segs = pattern.slice(root.length).split(/[\\/]+/).filter(Boolean)
  let cur = [root || '.']
  segs.forEach((seg, i) => {
    const next = []
    if (!/[*?\[]/.test(seg)) { for (const c of cur) { const p = path.join(c, seg); if (fs.existsSync(p)) next.push(p) } }
    else {
      const re = new RegExp('^' + seg.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '[^/\\\\]') + '$')
      for (const c of cur) { let names = []; try { names = fs.readdirSync(c) } catch {} for (const n of names) if (re.test(n)) next.push(c === '.' ? n : path.join(c, n)) }
    }
    cur = next
  })
  return cur
}
function newestFile(paths) {
  let best = '', bm = -1
  for (const p of paths) { try { const st = fs.statSync(p); if (!st.isDirectory() && st.mtimeMs > bm) { best = p; bm = st.mtimeMs } } catch {} }
  return best
}

function jarPlan(s) {
  const o = s.jar, dir = s.cwd, pattern = path.isAbsolute(o.file) ? o.file : path.join(dir, fromSlash(o.file))
  const runFor = jar => join('java', o.jvmArgs, '-jar', quote(jar), o.args)
  return {
    runPreview: runFor(o.file),
    run: () => {
      let jar = pattern
      if (/[*?\[]/.test(pattern)) { jar = newestFile(glob(pattern)); if (!jar) throw new Error(`no jar matches ${pattern}`) }
      else if (!fileExists(jar)) throw new Error(`jar ${jar} not found`)
      return { cmd: runFor(jar), cwd: dir }
    },
  }
}

// skipBuild runs without building; check=false is the cheap preview for the UI
function plan(s, skipBuild, check = true) {
  let p
  switch (s.type) {
    case 'spring-boot': p = springPlan(s, check && !skipBuild); break
    case 'node': p = nodePlan(s, check && !skipBuild); break
    case 'script': p = scriptPlan(s); break
    case 'jar': p = jarPlan(s); break
    default: { const cmd = s.command; p = { runPreview: cmd, run: () => ({ cmd, cwd: s.cwd }) } }
  }
  if (skipBuild) { p.build = ''; p.afterBuild = null }
  return p
}

module.exports = { plan, quote }
