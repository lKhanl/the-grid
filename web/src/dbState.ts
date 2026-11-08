import { useCallback, useEffect, useState } from 'react'
import { dbCancel, dbCommit, dbDelete, dbDisconnect, dbList, dbRollback, dbRun, type DbConn, type DbResult, type DbView } from './dbApi'
import { splitSql } from './sqlSplit'

// State shared by the Database sidebar and the workbench.

export interface Tab {
  ran: string // the statement that produced result / error
  result?: DbResult
  error?: string
}

export interface RunState {
  running?: boolean
  tabs: Tab[] // one per statement of the last run
  active: number
  total?: number // statements in the run in progress
  hidden?: boolean // every tab was closed: no result panel until the next run
}

const NO_RUN: RunState = { tabs: [], active: 0, hidden: true } // nothing run yet: no result panel

export interface DbState {
  conns: DbView[]
  current: DbView | null
  select: (name: string) => void
  reload: () => void
  loading: boolean
  error: string | null
  setError: (e: string | null) => void
  form: { editing: DbView | null } | null
  openForm: (editing: DbView | null) => void
  closeForm: () => void
  saved: (v: DbView, old: string | null) => void
  remove: (name: string) => void
  sql: string
  /** changes when the text is replaced from outside (not by typing) */
  sqlRev: number
  setSql: (text: string) => void
  insertSql: (text: string) => void
  run: RunState
  exec: (text: string) => void
  pageTo: (offset: number) => void
  selectTab: (i: number) => void
  closeTab: (i: number) => void
  closeAll: () => void
  stop: () => void
  commit: () => void
  rollback: () => void
  disconnect: () => void
  maxRows: number
  setMaxRows: (n: number) => void
}

export const ROW_OPTIONS = [10, 50, 100, 500, 1000]
const DEFAULT_ROWS = 500

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function loadJSON<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '') as T
  } catch {
    return fallback
  }
}

export function useDatabase(active: boolean): DbState {
  const [conns, setConns] = useState<DbView[]>([])
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem('grid.db.selected'))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<{ editing: DbView | null } | null>(null)
  const [sqls, setSqls] = useState<Record<string, string>>(() => loadJSON('grid.db.sql', {}))
  const [runs, setRuns] = useState<Record<string, RunState>>({})
  const [sqlRev, setSqlRev] = useState(0)
  const [maxRows, setMaxRowsState] = useState(() => {
    const n = Number(localStorage.getItem('grid.db.maxrows'))
    return ROW_OPTIONS.includes(n) ? n : DEFAULT_ROWS // an older, larger saved choice falls back
  })

  const current = conns.find((c) => c.name === selected) ?? null
  const patch = useCallback((v: DbView) => setConns((list) => list.map((c) => (c.name === v.name ? v : c))), [])

  const reload = useCallback(() => {
    setLoading(true)
    dbList().then(
      (list) => {
        setConns(list)
        setSelected((cur) => (cur && list.some((c) => c.name === cur) ? cur : (list[0]?.name ?? null)))
        setError(null)
        setLoading(false)
      },
      (e) => {
        setError(message(e))
        setLoading(false)
      },
    )
  }, [])
  useEffect(() => {
    if (active) reload()
  }, [active, reload])
  useEffect(() => {
    if (selected) localStorage.setItem('grid.db.selected', selected)
  }, [selected])

  const name = current?.name ?? ''
  const setRun = (n: string, r: RunState) => setRuns((cur) => ({ ...cur, [n]: r }))
  const setSql = (text: string) => {
    if (!name) return
    setSqls((cur) => {
      const next = { ...cur, [name]: text }
      localStorage.setItem('grid.db.sql', JSON.stringify(next))
      return next
    })
  }
  const sql = sqls[name] ?? ''

  const connected = (n: string, result?: DbResult) => setConns((list) => list.map((c) => (c.name === n ? { ...c, connected: true, inTx: result ? result.inTx : c.inTx } : c)))
  // Runs every statement of the text one after the other (stopping at the first error); each gets a tab.
  const exec = async (text: string) => {
    const stmts = splitSql(text, current?.kind)
    if (!name || !stmts.length || runs[name]?.running) return
    const n = name
    const tabs: Tab[] = []
    for (let k = 0; k < stmts.length; k++) {
      setRun(n, { running: true, tabs: [...tabs], active: Math.max(0, tabs.length - 1), total: stmts.length })
      try {
        const result = await dbRun(n, stmts[k], maxRows, 0)
        tabs.push({ ran: stmts[k], result })
        connected(n, result)
      } catch (e) {
        tabs.push({ ran: stmts[k], error: message(e) })
        reload() // the session may have been reset
        break
      }
    }
    setRun(n, { tabs, active: tabs.length - 1 })
  }
  // another page of the statement in the active tab
  const pageTo = (offset: number) => {
    const cur = runs[name]
    const tab = cur?.tabs[cur.active]
    if (!name || !cur || !tab || cur.running) return
    const n = name
    setRun(n, { ...cur, running: true, total: 1 })
    dbRun(n, tab.ran, maxRows, offset).then(
      (result) => {
        setRun(n, { tabs: cur.tabs.map((t, i) => (i === cur.active ? { ran: t.ran, result } : t)), active: cur.active })
        connected(n, result)
      },
      (e) => {
        setRun(n, { tabs: cur.tabs.map((t, i) => (i === cur.active ? { ran: t.ran, error: message(e) } : t)), active: cur.active })
        reload()
      },
    )
  }
  const act = (fn: (n: string) => Promise<DbView>) => () => {
    if (!name) return
    fn(name).then(patch, (e) => setError(message(e)))
  }

  return {
    conns,
    current,
    select: setSelected,
    reload,
    loading,
    error,
    setError,
    form,
    openForm: (editing) => setForm({ editing }),
    closeForm: () => setForm(null),
    saved: (v, old) => {
      setForm(null)
      setConns((list) => {
        const rest = list.filter((c) => c.name !== (old ?? v.name) && c.name !== v.name)
        return [...rest, v].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      })
      if (old && sqls[old] !== undefined && old !== v.name) {
        setSqls((cur) => {
          const next = { ...cur, [v.name]: cur[old] }
          delete next[old]
          localStorage.setItem('grid.db.sql', JSON.stringify(next))
          return next
        })
      }
      setSelected(v.name)
    },
    remove: (n) => {
      if (!window.confirm(`Delete the connection "${n}"? (The database itself is not touched.)`)) return
      dbDelete(n).then(reload, (e) => setError(message(e)))
    },
    sql,
    sqlRev,
    setSql,
    insertSql: (text) => {
      setSql(sql.trim() ? sql.replace(/\s*$/, '') + '\n\n' + text : text)
      setSqlRev((r) => r + 1)
    },
    run: runs[name] ?? NO_RUN,
    exec,
    pageTo,
    closeTab: (i) =>
      name &&
      setRuns((cur) => {
        const r = cur[name]
        if (!r || r.running) return cur
        const tabs = r.tabs.filter((_, k) => k !== i)
        if (!tabs.length) return { ...cur, [name]: { tabs: [], active: 0, hidden: true } }
        const active = i < r.active || r.active >= tabs.length ? Math.max(0, r.active - 1) : r.active
        return { ...cur, [name]: { ...r, tabs, active } }
      }),
    closeAll: () => name && setRuns((cur) => (cur[name]?.running ? cur : { ...cur, [name]: { tabs: [], active: 0, hidden: true } })),
    selectTab: (i) => name && setRuns((cur) => (cur[name] ? { ...cur, [name]: { ...cur[name], active: i } } : cur)),
    stop: () => {
      if (name) dbCancel(name).catch(() => {})
    },
    commit: act(dbCommit),
    rollback: act(dbRollback),
    disconnect: act(dbDisconnect),
    maxRows,
    setMaxRows: (n) => {
      localStorage.setItem('grid.db.maxrows', String(n))
      setMaxRowsState(n)
    },
  }
}

/** Where a connection points, for titles and the toolbar. */
export const where = (c: DbConn) =>
  c.kind === 'postgres'
    ? `${c.host}:${c.port}/${c.database}`
    : c.mode === 'tns'
      ? `TNS ${c.tns?.startsWith('(') ? '(…)' : c.tns}`
      : `${c.host}:${c.port}${c.mode === 'sid' ? ` SID ${c.sid}` : `/${c.service}`}`
