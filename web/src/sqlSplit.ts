// Splits an editor script into statements: at `;` outside strings / quoted names / comments.
// Oracle: also at a line holding only `/` (the SQL*Plus way to end a PL/SQL block). A PL/SQL block
// (BEGIN, DECLARE, CREATE FUNCTION / PROCEDURE / PACKAGE / TRIGGER / TYPE) holds `;` itself, so only
// the `/` line ends it. Postgres: function bodies are $$ / $tag$ quoted, so `;` inside them is skipped
// like in a string (and BEGIN is just a statement). Empty and comment-only pieces are dropped.
import type { DbKind } from './dbApi'

const PLSQL = /^(?:BEGIN|DECLARE|CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:FUNCTION|PROCEDURE|PACKAGE|TRIGGER|TYPE)\b)/i

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim()
}

export interface SqlRange {
  sql: string
  from: number // first character of the statement
  to: number // after the statement and its ; or / terminator
}

export function splitSql(text: string, kind: DbKind = 'oracle'): string[] {
  return splitSqlRanges(text, kind).map((r) => r.sql)
}

/** The statement the cursor is in (or, between two statements, the one before it). */
export function statementAt(text: string, pos: number, kind: DbKind = 'oracle'): SqlRange | null {
  const all = splitSqlRanges(text, kind)
  if (!all.length) return null
  let before: SqlRange | null = null
  for (const r of all) {
    if (pos >= r.from && pos <= r.to) return r
    if (r.to < pos) before = r
  }
  return before ?? all[0]
}

export function splitSqlRanges(text: string, kind: DbKind = 'oracle'): SqlRange[] {
  const pg = kind === 'postgres'
  const out: SqlRange[] = []
  let cur = ''
  let start = 0 // where `cur` begins in text
  const flush = (end: number) => {
    if (stripComments(cur)) {
      const lead = cur.length - cur.trimStart().length
      out.push({ sql: cur.trim(), from: start + lead, to: end })
    }
    cur = ''
    start = end
  }
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    const two = text.substr(i, 2)
    if (two === '--') {
      let j = text.indexOf('\n', i)
      if (j < 0) j = n
      cur += text.slice(i, j)
      i = j
    } else if (two === '/*' && pg) {
      let depth = 1 // Postgres comments nest
      let j = i + 2
      while (j < n && depth > 0) {
        if (text.startsWith('/*', j)) (depth++, (j += 2))
        else if (text.startsWith('*/', j)) (depth--, (j += 2))
        else j++
      }
      cur += text.slice(i, j)
      i = j
    } else if (two === '/*') {
      let j = text.indexOf('*/', i + 2)
      j = j < 0 ? n : j + 2
      cur += text.slice(i, j)
      i = j
    } else if (pg && c === '$' && !/[\w$]/.test(text[i - 1] ?? ' ') && /^\$(?:[A-Za-z_]\w*)?\$/.test(text.slice(i, i + 64))) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(text.slice(i, i + 64))![0] // $$ or $tag$
      let j = text.indexOf(tag, i + tag.length)
      j = j < 0 ? n : j + tag.length
      cur += text.slice(i, j)
      i = j
    } else if (pg && (c === 'E' || c === 'e') && text[i + 1] === "'" && !/[\w$]/.test(text[i - 1] ?? ' ')) {
      let j = i + 2 // E'...': backslash escapes
      while (j < n && text[j] !== "'") j += text[j] === '\\' ? 2 : 1
      j = Math.min(n, j + 1)
      cur += text.slice(i, j)
      i = j
    } else if (!pg && (c === 'q' || c === 'Q') && text[i + 1] === "'" && i + 2 < n && !/\s/.test(text[i + 2]) && !/[\w$#]/.test(text[i - 1] ?? ' ')) {
      const open = text[i + 2]
      const close = ({ '[': ']', '(': ')', '{': '}', '<': '>' } as Record<string, string>)[open] ?? open
      let j = text.indexOf(close + "'", i + 3)
      j = j < 0 ? n : j + 2
      cur += text.slice(i, j)
      i = j
    } else if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n) {
        if (text[j] === c) {
          if (text[j + 1] === c) j += 2 // doubled quote
          else break
        } else j++
      }
      j = Math.min(n, j + 1)
      cur += text.slice(i, j)
      i = j
    } else if (c === ';' && (pg || !PLSQL.test(stripComments(cur)))) {
      flush(i + 1)
      i++
    } else if (!pg && c === '/' && /(^|\n)[ \t]*$/.test(cur) && /^[ \t]*(\r?\n|$)/.test(text.slice(i + 1))) {
      flush(i + 1) // a line with only "/"
      i++
    } else {
      cur += c
      i++
    }
  }
  flush(n)
  return out
}
