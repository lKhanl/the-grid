// SQL text helpers (port of internal/db/sqltext.go and the text parts of postgres.go): masking of literals and comments, statement kinds,
// transaction control words and the guards behind the read-only AI access. All checks look at the masked text, never at the raw one.

// Blanks out string literals, quoted identifiers and comments so checks see the real SQL words only. Same length as sql.
function maskLiterals(sql) {
  const n = sql.length, b = sql.split('')
  const blank = (from, to) => { for (let i = from; i < to && i < n; i++) if (b[i] !== '\n') b[i] = ' ' }
  for (let i = 0; i < n;) {
    const c = b[i]
    if (c === '-' && b[i + 1] === '-') { // line comment
      let j = i; while (j < n && b[j] !== '\n') j++
      blank(i, j); i = j
    } else if (c === '/' && b[i + 1] === '*') { // block comment
      let j = i + 2; while (j + 1 < n && !(b[j] === '*' && b[j + 1] === '/')) j++
      j = Math.min(j + 2, n); blank(i, j); i = j
    } else if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n) {
        if (b[j] === c) { if (b[j + 1] === c) { j += 2; continue } break } // doubled quote
        j++
      }
      blank(i + 1, j); i = Math.min(j + 1, n)
    } else i++
  }
  return b.join('')
}

// first SQL keyword, upper case ("" if none)
function firstWord(masked) {
  const m = /^[ \t\r\n(]*([A-Za-z_]*)/.exec(masked)
  return m[1].toUpperCase()
}

// SELECT / WITH
function isQuery(sql) { const w = firstWord(maskLiterals(sql)); return w === 'SELECT' || w === 'WITH' }

const trimEnd = s => s.replace(/[; \t\r\n]+$/, '')
const trim = s => s.replace(/^[\s ﻿]+|[\s ﻿]+$/g, '')

// a typed COMMIT / ROLLBACK (not ROLLBACK TO SAVEPOINT): the UI session must end its transaction itself
function txControl(sql) {
  let f = trimEnd(trim(maskLiterals(sql))).toUpperCase().split(/\s+/).filter(Boolean)
  if (f.length === 2 && f[1] === 'WORK') f = f.slice(0, 1)
  return f.length === 1 && (f[0] === 'COMMIT' || f[0] === 'ROLLBACK') ? f[0] : ''
}

// statements that Oracle commits implicitly
const DDL = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'COMMENT', 'RENAME', 'ANALYZE', 'AUDIT', 'NOAUDIT', 'FLASHBACK', 'PURGE'])
function isDDL(sql) { return DDL.has(firstWord(maskLiterals(sql))) }

const lastWord = s => { const f = s.split(/\s+/).filter(Boolean); return f.length ? f[f.length - 1] : '' }

// Trims the statement for the driver: Oracle rejects a trailing ";" on plain SQL, but a PL/SQL block or CREATE PROCEDURE ... END; needs it.
function prepare(sql) {
  let t = trim(sql)
  while (t.endsWith(';')) {
    const body = trim(t.slice(0, -1)), up = maskLiterals(body).toUpperCase()
    if (up.trimEnd().endsWith('END') || (up.trimEnd().endsWith('END ' + lastWord(up)) && firstWord(up).startsWith('CREATE'))) return t // keep "END;"
    t = body
  }
  return t
}

// exactly one SELECT / WITH statement without FOR UPDATE
function checkReadOnly(sql) {
  const masked = trimEnd(trim(maskLiterals(sql)))
  if (masked === '') throw new Error('empty statement')
  if (masked.includes(';')) throw new Error('one statement at a time (no ; in the middle)')
  const w = firstWord(masked)
  if (w !== 'SELECT' && w !== 'WITH') throw new Error('this connection is read-only for AI: only SELECT / WITH statements are allowed')
  const up = ' ' + masked.toUpperCase().split(/\s+/).filter(Boolean).join(' ') + ' '
  if (up.includes(' FOR UPDATE ') || up.includes(' FOR UPDATE;')) throw new Error('SELECT ... FOR UPDATE is not allowed on a read-only connection')
}

// rejects several statements in one go (AI writes)
function checkSingle(sql) {
  const masked = trim(maskLiterals(sql))
  if (trimEnd(masked) === '') throw new Error('empty statement')
  const w = firstWord(masked)
  if (w === 'BEGIN' || w === 'DECLARE' || w === 'CREATE') return // PL/SQL blocks contain ; by nature
  if (trimEnd(masked).includes(';')) throw new Error('one statement at a time (no ; in the middle)')
}

// ---- PostgreSQL ----

// maskLiterals for PostgreSQL: also $tag$ ... $tag$ bodies, E'...' strings with backslash escapes and nested comments
function maskPG(sql) {
  const n = sql.length, b = sql.split('')
  const blank = (from, to) => { for (let i = from; i < to && i < n; i++) if (b[i] !== '\n') b[i] = ' ' }
  const ident = c => c !== undefined && (/[A-Za-z0-9_]/.test(c) || c.charCodeAt(0) >= 0x80)
  for (let i = 0; i < n;) {
    const c = b[i]
    if (c === '-' && b[i + 1] === '-') {
      let j = i; while (j < n && b[j] !== '\n') j++
      blank(i, j); i = j
    } else if (c === '/' && b[i + 1] === '*') {
      let depth = 1, j = i + 2
      while (j < n && depth > 0) {
        if (b[j] === '/' && b[j + 1] === '*') { depth++; j += 2 } else if (b[j] === '*' && b[j + 1] === '/') { depth--; j += 2 } else j++
      }
      blank(i, j); i = j
    } else if (c === '$' && (i === 0 || (!ident(b[i - 1]) && b[i - 1] !== '$'))) {
      // $$ or $tag$ (a tag does not start with a digit: $1 is a parameter)
      let j = i + 1
      while (j < n && ident(b[j]) && !(j === i + 1 && b[j] >= '0' && b[j] <= '9')) j++
      if (j >= n || b[j] !== '$') { i++; continue }
      const tag = b.slice(i, j + 1).join(''), end = b.slice(j + 1).join('').indexOf(tag)
      const stop = end >= 0 ? j + 1 + end : n
      blank(j + 1, stop); i = Math.min(stop + tag.length, n)
    } else if (c === "'" || c === '"') {
      const esc = c === "'" && i > 0 && (b[i - 1] === 'E' || b[i - 1] === 'e') && (i === 1 || !ident(b[i - 2]))
      let j = i + 1
      while (j < n) {
        if (esc && b[j] === '\\') { j += 2; continue }
        if (b[j] === c) { if (b[j + 1] === c) { j += 2; continue } break }
        j++
      }
      blank(i + 1, j); i = Math.min(j + 1, n)
    } else i++
  }
  return b.join('')
}

// upper-case words of a masked statement (punctuation splits words)
const pgWords = masked => masked.toUpperCase().split(/[^A-Z0-9_$]+/).filter(Boolean)
const hasWord = (words, ...w) => words.some(x => w.includes(x))

const pg = {
  prepare: sql => trim(trimEnd(trim(sql))),
  returnsRows(sql) {
    const m = maskPG(sql)
    switch (firstWord(m)) {
      case 'SELECT': case 'WITH': case 'VALUES': case 'TABLE': case 'SHOW': case 'EXPLAIN': case 'FETCH': return true
      case 'INSERT': case 'UPDATE': case 'DELETE': case 'MERGE': return hasWord(pgWords(m), 'RETURNING')
    }
    return false
  },
  isRead: sql => pgRead(maskPG(sql)),
  // COMMIT / END, ROLLBACK / ABORT (not ROLLBACK TO SAVEPOINT) and BEGIN / START TRANSACTION, the latter as "BEGIN" plus its options
  txControl(sql) {
    const all = trimEnd(trim(maskPG(sql))).toUpperCase().split(/\s+/).filter(Boolean)
    if (!all.length) return ''
    let f = all, rest = all.slice(1)
    if (f[0] === 'START') {
      if (f.length < 2 || f[1] !== 'TRANSACTION') return ''
      f = ['BEGIN']; rest = all.slice(2)
    } else if (rest.length && (rest[0] === 'WORK' || rest[0] === 'TRANSACTION')) rest = rest.slice(1)
    switch (f[0]) {
      case 'COMMIT': case 'END': if (!rest.length) return 'COMMIT'; break
      case 'ROLLBACK': case 'ABORT': if (!rest.length) return 'ROLLBACK'; break
      case 'BEGIN': return trim('BEGIN ' + rest.join(' '))
    }
    return ''
  },
  implicitCommit: () => false, // Postgres DDL is transactional
  stmtSavepoint: sql => !savepointCmd(sql),
  // statements Postgres refuses to run inside a transaction block
  noTx(sql) {
    const w = pgWords(maskPG(sql))
    if (!w.length) return false
    switch (w[0]) {
      case 'VACUUM': return true
      case 'ALTER': return w.length > 1 && w[1] === 'SYSTEM'
      case 'CREATE': case 'DROP': return (w.length > 1 && (w[1] === 'DATABASE' || w[1] === 'TABLESPACE')) || (hasWord(w, 'CONCURRENTLY') && hasWord(w, 'INDEX'))
      case 'REINDEX': return hasWord(w, 'CONCURRENTLY')
    }
    return false
  },
  checkReadOnly(sql) {
    const masked = trimEnd(trim(maskPG(sql)))
    if (masked === '') throw new Error('empty statement')
    if (masked.includes(';')) throw new Error('one statement at a time (no ; in the middle)')
    if (!pgRead(masked)) throw new Error('this connection is read-only for AI: only SELECT / WITH / VALUES / SHOW / EXPLAIN statements are allowed')
    const w = pgWords(masked)
    for (let i = 0; i + 1 < w.length; i++) {
      if (w[i] === 'FOR' && ['UPDATE', 'SHARE', 'NO', 'KEY'].includes(w[i + 1])) throw new Error('SELECT ... FOR UPDATE / SHARE is not allowed on a read-only connection')
    }
  },
  checkSingle(sql) {
    const masked = trimEnd(trim(maskPG(sql)))
    if (masked === '') throw new Error('empty statement')
    if (masked.includes(';')) throw new Error('one statement at a time (no ; in the middle)') // function bodies are $$ quoted, so they are masked out
  },
}

function pgRead(masked) {
  const w = pgWords(masked)
  switch (firstWord(masked)) {
    case 'SELECT': return !hasWord(w, 'INTO') // SELECT ... INTO creates a table
    case 'VALUES': case 'TABLE': case 'SHOW': return true
    case 'EXPLAIN': return !hasWord(w, 'ANALYZE', 'ANALYSE') // EXPLAIN ANALYZE runs the statement
    case 'WITH': return !hasWord(w, 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'INTO') // data-modifying CTEs
  }
  return false
}

// the user works with savepoints themselves; Grid's own one stays out of their way
function savepointCmd(sql) {
  const w = pgWords(maskPG(sql))
  return w.length > 0 && (w[0] === 'SAVEPOINT' || w[0] === 'RELEASE' || (w[0] === 'ROLLBACK' && w.length > 1 && hasWord(w.slice(1), 'TO')))
}

// the Oracle flavour as a dialect-shaped object
const oracle = {
  prepare, returnsRows: isQuery, isRead: isQuery, txControl, implicitCommit: isDDL, noTx: () => false, stmtSavepoint: () => false, checkReadOnly, checkSingle,
}

module.exports = { maskLiterals, firstWord, isQuery, txControl, isDDL, prepare, checkReadOnly, checkSingle, maskPG, pgWords, pg, oracle }
