// Editing grid.yaml from the UI (port of internal/config/edit.go).
//
// The file is edited as a YAML document tree, so keys and comments the forms do not touch survive. Values that already
// match what the form sent are not rewritten at all. Before a write the result is checked with the normal loader; the
// previous file is kept as grid.yaml.bak and the new one arrives through grid.yaml.tmp + rename.
//
// The library re-prints the whole document (it normalizes `[ a ]`, `# comment` spacing and so on), so the printed text is
// merged line by line with the original: every line that only differs in such whitespace is taken from the original text.
const fs = require('fs'), path = require('path')
const YAML = require('yaml')
const { Scalar, YAMLMap, YAMLSeq, Pair, isMap, isSeq, isScalar } = YAML
const { load: loadConfig, NAME_RE, RUNTIME_TYPES, inferType, normalizeService } = require('./config.cjs')
const { plan } = require('./plan.cjs')

const SERVICE_ORDER = ['group', 'description', 'type', 'cwd', 'command', 'spring', 'node', 'script', 'jar', 'shell', 'runtime', 'env', 'env_file',
  'encoding', 'depends_on', 'ready', 'restart', 'max_restarts', 'autostart', 'stop_timeout', 'url', 'changes', 'changes_ignore']
const RUNTIME_ORDER = ['type', 'home', 'bin', 'env']
const SPRING_ORDER = ['module', 'profiles', 'jvm_args', 'args', 'mode', 'skip_tests', 'offline', 'always_build']
const NODE_ORDER = ['script', 'args', 'install', 'package_manager']
const SCRIPT_ORDER = ['file', 'args']
const JAR_ORDER = ['file', 'jvm_args', 'args']

// ---- small helpers ----
const str = v => v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
const strList = v => v === undefined || v === null ? [] : Array.isArray(v) ? v.map(str) : str(v) ? [str(v)] : []
const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : null
const nz = s => { s = str(s); return s === '' ? undefined : s } // empty string = key absent
const keyOf = p => isScalar(p.key) ? str(p.key.value) : str(p.key)
const find = (m, k) => m.items.findIndex(p => keyOf(p) === k)
const nodeJS = (doc, n) => n === undefined || n === null ? undefined : isScalar(n) ? n.value : n.toJS(doc)
const fail = msg => { throw Object.assign(new Error(msg), { badRequest: true }) }

// ---- node construction / comparison ----
// Values: undefined = delete the key, primitives, arrays (lists), { entries: [[k, v]...], flow } (maps).
const entriesOf = (env, flow) => ({ entries: env.map(e => [e.key, e.value]), flow })

function listOfNode(n) {
  if (isSeq(n)) return n.items.map(i => isScalar(i) ? str(i.value) : str(i))
  if (isScalar(n)) return n.value === null || n.value === '' ? [] : [str(n.value)]
  return null
}
function same(old, val) {
  if (Array.isArray(val)) { const l = listOfNode(old); return !!l && l.length === val.length && l.every((x, i) => x === str(val[i])) }
  if (val && typeof val === 'object') {
    return isMap(old) && old.items.length === val.entries.length && old.items.every((p, i) => keyOf(p) === val.entries[i][0] && isScalar(p.value) && str(p.value.value) === str(val.entries[i][1]))
  }
  if (!isScalar(old)) return false
  return typeof val === 'boolean' ? old.value === val : str(old.value) === str(val)
}
function build(val, opt) {
  if (Array.isArray(val)) {
    if (opt.scalarOne && val.length === 1) return new Scalar(val[0])
    const s = new YAMLSeq(); s.flow = opt.flow !== false; for (const v of val) s.items.push(new Scalar(v)); return s
  }
  if (val && typeof val === 'object') {
    const m = new YAMLMap(); m.flow = !!val.flow; for (const [k, v] of val.entries) m.items.push(new Pair(new Scalar(k), new Scalar(v))); return m
  }
  return new Scalar(val)
}
const rank = (order, k) => order.indexOf(k)

// Replaces, inserts (at its place in `order`) or deletes (val === undefined) a key. An unchanged value is left alone.
function setVal(m, key, val, opt = {}) {
  const order = opt.order || SERVICE_ORDER, i = find(m, key)
  if (val === undefined) {
    // an empty value (`url:`, `module: ""`) already means "not set"; it is left as the user wrote it
    if (i >= 0 && !(isScalar(m.items[i].value) && (m.items[i].value.value === null || m.items[i].value.value === ''))) m.items.splice(i, 1)
    return
  }
  if (i >= 0) {
    const pair = m.items[i], old = pair.value
    if (old && same(old, val)) return
    const nu = build(val, opt)
    if (old) {
      for (const f of ['comment', 'commentBefore', 'spaceBefore']) if (old[f] !== undefined) nu[f] = old[f]
      if ((isMap(old) && isMap(nu)) || (isSeq(old) && isSeq(nu))) nu.flow = old.flow
    }
    pair.value = nu; return
  }
  insertPair(m, key, build(val, opt), order)
}
// before the first existing key that comes later in `order`, else at the end
function insertPair(m, key, node, order) {
  let pos = m.items.length; const r = rank(order, key)
  if (r >= 0) for (let j = 0; j < m.items.length; j++) { if (rank(order, keyOf(m.items[j])) > r) { pos = j; break } }
  m.items.splice(pos, 0, new Pair(new Scalar(key), node))
}
// A block of options (spring:, node:, ...) is merged key by key, so options the form does not know survive.
function setBlock(m, key, pairs, order, keepEmpty) {
  const i = find(m, key), cur = i >= 0 ? m.items[i].value : null
  if (isMap(cur)) {
    for (const [k, v] of pairs) setVal(cur, k, v, { order })
    if (!cur.items.length && !keepEmpty) m.items.splice(i, 1)
    return
  }
  const defined = pairs.filter(([, v]) => v !== undefined)
  if (!defined.length && !keepEmpty) { if (i >= 0) m.items.splice(i, 1); return }
  const nm = new YAMLMap(); nm.flow = defined.length <= 6
  for (const [k, v] of defined) nm.items.push(new Pair(new Scalar(k), build(v, {})))
  if (i >= 0) { const old = cur; if (old) for (const f of ['comment', 'commentBefore', 'spaceBefore']) if (old[f] !== undefined) nm[f] = old[f]; m.items[i].value = nm } else insertPair(m, key, nm, SERVICE_ORDER)
}

// ---- document access ----
function rootMap(doc, file) {
  if (doc.contents === null || doc.contents === undefined) doc.contents = new YAMLMap()
  if (!isMap(doc.contents)) fail(`${file}: top level must be a mapping`)
  return doc.contents
}
function section(root, key, create, beforeKey) {
  let i = find(root, key)
  if (i >= 0) {
    let v = root.items[i].value
    if (!isMap(v)) { if (!create) return null; const nm = new YAMLMap(); if (v) for (const f of ['comment', 'commentBefore']) if (v[f] !== undefined) nm[f] = v[f]; root.items[i].value = v; v = root.items[i].value = nm }
    if (create && v.flow && !v.items.length) v.flow = false
    // a comment above the first entry is stored on the mapping; it belongs to that entry, so it moves with it
    if (v.commentBefore && v.items.length && v.items[0].key) { const k = v.items[0].key; k.commentBefore = k.commentBefore ? v.commentBefore + '\n' + k.commentBefore : v.commentBefore; v.commentBefore = undefined }
    return v
  }
  if (!create) return null
  const m = new YAMLMap(), k = new Scalar(key)
  let pos = root.items.length
  if (beforeKey) { const j = find(root, beforeKey); if (j >= 0) pos = j }
  if (pos > 0) { k.spaceBefore = true; if (beforeKey && pos < root.items.length && !root.items[pos].key.spaceBefore) root.items[pos].key.spaceBefore = true }
  root.items.splice(pos, 0, new Pair(k, m))
  return m
}
const servicesOf = (root, create = true) => section(root, 'services', create)
const runtimesOf = (root, create) => section(root, 'runtimes', create, 'services')
// a new entry gets a blank line above it when the others have one
function addEntry(m, name) {
  const k = new Scalar(name), nm = new YAMLMap(), its = m.items
  k.spaceBefore = its.length > 0 && !(its.length > 1 && !its.slice(1).some(p => p.key && p.key.spaceBefore)) // a packed list stays packed
  m.items.push(new Pair(k, nm)); return nm
}

// ---- reading ----
const envList = (raw, flat) => { const e = obj(raw); return e ? Object.entries(e).map(([key, value]) => ({ key, value: str(value) })) : [] }

function specFromRaw(name, r) {
  r = obj(r) || {}
  const s = {
    name, group: str(r.group), description: str(r.description), type: str(r.type) || 'custom', command: str(r.command), cwd: str(r.cwd), shell: str(r.shell),
    runtime: strList(r.runtime), env: envList(r.env), envFile: str(r.env_file), encoding: str(r.encoding), dependsOn: strList(r.depends_on),
    readyPort: 0, readyLog: '', readyTimeout: '', restart: str(r.restart), maxRestarts: Number(r.max_restarts) || 0, autostart: r.autostart === true,
    stopTimeout: str(r.stop_timeout), url: str(r.url), noChanges: r.changes === false, changesIgnore: strList(r.changes_ignore),
  }
  const rd = obj(r.ready); if (rd) { s.readyPort = Number(rd.port) || 0; s.readyLog = str(rd.log); s.readyTimeout = str(rd.timeout) }
  const sp = obj(r.spring), nd = obj(r.node), sc = obj(r.script), jr = obj(r.jar)
  if (sp) s.spring = { module: str(sp.module), profiles: strList(sp.profiles), jvmArgs: str(sp.jvm_args), args: str(sp.args), mode: str(sp.mode), skipTests: sp.skip_tests === undefined || sp.skip_tests === null || sp.skip_tests !== false, offline: sp.offline === true, alwaysBuild: sp.always_build === true }
  if (nd) s.node = { script: str(nd.script), args: str(nd.args), install: str(nd.install), packageManager: str(nd.package_manager) }
  if (sc) s.script = { file: str(sc.file), args: str(sc.args) }
  if (jr) s.jar = { file: str(jr.file), jvmArgs: str(jr.jvm_args), args: str(jr.args) }
  return s
}

// ---- writing a service ----
function typedBlocks(s, t) {
  const o = s.spring || { skipTests: true }, n = s.node || {}, sc = s.script || {}, j = s.jar || {}
  switch (t) {
    case 'spring-boot': return { spring: { order: SPRING_ORDER, keepEmpty: true, pairs: [['module', nz(o.module)], ['profiles', strList(o.profiles).length ? strList(o.profiles) : undefined], ['jvm_args', nz(o.jvmArgs)], ['args', nz(o.args)],
      ['mode', o.mode === 'run' ? 'run' : undefined], ['skip_tests', o.skipTests === false ? false : undefined], ['offline', o.offline ? true : undefined], ['always_build', o.alwaysBuild ? true : undefined]] } }
    case 'node': return { node: { order: NODE_ORDER, pairs: [['script', nz(n.script)], ['args', nz(n.args)], ['install', n.install && n.install !== 'if-changed' ? n.install : undefined], ['package_manager', n.packageManager && n.packageManager !== 'auto' ? n.packageManager : undefined]] } }
    case 'script': return { script: { order: SCRIPT_ORDER, pairs: [['file', nz(sc.file)], ['args', nz(sc.args)]] } }
    case 'jar': return { jar: { order: JAR_ORDER, pairs: [['file', nz(j.file)], ['jvm_args', nz(j.jvmArgs)], ['args', nz(j.args)]] } }
  }
  return {}
}
function applyType(m, s) {
  const t = str(s.type).trim() || 'custom'
  if (t === 'custom') { setVal(m, 'type', undefined); setVal(m, 'command', str(s.command)) } else { setVal(m, 'type', t); setVal(m, 'command', undefined) }
  const blocks = typedBlocks(s, t)
  for (const k of ['spring', 'node', 'script', 'jar']) {
    const b = blocks[k]
    if (b) setBlock(m, k, b.pairs, b.order, !!b.keepEmpty); else setVal(m, k, undefined)
  }
}
function envValue(list, what) {
  const out = [], seen = new Set()
  for (const e of list || []) {
    const k = str(e && e.key).trim(); if (!k) continue
    if (seen.has(k)) fail(`${what}: duplicate variable ${k}`)
    seen.add(k); out.push({ key: k, value: str(e.value) })
  }
  return out
}
function applySpec(m, s) {
  setVal(m, 'group', nz(s.group)); setVal(m, 'description', nz(s.description)); setVal(m, 'cwd', nz(s.cwd))
  applyType(m, s)
  setVal(m, 'shell', nz(s.shell))
  const rt = strList(s.runtime); setVal(m, 'runtime', rt.length ? rt : undefined, { scalarOne: true })
  const env = envValue(s.env, 'env'); setVal(m, 'env', env.length ? entriesOf(env, env.length <= 3) : undefined)
  setVal(m, 'env_file', nz(s.envFile))
  setVal(m, 'encoding', s.encoding === '' || s.encoding === 'auto' || s.encoding === undefined || s.encoding === null ? undefined : str(s.encoding))
  const deps = strList(s.dependsOn); setVal(m, 'depends_on', deps.length ? deps : undefined)
  const port = Number(s.readyPort) || 0, log = str(s.readyLog)
  if (port > 0 || log) {
    const e = [port > 0 ? ['port', port] : ['log', log]]; if (str(s.readyTimeout)) e.push(['timeout', str(s.readyTimeout)])
    setVal(m, 'ready', { entries: e, flow: true })
  } else setVal(m, 'ready', undefined)
  const rs = str(s.restart), mr = Number(s.maxRestarts) || 0
  if (rs === '' || rs === 'no') { setVal(m, 'restart', undefined); setVal(m, 'max_restarts', undefined) } else { setVal(m, 'restart', rs); setVal(m, 'max_restarts', mr > 0 ? mr : undefined) }
  setVal(m, 'autostart', s.autostart ? true : undefined)
  setVal(m, 'stop_timeout', nz(s.stopTimeout)); setVal(m, 'url', nz(s.url))
  setVal(m, 'changes', s.noChanges ? false : undefined)
  const ign = strList(s.changesIgnore).map(p => p.trim()).filter(Boolean)
  setVal(m, 'changes_ignore', ign.length ? ign : undefined, { flow: false })
}

// the `raw` shape the loader reads, from a form spec (only what the commands depend on)
function rawForPreview(s) {
  const raw = { type: str(s.type).trim() || 'custom', command: str(s.command) }
  if (s.cwd) raw.cwd = s.cwd
  for (const [k, order] of [['spring', SPRING_ORDER], ['node', NODE_ORDER], ['script', SCRIPT_ORDER], ['jar', JAR_ORDER]]) {
    const b = typedBlocks(s, raw.type)[k]; if (!b) continue
    raw[k] = {}; for (const [bk, v] of b.pairs) if (v !== undefined) raw[k][bk] = v
  }
  return raw
}
function previewSpec(base, s) {
  try {
    const p = plan(normalizeService(base, str(s.name) || 'preview', rawForPreview(s)), false, false)
    return { build: p.buildPreview || '', run: p.runPreview || '' }
  } catch (e) { return { build: '', run: '', error: e.message } }
}

// ---- layout-preserving output ----
const normLine = l => {
  const m = /^(\s*)([\s\S]*)$/.exec(l)
  // the indent of list items does not count: `key:\n- a` and `key:\n  - a` are both common and the library prints the second
  return (m[2].startsWith('- ') ? '' : m[1]) + m[2].replace(/\s+#/g, ' #').replace(/([[{])\s+/g, '$1').replace(/\s+([\]}])/g, '$1').replace(/\s*,\s*/g, ',').replace(/\s+$/, '')
}
// lines of `next` laid out like `orig`: a line equal to an original one apart from such whitespace is taken from the original
function mergeLayout(orig, next) {
  // the library pads flow sequences ([ a ]); grid.yaml files use [a]
  const A = orig.split(/\r?\n/), B = next.split('\n').map(l => /["']/.test(l) ? l : l.replace(/\[ ([^[\]{}]*?) \]/g, '[$1]')), ka = A.map(normLine), kb = B.map(normLine)
  let lo = 0
  while (lo < A.length && lo < B.length && ka[lo] === kb[lo]) lo++
  let ea = A.length, eb = B.length
  while (ea > lo && eb > lo && ka[ea - 1] === kb[eb - 1]) { ea--; eb-- }
  const n = ea - lo, m = eb - lo, out = A.slice(0, lo)
  if (n * m > 25e6) return next
  const w = m + 1, t = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = ka[lo + i] === kb[lo + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
  const ops = [] // original line, or [new line key, new line] for one that is not in the original at that place
  const gone = new Map() // original lines that dropped out of place: a moved block takes its text from here
  let i = 0, j = 0
  while (i < n && j < m) {
    if (ka[lo + i] === kb[lo + j]) { ops.push(A[lo + i]); i++; j++ } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) { const k = ka[lo + i]; (gone.get(k) || gone.set(k, []).get(k)).push(A[lo + i]); i++ } else { ops.push([kb[lo + j], B[lo + j]]); j++ }
  }
  while (i < n) { const k = ka[lo + i]; (gone.get(k) || gone.set(k, []).get(k)).push(A[lo + i]); i++ }
  while (j < m) ops.push([kb[lo + j], B[lo + j++]])
  for (const op of ops) out.push(typeof op === 'string' ? op : op[0].trim() && gone.has(op[0]) && gone.get(op[0]).length ? gone.get(op[0]).shift() : op[1])
  return out.concat(A.slice(ea)).join('\n')
}
function guessIndent(src) {
  let min = 0
  for (const l of src.split(/\r?\n/)) { const m = /^( +)\S/.exec(l); if (m && !m[0].trimStart().startsWith('#') && (!min || m[1].length < min)) min = m[1].length }
  return min >= 1 && min <= 8 ? min : 2
}
function guessIndentSeq(src) {
  const lines = src.split(/\r?\n/)
  for (let i = 0; i + 1 < lines.length; i++) {
    const k = /^(\s*)[^\s#-][^#]*:\s*(#.*)?$/.exec(lines[i]), s = k && /^(\s*)- /.exec(lines[i + 1])
    if (k && s) return s[1].length > k[1].length
  }
  return true
}

const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch {} }
function renameRetry(from, to) { // Windows: the target can be held open for a moment (editor, virus scanner)
  for (let i = 0; ; i++) { try { return fs.renameSync(from, to) } catch (e) { if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; sleepSync(60) } }
}

// Reads the file, lets fn change the document, validates the result with the loader and replaces the file.
// Returns true when the file changed.
function edit(file, fn) {
  const rawText = fs.readFileSync(file, 'utf8'), bom = rawText.charCodeAt(0) === 0xFEFF, orig = bom ? rawText.slice(1) : rawText
  const doc = YAML.parseDocument(orig)
  if (doc.errors.length) fail(`${file}: ${doc.errors[0].message}`)
  fn(doc, rootMap(doc, file))
  const printed = doc.toString({ lineWidth: 0, indent: guessIndent(orig), indentSeq: guessIndentSeq(orig) })
  let text = mergeLayout(orig, printed)
  // the merge must not change what the file means; if it somehow does, use the plain output
  try { if (JSON.stringify(YAML.parse(text)) !== JSON.stringify(YAML.parse(printed))) text = printed } catch { text = printed }
  if (!text.endsWith('\n')) text += '\n'
  if (/\r\n/.test(orig)) text = text.replace(/\r?\n/g, '\r\n')
  if (bom) text = '﻿' + text
  if (text === rawText) return false
  const tmp = file + '.tmp'
  try {
    let mode; try { mode = fs.statSync(file).mode & 0o777 } catch {}
    fs.writeFileSync(tmp, text, mode ? { mode } : undefined)
    loadConfig(tmp) // same folder, so relative paths resolve as they will in the real file
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    fail(String(e.message).split(tmp).join(file))
  }
  try { fs.writeFileSync(file + '.bak', rawText) } catch {}
  renameRetry(tmp, file)
  return true
}

// ---- public operations ----
const checkName = name => { if (!NAME_RE.test(name)) fail(`invalid name "${name}": use letters, digits, '.', '_' or '-'`) }
const exist = (what, name) => fail(`${what} "${name}" already exists`)
function readDoc(file) {
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  if (doc.errors.length) fail(`${file}: ${doc.errors[0].message}`)
  return doc
}
function readEntry(file, section, name, what) {
  const doc = readDoc(file), root = isMap(doc.contents) ? doc.contents : null, m = root && section(root)
  const i = m ? find(m, name) : -1
  if (i < 0) throw Object.assign(new Error(`${what} "${name}" not found`), { notFound: true })
  return nodeJS(doc, m.items[i].value)
}
const readSpec = (file, name) => specFromRaw(name, readEntry(file, r => servicesOf(r, false), name, 'service'))
function readRuntime(file, name) {
  const r = obj(readEntry(file, r => runtimesOf(r, false), name, 'runtime')) || {}
  return { name, type: str(r.type).toLowerCase() || inferType(name), home: str(r.home), bin: str(r.bin), env: envList(r.env) }
}

function renameRefs(svcs, key, from, to) {
  for (const p of svcs.items) {
    const m = p.value; if (!isMap(m)) continue
    const j = find(m, key); if (j < 0) continue
    const d = m.items[j].value
    if (isScalar(d)) { if (str(d.value) === from) d.value = to } else if (isSeq(d)) for (const it of d.items) if (isScalar(it) && str(it.value) === from) it.value = to
  }
}

function saveService(file, oldName, s) {
  s.name = str(s.name).trim(); checkName(s.name)
  return edit(file, (doc, root) => {
    const svcs = servicesOf(root)
    let m
    if (!oldName) {
      if (find(svcs, s.name) >= 0) exist('service', s.name)
      m = addEntry(svcs, s.name)
    } else {
      const i = find(svcs, oldName)
      if (i < 0) throw Object.assign(new Error(`service "${oldName}" not found`), { notFound: true })
      if (s.name !== oldName) {
        if (find(svcs, s.name) >= 0) exist('service', s.name)
        svcs.items[i].key.value = s.name
        renameRefs(svcs, 'depends_on', oldName, s.name)
      }
      m = svcs.items[i].value
      if (!isMap(m)) m = svcs.items[i].value = new YAMLMap()
    }
    applySpec(m, s)
  })
}

function deleteService(file, name) {
  return edit(file, (doc, root) => {
    const svcs = servicesOf(root), i = find(svcs, name)
    if (i < 0) throw Object.assign(new Error(`service "${name}" not found`), { notFound: true })
    for (const p of svcs.items) {
      if (keyOf(p) !== name && strList(nodeJS(doc, p.value) && nodeJS(doc, p.value).depends_on).includes(name)) fail(`"${keyOf(p)}" depends on "${name}"; remove that dependency first`)
    }
    svcs.items.splice(i, 1)
    if (i === 0 && svcs.items.length && svcs.items[0].key) svcs.items[0].key.spaceBefore = false // it is the first one now
  })
}

function reorderServices(file, names) {
  if (!Array.isArray(names)) fail('expected {"services": [names]}')
  return edit(file, (doc, root) => {
    const svcs = servicesOf(root)
    if (names.length !== svcs.items.length) fail(`order must list all ${svcs.items.length} services`)
    const by = new Map(svcs.items.map(p => [keyOf(p), p])), out = []
    const packed = !svcs.items.slice(1).some(p => p.key && p.key.spaceBefore)
    for (const n of names) { const p = by.get(n); if (!p) fail(`unknown or repeated service "${n}"`); by.delete(n); out.push(p) }
    out.forEach((p, i) => { if (p.key) p.key.spaceBefore = i > 0 && !packed })
    svcs.items = out
  })
}

function saveRuntime(file, oldName, s) {
  const name = str(s.name).trim(), home = str(s.home).trim(), bin = str(s.bin).trim(), type = str(s.type).trim().toLowerCase()
  checkName(name)
  if (!RUNTIME_TYPES[type]) fail('type must be java, node or script')
  if (!home) fail('home folder is required')
  return edit(file, (doc, root) => {
    const rts = runtimesOf(root, true)
    let m
    if (!oldName) {
      if (find(rts, name) >= 0) exist('runtime', name)
      m = addEntry(rts, name)
    } else {
      const i = find(rts, oldName)
      if (i < 0) throw Object.assign(new Error(`runtime "${oldName}" not found`), { notFound: true })
      if (name !== oldName) {
        if (find(rts, name) >= 0) exist('runtime', name)
        rts.items[i].key.value = name
        const svcs = servicesOf(root, false); if (svcs) renameRefs(svcs, 'runtime', oldName, name)
      }
      m = rts.items[i].value
      if (!isMap(m)) m = rts.items[i].value = new YAMLMap()
    }
    const o = { order: RUNTIME_ORDER }
    if (find(m, 'type') >= 0 || inferType(name) !== type) setVal(m, 'type', type, o) // written only when the name does not imply it
    setVal(m, 'home', home, o); setVal(m, 'bin', nz(bin), o)
    if (Array.isArray(s.env)) { const env = envValue(s.env, 'env'); setVal(m, 'env', env.length ? entriesOf(env, env.length <= 3) : undefined, o) } // null = leave as it is (the form has no env editor)
  })
}

function deleteRuntime(file, name, detach) {
  return edit(file, (doc, root) => {
    const rts = runtimesOf(root, false), i = rts ? find(rts, name) : -1
    if (i < 0) throw Object.assign(new Error(`runtime "${name}" not found`), { notFound: true })
    const svcs = servicesOf(root, false)
    if (svcs) {
      const users = svcs.items.filter(p => strList(nodeJS(doc, p.value) && nodeJS(doc, p.value).runtime).includes(name)).map(keyOf)
      if (users.length) {
        if (!detach) fail(`"${name}" is used by ${users.join(', ')}; remove it from those services first`)
        for (const p of svcs.items) {
          const m = p.value; if (!isMap(m) || !users.includes(keyOf(p))) continue
          const left = strList(nodeJS(doc, m.items[find(m, 'runtime')].value)).filter(x => x !== name)
          setVal(m, 'runtime', left.length ? left : undefined, { scalarOne: true })
        }
      }
    }
    rts.items.splice(i, 1)
    if (!rts.items.length) root.items.splice(find(root, 'runtimes'), 1)
  })
}

module.exports = { readSpec, readRuntime, saveService, deleteService, reorderServices, saveRuntime, deleteRuntime, previewSpec, mergeLayout }
