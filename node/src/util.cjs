// Small helpers shared by the config, plan and service code (ports of the Go helpers).
const fs = require('fs'), os = require('os'), path = require('path')
const WIN = process.platform === 'win32'

const fileExists = p => { try { return fs.statSync(p).isFile() } catch { return false } }
const dirExists = p => { try { return fs.statSync(p).isDirectory() } catch { return false } }

// "10s", "2m", "1h30m", "500ms"; a bare number counts as seconds. Returns ms, or NaN.
function parseDuration(v) {
  if (v === undefined || v === null || v === '') return 0
  if (typeof v === 'number') return v * 1000
  const s = String(v).trim(); if (!s) return 0
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000
  const unit = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 }
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/y; let total = 0, pos = 0, m
  while (pos < s.length && (re.lastIndex = pos, m = re.exec(s))) { total += Number(m[1]) * unit[m[2]]; pos = re.lastIndex }
  return pos === s.length ? total : NaN
}
function fmtDuration(ms) {
  if (ms < 1000) return ms + 'ms'
  if (ms < 60000) return (Math.round(ms / 100) / 10) + 's'
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000)
  return m + 'm' + (s ? s + 's' : '')
}

// os.ExpandEnv: $NAME and ${NAME}, unknown names become "".
const expandEnv = s => s.replace(/\$(?:\{([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_, a, b) => process.env[a || b] || '')

function resolvePath(base, p) {
  p = expandEnv(p)
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1))
  if (!path.isAbsolute(p)) p = path.join(base, p)
  p = path.normalize(p)
  return p.length > path.parse(p).root.length ? p.replace(/[\\/]+$/, '') : p
}

// KEY=VALUE lines, optional "export " and quotes.
function readEnvFile(file) {
  const out = {}
  for (let line of fs.readFileSync(file, 'utf8').split('\n')) {
    line = line.trim(); if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice(7)
    const i = line.indexOf('='); if (i < 0) continue
    const k = line.slice(0, i).trim(); let v = line.slice(i + 1).trim()
    if (v.length >= 2 && (v[0] === '"' && v.endsWith('"') || v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1)
    out[k] = v
  }
  return out
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g
const stripAnsi = s => s.replace(ANSI_RE, '')

// ---- output decoding: "auto" keeps valid UTF-8 and falls back to cp1254 ----
const CP1254_LOW = [
  0x20AC, 0xFFFD, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0xFFFD, 0xFFFD, 0xFFFD,
  0xFFFD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0xFFFD, 0xFFFD, 0x0178]
const CP1254_HIGH = { 0xD0: 'Ğ', 0xDD: 'İ', 0xDE: 'Ş', 0xF0: 'ğ', 0xFD: 'ı', 0xFE: 'ş' }
function cp1254(buf) {
  let s = ''
  for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : b < 0xA0 ? String.fromCharCode(CP1254_LOW[b - 0x80]) : CP1254_HIGH[b] || String.fromCharCode(b)
  return s
}
const utf8Strict = new TextDecoder('utf-8', { fatal: true })
function decode(buf, enc) {
  if (enc === 'utf-8') return buf.toString('utf8')
  if (enc === 'auto') { try { return utf8Strict.decode(buf) } catch {} }
  return cp1254(buf)
}

// ---- line splitting (port of runner/lines.go) ----
const MAX_LINE = 64 << 10
// bytes at the end of a cut piece that belong to the next one: an unfinished UTF-8 character or a \r
function heldBack(b) {
  if (b.length && b[b.length - 1] === 13) return 1
  for (let i = 1; i <= 3 && i <= b.length; i++) {
    const c = b[b.length - i]
    if (c < 0x80) return 0
    if (c >= 0xC0) { const need = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : 2; return i >= need ? 0 : i }
  }
  return 0
}
// push(buffer) as data arrives; end() flushes the unfinished last line. emit gets a Buffer without line end.
function lineReader(emit, max = MAX_LINE) {
  let pend = Buffer.alloc(0), rest = false
  const trim = b => { let n = b.length; while (n && (b[n - 1] === 10 || b[n - 1] === 13)) n--; return b.subarray(0, n) }
  function drain(final) {
    for (;;) {
      const i = pend.indexOf(10)
      if (i >= 0 && i < max) { const line = trim(pend.subarray(0, i + 1)); pend = pend.subarray(i + 1); if (line.length || !rest) emit(line); rest = false; continue }
      if (pend.length >= max) {
        let line = pend.subarray(0, max); pend = pend.subarray(max)
        const n = heldBack(line); if (n) { pend = Buffer.concat([line.subarray(line.length - n), pend]); line = line.subarray(0, line.length - n) }
        if (line.length || !rest) emit(line); rest = true; continue
      }
      break
    }
    if (final && pend.length) { const line = trim(pend); pend = Buffer.alloc(0); if (line.length || !rest) emit(line); rest = false }
  }
  return { push(b) { pend = pend.length ? Buffer.concat([pend, b]) : b; drain(false) }, end() { drain(true) } }
}

module.exports = { WIN, fileExists, dirExists, parseDuration, fmtDuration, expandEnv, resolvePath, readEnvFile, stripAnsi, decode, lineReader }
