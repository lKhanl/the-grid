import { check, HEADERS } from './api'

export type DbKind = 'oracle' | 'postgres'
export type DbMode = 'service' | 'sid' | 'tns'
export type SslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'

/** An unquoted name as the database stores it: Oracle upper case, Postgres lower case. */
export const foldName = (n: string, kind: DbKind) => (kind === 'postgres' ? n.toLowerCase() : n.toUpperCase())
/** A name as it must be written in SQL: unusual ones (other case, spaces, ...) keep their quotes. */
export const quoteName = (n: string, kind: DbKind) =>
  (kind === 'postgres' ? /^[a-z_][a-z0-9_$]*$/ : /^[A-Z][A-Z0-9_$#]*$/).test(n) ? n : `"${n.replace(/"/g, '""')}"`
export type McpAccess = 'off' | 'readonly' | 'readwrite'

export interface DbConn {
  name: string
  kind: DbKind
  /** Oracle only */
  mode?: DbMode
  host?: string
  port?: number
  service?: string
  sid?: string
  tns?: string
  tnsAdmin?: string
  /** Postgres only */
  database?: string
  sslMode?: SslMode
  user: string
  password?: string
  autoCommit: boolean
  mcp: McpAccess
  /** optional, groups connections like services */
  group?: string
}

export interface DbView extends DbConn {
  hasPassword: boolean
  connected: boolean
  inTx: boolean
}

export interface DbColumn {
  name: string
  type: string
}

export interface DbResult {
  kind: 'rows' | 'update'
  columns?: DbColumn[]
  rows?: (string | null)[][]
  truncated?: boolean
  offset?: number
  rowsAffected?: number
  ms: number
  inTx: boolean
}

export interface TableRef {
  schema: string
  name: string
  type: string
  comment?: string
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  pk?: boolean
  comment?: string
}

export interface TableInfo {
  schema: string
  name: string
  type: string
  comment?: string
  columns: ColumnInfo[]
  primaryKey?: string[]
  unique?: { name: string; columns: string[] }[]
  foreignKeys?: { name: string; columns: string[]; ref?: string }[]
  indexes?: { name: string; unique: boolean; columns: string[] }[]
}

const JSON_HEADERS = { ...HEADERS, 'Content-Type': 'application/json' }
const enc = encodeURIComponent

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await check(await fetch(path, { method: 'POST', headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) }))
  return r.json()
}

/** Re-read connections.json on the server (it may have been edited outside the Grid). */
export async function dbReloadFile() {
  return post<{ added: string[]; removed: string[]; changed: string[]; total: number }>('/api/dbconn/reload')
}

/** Persist a new order for all connections, and optionally a new group per name. */
export async function dbReorder(names: string[], groups: Record<string, string>) {
  await check(await fetch('/api/dbconn/order', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ names, groups }) }))
}

export async function dbList(): Promise<DbView[]> {
  return (await check(await fetch('/api/dbconn'))).json()
}

export async function dbSave(old: string | null, c: DbConn): Promise<DbView> {
  const r = await check(
    await fetch(old ? `/api/dbconn/${enc(old)}` : '/api/dbconn', { method: old ? 'PUT' : 'POST', headers: JSON_HEADERS, body: JSON.stringify(c) }),
  )
  return r.json()
}

export async function dbDelete(name: string) {
  await check(await fetch(`/api/dbconn/${enc(name)}`, { method: 'DELETE', headers: HEADERS }))
}

export const dbTest = (c: DbConn, existing: string | null) =>
  post<{ ok: boolean; message?: string; error?: string }>('/api/dbconn/test', { ...c, existing: existing ?? '' })

/** Read the alias names defined in a tnsnames.ora file. */
export async function dbTnsAliases(path: string): Promise<string[]> {
  const r = await check(await fetch(`/api/dbconn/tns?path=${enc(path)}`))
  return (await r.json()).aliases ?? []
}

export const dbRun = (name: string, sql: string, maxRows: number, offset = 0) => post<DbResult>(`/api/db/${enc(name)}/query`, { sql, maxRows, offset })
export const dbCommit = (name: string) => post<DbView>(`/api/db/${enc(name)}/commit`)
export const dbRollback = (name: string) => post<DbView>(`/api/db/${enc(name)}/rollback`)
export const dbCancel = (name: string) => post<DbView>(`/api/db/${enc(name)}/cancel`)
export const dbDisconnect = (name: string) => post<DbView>(`/api/db/${enc(name)}/disconnect`)

export async function dbSchemas(name: string): Promise<{ schemas: string[]; current: string }> {
  return (await check(await fetch(`/api/db/${enc(name)}/schemas`))).json()
}

export async function dbTables(name: string, schema: string, q: string): Promise<{ tables: TableRef[]; truncated: boolean }> {
  return (await check(await fetch(`/api/db/${enc(name)}/tables?schema=${enc(schema)}&q=${enc(q)}&limit=300`))).json()
}

export async function dbDescribe(name: string, schema: string, table: string): Promise<TableInfo> {
  return (await check(await fetch(`/api/db/${enc(name)}/describe?schema=${enc(schema)}&table=${enc(table)}`))).json()
}
