// Cell text of a driver value (port of internal/db/format.go and the Postgres / Oracle specifics). Cells are text (null = NULL) so numbers keep
// every digit and the UI needs no type handling.

const pad = (n, w = 2) => String(n).padStart(w, '0')

// 1e21 -> "1000000000000000000000", 1e-7 -> "0.0000001" (Go's FormatFloat(x, 'f', -1, 64): the shortest digits that round-trip, never an exponent)
function formatNumber(x) {
  if (Number.isNaN(x)) return 'NaN'
  if (!Number.isFinite(x)) return x > 0 ? '+Inf' : '-Inf'
  return expandExponent(String(x))
}
function expandExponent(s) {
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s)
  if (!m) return s
  const [, sign, int, frac = '', e] = m, exp = Number(e)
  const digits = int + frac, point = int.length + exp
  if (point <= 0) return sign + '0.' + '0'.repeat(-point) + digits
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length)
  return sign + digits.slice(0, point) + '.' + digits.slice(point)
}

// Oracle hands NUMBER over as text (every digit): ".5" -> "0.5", "-.5" -> "-0.5"
function oracleNumber(s) { return s.replace(/^(-?)\./, '$10.') }

function formatBinary(b) {
  const SHOW = 16, hex = Buffer.from(b.buffer, b.byteOffset, SHOW < b.length ? SHOW : b.length).toString('hex').toUpperCase()
  return b.length <= SHOW ? '0x' + hex : `0x${hex}... (${b.length} bytes)`
}

// A JS Date: Go's "2006-01-02 15:04:05" (+ ".999999999" without trailing zeros when there is a fraction, + " -07:00" for zoned types).
// A Date carries no zone: it is shown in UTC (the callers that care get text from the database instead).
function formatTime(d, dbType) {
  let s = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  const ms = d.getUTCMilliseconds()
  if (ms) s += '.' + pad(ms, 3).replace(/0+$/, '')
  const t = String(dbType || '').toUpperCase()
  if (t.includes('TZ') || t.includes('TIME ZONE')) s += ' +00:00'
  return s
}

function formatCell(v, dbType) {
  if (v === null || v === undefined) return null
  switch (typeof v) {
    case 'string': return v
    case 'bigint': return v.toString()
    case 'number': return formatNumber(v)
    case 'boolean': return v ? 'true' : 'false'
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : formatTime(v, dbType)
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return formatBinary(v)
  if (ArrayBuffer.isView(v)) return JSON.stringify(Array.from(v)) // VECTOR columns
  if (typeof v === 'object') {
    if (typeof v.toISOString === 'function') return v.toISOString()
    if (Object.prototype.hasOwnProperty.call(v, 'days') && Object.prototype.hasOwnProperty.call(v, 'fseconds')) return formatIntervalDS(v)
    if (Object.prototype.hasOwnProperty.call(v, 'years') && Object.prototype.hasOwnProperty.call(v, 'months')) return formatIntervalYM(v)
    if (v.toString !== Object.prototype.toString && !Array.isArray(v)) return String(v)
    try { return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)) } catch { return String(v) }
  }
  return String(v)
}

// INTERVAL DAY TO SECOND / YEAR TO MONTH as oracledb returns them, in the Go version's spelling: "+01 02:03:04.500000", "-01-02"
function formatIntervalDS(v) {
  const neg = v.days < 0 || v.hours < 0 || v.minutes < 0 || v.seconds < 0 || v.fseconds < 0, a = Math.abs
  return `${neg ? '-' : '+'}${pad(a(v.days))} ${pad(a(v.hours))}:${pad(a(v.minutes))}:${pad(a(v.seconds))}.${pad(Math.trunc(a(v.fseconds) / 1000), 6)}`
}
function formatIntervalYM(v) {
  const neg = v.years < 0 || v.months < 0
  return `${neg ? '-' : '+'}${pad(Math.abs(v.years))}-${pad(Math.abs(v.months))}`
}

// PostgreSQL gets raw text from the server for every type except a few (see the type parsers in dbdrivers.cjs). A timestamptz arrives in the session's
// zone ("2026-01-02 03:04:05.5+00"); like the Go driver it is shown in this machine's zone, "2026-01-02 06:04:05.5 +03:00". Anything unusual
// (BC dates, infinity) stays as the server wrote it.
function pgTimestamptz(raw) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(\.\d+)?([+-])(\d\d)(?::(\d\d))?(?::(\d\d))?$/.exec(raw)
  if (!m) return raw
  const off = (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 3600 + Number(m[10] || 0) * 60 + Number(m[11] || 0))
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - off * 1000)
  if (Number(m[1]) < 100) t.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3])) // Date.UTC maps years 0-99 to 1900-1999
  const lo = -t.getTimezoneOffset(), a = Math.abs(lo)
  return `${String(t.getFullYear()).padStart(4, '0')}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}${m[7] || ''} ${lo < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

module.exports = { formatCell, formatNumber, formatBinary, formatTime, oracleNumber, pgTimestamptz }
