import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { dbDescribe, dbSchemas, dbTables, type TableInfo, type TableRef } from './dbApi'
import { statementAt } from './sqlSplit'

// Table, view, schema and column suggestions from the connected database, fetched on demand and
// kept for a minute. Keywords come from the SQL language itself.

const TTL = 60_000
const NOT_ALIAS = new Set(['WHERE', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL', 'SET', 'GROUP', 'ORDER', 'HAVING', 'UNION', 'CONNECT', 'FETCH', 'VALUES', 'USING', 'START', 'MINUS', 'INTERSECT', 'SELECT', 'FOR', 'WITH'])
const ID = '(?:"[^"]+"|[A-Za-z_][\\w$#]*)'
const TABLE_REF = new RegExp(`^\\s*(${ID}(?:\\s*\\.\\s*${ID})?)(?:\\s+(?:AS\\s+)?(${ID}))?`, 'i')

const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, -1) : s.toUpperCase())
// an unusual name (lower case, spaces, ...) must keep its quotes
const insertName = (n: string) => (/^[A-Z][A-Z0-9_$#]*$/.test(n) ? n : `"${n}"`)

interface Ref {
  schema: string // '' = the user's own schema
  table: string
  alias: string
}

/** The tables a statement reads from or writes to, with their aliases. */
export function tablesOf(sqlText: string): Ref[] {
  const out: Ref[] = []
  const add = (part: string) => {
    if (part.trimStart().startsWith('(')) return // a sub-select
    const m = TABLE_REF.exec(part.replace(/\bON\b[\s\S]*$/i, ''))
    if (!m) return
    const parts = m[1].split('.').map((x) => unquote(x.trim()))
    const alias = m[2] && !NOT_ALIAS.has(m[2].toUpperCase()) ? unquote(m[2]) : ''
    out.push({ schema: parts.length > 1 ? parts[0] : '', table: parts[parts.length - 1], alias })
  }
  const from = /\bFROM\b([\s\S]*?)(?=\bWHERE\b|\bGROUP\b|\bORDER\b|\bHAVING\b|\bCONNECT\b|\bUNION\b|\bMINUS\b|\bFETCH\b|\bSET\b|;|$)/gi
  for (let m; (m = from.exec(sqlText)); ) m[1].split(/\bJOIN\b|,/i).forEach(add)
  const other = /\b(?:UPDATE|INTO)\s+([^(]*?)(?=\bSET\b|\bVALUES\b|\(|;|$)/gi
  for (let m; (m = other.exec(sqlText)); ) add(m[1])
  return out
}

/** `exclusive`: after `x.` or FROM only names make sense, so no keywords are mixed in. */
export type NameResult = CompletionResult & { exclusive?: boolean }

export function createCompletion(connection: string): (ctx: CompletionContext) => Promise<NameResult | null> {
  const memo = new Map<string, { at: number; value: Promise<unknown> }>()
  const cached = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const hit = memo.get(key)
    if (hit && Date.now() - hit.at < TTL) return hit.value as Promise<T>
    const value = load()
    value.catch(() => memo.delete(key)) // a failure is not remembered
    memo.set(key, { at: Date.now(), value })
    return value
  }
  const schemas = () => cached('schemas', () => dbSchemas(connection))
  const tables = (schema: string, q: string) => cached(`t|${schema}|${q}`, () => dbTables(connection, schema, q))
  const describe = (schema: string, table: string) => cached(`d|${schema}|${table}`, () => dbDescribe(connection, schema, table))

  const tableOption = (t: TableRef, qualified: boolean): Completion => ({
    label: t.name,
    apply: (qualified ? `${insertName(t.schema)}.` : '') + insertName(t.name),
    type: t.type === 'TABLE' ? 'class' : 'interface',
    detail: qualified ? t.schema : t.type.toLowerCase(),
    info: t.comment || undefined,
    boost: 2,
  })
  const columnOptions = (info: TableInfo, owner: string): Completion[] =>
    info.columns.map((c) => ({
      label: c.name,
      apply: insertName(c.name),
      type: 'property',
      detail: `${c.type}${c.pk ? ' · PK' : ''}${owner ? ` · ${owner}` : ''}`,
      info: c.comment || undefined,
      boost: c.pk ? 3 : 2,
    }))

  return async (ctx: CompletionContext): Promise<NameResult | null> => {
    // [qualifier .] word, where the qualifier may be a schema, a table or an alias
    const m = ctx.matchBefore(/(?:(?:"[^"]+"|[A-Za-z_][\w$#]*)\s*\.\s*)?[\w$#]*/)
    if (!m) return null
    if (m.from === m.to && !ctx.explicit) return null
    const text = ctx.state.doc.toString()
    const stmt = statementAt(text, ctx.pos)?.sql ?? text
    const dot = m.text.lastIndexOf('.')
    const tail = m.text.slice(dot + 1)
    const from = m.from + dot + 1 + (tail.length - tail.trimStart().length)
    const word = tail.trim()
    try {
      const refs = tablesOf(stmt)
      if (dot >= 0) {
        const q = unquote(m.text.slice(0, dot).trim())
        const ref = refs.find((r) => r.alias === q) ?? refs.find((r) => r.table === q && !r.alias)
        if (ref) return { from, options: columnOptions(await describe(ref.schema, ref.table), ''), validFor: /^[\w$#]*$/, exclusive: true }
        const { schemas: names, current } = await schemas()
        if (names.includes(q) || q === current) {
          const { tables: list } = await tables(q, word)
          return { from, options: list.map((t) => tableOption(t, false)), validFor: /^[\w$#]*$/, exclusive: true }
        }
        return { from, options: columnOptions(await describe('', q), ''), validFor: /^[\w$#]*$/, exclusive: true } // a table of the own schema
      }
      const before = text.slice(0, m.from).trimEnd().match(/(\w+)$/)?.[1]?.toUpperCase()
      const options: Completion[] = []
      if (before && ['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE'].includes(before)) {
        const [{ tables: list }, { schemas: names }] = await Promise.all([tables('', word), schemas()])
        options.push(...list.map((t) => tableOption(t, false)))
        options.push(...names.map((s): Completion => ({ label: s, apply: insertName(s) + '.', type: 'namespace', detail: 'schema', boost: 1 })))
      } else {
        // columns of the tables of this statement, plus the aliases themselves
        const infos = await Promise.all(refs.slice(0, 6).map((r) => describe(r.schema, r.table).then((i) => ({ r, i }), () => null)))
        for (const x of infos) if (x) options.push(...columnOptions(x.i, refs.length > 1 ? x.r.alias || x.r.table : ''))
        for (const r of refs) if (r.alias) options.push({ label: r.alias, type: 'variable', detail: r.table, boost: 1 })
        if (word.length >= 2) {
          const { tables: list } = await tables('', word)
          options.push(...list.slice(0, 30).map((t) => ({ ...tableOption(t, false), boost: 0 })))
        }
      }
      return options.length ? { from, options, validFor: /^[\w$#]*$/, exclusive: before !== undefined && ['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE'].includes(before) } : null
    } catch {
      return null // not connected / no right: keywords still work
    }
  }
}
