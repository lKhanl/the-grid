import { splitSql } from './sqlSplit'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  dbCancel,
  dbCommit,
  dbDelete,
  dbDescribe,
  dbDisconnect,
  dbList,
  dbRollback,
  dbRun,
  dbSave,
  dbSchemas,
  dbTables,
  dbTest,
  type DbConn,
  type DbMode,
  type DbResult,
  type DbView,
  type McpAccess,
  type TableInfo,
  type TableRef,
} from './dbApi'
import type { SqlEditorHandle } from './SqlEditor'
// CodeMirror is ~400 KB: only fetched and parsed when a SQL editor is actually shown
const SqlEditor = lazy(() => import('./SqlEditor').then((m) => ({ default: m.SqlEditor })))
import { ChevronDownIcon, ChevronIcon, CloseIcon, DatabaseIcon, EditIcon, PlayIcon, PlusIcon, ReloadIcon, StopIcon, TrashIcon } from './icons'

// ---- state shared by the sidebar and the workbench ----

interface Tab {
  ran: string // the statement that produced result / error
  result?: DbResult
  error?: string
}

interface RunState {
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

const ROW_OPTIONS = [10, 50, 100, 500, 1000]
const DEFAULT_ROWS = 500

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

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
    const stmts = splitSql(text)
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

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return v
}

const where = (c: DbConn) => (c.mode === 'tns' ? `TNS ${c.tns?.startsWith('(') ? '(…)' : c.tns}` : `${c.host}:${c.port}${c.mode === 'sid' ? ` SID ${c.sid}` : `/${c.service}`}`)

const quoteName = (n: string) => (/^[A-Z][A-Z0-9_$#]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`)

// ---- sidebar: connections and the schema tree ----

export function DbSidebar({ dbs }: { dbs: DbState }) {
  return (
    <>
      <div className="sidebar-head divided">
        <span>Database</span>
        <span className="head-actions">
          <button className={`icon-btn ${dbs.loading ? 'spin' : ''}`} title="Refresh" onClick={dbs.reload}>
            <ReloadIcon size={14} />
          </button>
          <button className="icon-btn" title="New connection" onClick={() => dbs.openForm(null)}>
            <PlusIcon size={15} />
          </button>
        </span>
      </div>
      {dbs.error && <div className="db-msg field-error">{dbs.error}</div>}
      {dbs.conns.length === 0 && !dbs.loading && (
        <div className="muted db-msg db-empty-side">
          <span>No connections yet.</span>
          <button className="btn text small" onClick={() => dbs.openForm(null)}>
            <PlusIcon size={14} />
            <span>New connection</span>
          </button>
        </div>
      )}
      {dbs.conns.map((c) => (
        <div key={c.name} className={`row ${c.name === dbs.current?.name ? 'selected' : ''}`} onClick={() => dbs.select(c.name)} title={`${c.user}@${where(c)}`}>
          <span className={`db-dot ${c.connected ? 'on' : ''} ${c.inTx ? 'tx' : ''}`} title={c.inTx ? 'Uncommitted changes' : c.connected ? 'Connected' : 'Not connected'} />
          <span className="name">{c.name}</span>
          <span className="meta">{c.mcp === 'off' ? '' : c.mcp === 'readwrite' ? 'AI rw' : 'AI ro'}</span>
          <span className="row-actions">
            <button
              className="icon-btn"
              title="Edit"
              onClick={(e) => {
                e.stopPropagation()
                dbs.openForm(c)
              }}
            >
              <EditIcon size={14} />
            </button>
            <button
              className="icon-btn"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation()
                dbs.remove(c.name)
              }}
            >
              <TrashIcon size={14} />
            </button>
          </span>
        </div>
      ))}
      {dbs.current && <SchemaTree key={dbs.current.name} dbs={dbs} conn={dbs.current} />}
    </>
  )
}

function SchemaTree({ dbs, conn }: { dbs: DbState; conn: DbView }) {
  const [schemas, setSchemas] = useState<string[]>([])
  const [schema, setSchema] = useState('')
  const [q, setQ] = useState('')
  const dq = useDebounced(q, 300)
  const [tables, setTables] = useState<TableRef[]>([])
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<Record<string, TableInfo | 'loading' | { error: string }>>({})

  useEffect(() => {
    let live = true
    setBusy(true)
    dbSchemas(conn.name).then(
      (r) => {
        if (!live) return
        setSchemas(r.schemas)
        setSchema(r.current)
        setError(null)
      },
      (e) => {
        if (!live) return
        setError(message(e))
        setBusy(false)
      },
    )
    return () => {
      live = false
    }
  }, [conn.name])

  useEffect(() => {
    if (!schema) return
    let live = true
    setBusy(true)
    dbTables(conn.name, schema, dq).then(
      (r) => {
        if (!live) return
        setTables(r.tables)
        setMore(r.truncated)
        setError(null)
        setBusy(false)
      },
      (e) => {
        if (!live) return
        setError(message(e))
        setBusy(false)
      },
    )
    return () => {
      live = false
    }
  }, [conn.name, schema, dq])

  const key = (t: TableRef) => `${t.schema}.${t.name}`
  const toggle = (t: TableRef) => {
    const k = key(t)
    if (open[k]) {
      setOpen(({ [k]: _gone, ...rest }) => rest)
      return
    }
    setOpen((cur) => ({ ...cur, [k]: 'loading' }))
    dbDescribe(conn.name, t.schema, t.name).then(
      (info) => setOpen((cur) => (cur[k] ? { ...cur, [k]: info } : cur)),
      (e) => setOpen((cur) => (cur[k] ? { ...cur, [k]: { error: message(e) } } : cur)),
    )
  }

  return (
    <div className="db-tree">
      <div className="db-tree-head">
        <select value={schema} onChange={(e) => setSchema(e.target.value)} title="Schema">
          {schemas.includes(schema) ? null : <option value={schema}>{schema}</option>}
          {schemas.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find table…" spellCheck={false} />
      </div>
      {error && <div className="db-msg field-error">{error}</div>}
      {busy && !tables.length && !error && <div className="muted db-msg">Loading…</div>}
      {!busy && !error && tables.length === 0 && schema && <div className="muted db-msg">No tables or views.</div>}
      {tables.map((t) => {
        const k = key(t)
        const info = open[k]
        return (
          <div key={k}>
            <div
              className="db-table"
              title={`${t.type.toLowerCase()}${t.comment ? ` — ${t.comment}` : ''}\nClick: columns · Double-click: SELECT *`}
              onClick={() => toggle(t)}
              onDoubleClick={() => dbs.insertSql(`SELECT * FROM ${quoteName(t.schema)}.${quoteName(t.name)};`)}
            >
              {info ? <ChevronDownIcon size={13} /> : <ChevronIcon size={13} />}
              <span className="name">{t.name}</span>
              {t.type !== 'TABLE' && <span className="muted small">{t.type === 'VIEW' ? 'view' : 'mview'}</span>}
            </div>
            {info === 'loading' && <div className="db-col muted">Loading…</div>}
            {info && typeof info === 'object' && 'error' in info && <div className="db-col field-error">{info.error}</div>}
            {info && typeof info === 'object' && 'columns' in info && (
              <div className="db-cols">
                {info.columns.map((c) => (
                  <div key={c.name} className="db-col" title={c.comment}>
                    <span className={c.pk ? 'db-pk' : ''}>{c.name}</span>
                    <span className="muted" title={c.nullable ? undefined : 'NOT NULL'}>
                      {c.type}
                      {c.nullable ? '' : ' •'}
                    </span>
                  </div>
                ))}
                {info.foreignKeys?.map((f) => (
                  <div key={f.name} className="db-col muted small" title={f.name}>
                    FK ({f.columns.join(', ')}) → {f.ref}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
      {more && <div className="muted db-msg small">More tables exist: type in the search box.</div>}
    </div>
  )
}

// ---- workbench: editor and result ----

const MIN_RESULT_H = 90
const MIN_EDITOR_H = 90

function loadResultHeight() {
  const h = Number(localStorage.getItem('grid.db.resultH'))
  return h >= MIN_RESULT_H ? h : 320
}

export function DbWorkbench({ dbs }: { dbs: DbState }) {
  const c = dbs.current
  const editor = useRef<SqlEditorHandle | null>(null)
  const work = useRef<HTMLDivElement>(null)
  const [resultH, setResultH] = useState(loadResultHeight)
  const [dragging, setDragging] = useState(false)

  // The result panel's top edge is dragged like the terminal's; the editor takes what is left.
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = work.current
    if (!box) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    setDragging(true)
    const bottom = box.getBoundingClientRect().bottom
    const top = (box.querySelector('.sql-editor') as HTMLElement | null)?.getBoundingClientRect().top ?? box.getBoundingClientRect().top
    let h = resultH
    const move = (ev: PointerEvent) => {
      h = Math.round(Math.max(MIN_RESULT_H, Math.min(bottom - top - MIN_EDITOR_H, bottom - ev.clientY)))
      setResultH(h)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setDragging(false)
      localStorage.setItem('grid.db.resultH', String(h))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  if (!c) {
    return (
      <div className="db-work">
        <div className="toolbar muted">No connection selected</div>
        <div className="db-empty muted">
          <DatabaseIcon size={36} />
          <div>Add a connection to browse tables and run SQL.</div>
          <button className="btn text" onClick={() => dbs.openForm(null)}>
            <PlusIcon size={14} />
            <span>New connection</span>
          </button>
        </div>
      </div>
    )
  }

  const runNow = () => dbs.exec(editor.current?.runText() ?? dbs.sql)
  const running = !!dbs.run.running

  return (
    <div className="db-work" ref={work}>
      <div className="toolbar">
        <DatabaseIcon size={18} />
        <span className="title">{c.name}</span>
        <span className={`badge ${c.connected ? 'badge-running' : ''}`}>{c.connected ? 'connected' : 'not connected'}</span>
        <span className="muted mono-small" title={`${c.user}@${where(c)}`}>
          {c.user}@{where(c)}
        </span>
        <div className="spacer" />
        {running ? (
          <button className="btn text red" title="Stop the running statement" onClick={dbs.stop}>
            <StopIcon />
            <span>Stop</span>
          </button>
        ) : (
          <button className="btn text green" title="Run the selection, or everything (Ctrl+Enter)" onClick={runNow}>
            <PlayIcon />
            <span>Run</span>
          </button>
        )}
        {!c.autoCommit && (
          <>
            <button className="btn text" title="Commit the changes" disabled={!c.inTx || running} onClick={dbs.commit}>
              <span>Commit</span>
            </button>
            <button className="btn text" title="Roll the changes back" disabled={!c.inTx || running} onClick={dbs.rollback}>
              <span>Rollback</span>
            </button>
          </>
        )}
        <select className="db-select" value={dbs.maxRows} onChange={(e) => dbs.setMaxRows(Number(e.target.value))} title="Most rows to fetch">
          {ROW_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n.toLocaleString('en-US')} rows
            </option>
          ))}
        </select>
        {c.connected && (
          <button className="btn text" title={c.inTx ? 'Disconnect (uncommitted changes are rolled back)' : 'Disconnect'} onClick={dbs.disconnect}>
            <span>Disconnect</span>
          </button>
        )}
      </div>
      {c.inTx && (
        <div className="db-tx-bar">
          Uncommitted changes. They are lost if you disconnect or close the Grid. <button className="btn text small" onClick={dbs.commit}>Commit</button>
          <button className="btn text small" onClick={dbs.rollback}>
            Rollback
          </button>
        </div>
      )}
      <Suspense fallback={<div className="sql-editor" />}>
      <SqlEditor
        key={c.name} /* another connection: a fresh editor with its own text and undo history */
        value={dbs.sql}
        rev={dbs.sqlRev}
        onChange={dbs.setSql}
        onRun={dbs.exec}
        handle={editor}
        connection={c.name}
        placeholderText={'SELECT * FROM dual\n\nCtrl+Enter runs the selection (or everything), Ctrl+Shift+Enter the statement under the cursor. Double-click a table on the left to write a SELECT.'}
      />
      </Suspense>
      {!dbs.run.hidden && (
        <div className={`db-result-panel ${dragging ? 'dragging' : ''}`} style={{ height: resultH }}>
          <div className="db-resizer" onPointerDown={startDrag} title="Drag to resize" />
          <ResultPane run={dbs.run} maxRows={dbs.maxRows} page={dbs.pageTo} select={dbs.selectTab} close={dbs.closeTab} closeAll={dbs.closeAll} />
        </div>
      )}
    </div>
  )
}

function ResultPane({ run, maxRows, page, select, close, closeAll }: { run: RunState; maxRows: number; page: (offset: number) => void; select: (i: number) => void; close: (i: number) => void; closeAll: () => void }) {
  const tab = run.tabs[run.active]
  if (!tab) return run.running ? <div className="db-result db-status muted">Running…</div> : <div className="db-result db-hint muted">Run a statement to see its result here.</div>
  return (
    <div className="db-result-wrap">
      {(
        <div className="db-tabs">
          <div className="db-tabs-list">
          {run.tabs.map((t, i) => (
            <div key={i} className={`db-tab ${i === run.active ? 'active' : ''} ${t.error ? 'failed' : ''}`} title={t.ran} onClick={() => select(i)}>
              <span className="db-tab-n">{i + 1}</span>
              <span className="db-tab-sql">{t.ran.replace(/\s+/g, ' ').slice(0, 28)}</span>
              {t.result?.kind === 'rows' && <span className="db-tab-count">{(t.result.rows?.length ?? 0).toLocaleString('en-US')}{t.result.truncated ? '+' : ''}</span>}
              {!run.running && (
                <button
                  className="db-tab-close"
                  title="Close"
                  onClick={(e) => {
                    e.stopPropagation()
                    close(i)
                  }}
                >
                  <CloseIcon size={12} />
                </button>
              )}
            </div>
          ))}
          {run.running && <span className="muted small db-tabs-run">{(run.total ?? 1) > 1 ? `Running ${run.tabs.length + 1}/${run.total}…` : 'Running…'}</span>}
          </div>
          {!run.running && (
            <button className="db-tab-close db-tabs-closeall" title="Close the result panel" onClick={closeAll}>
              <CloseIcon size={14} />
            </button>
          )}
        </div>
      )}
      <ResultBody key={run.active} tab={tab} maxRows={maxRows} page={page} />
    </div>
  )
}

function ResultBody({ tab, maxRows, page }: { tab: Tab; maxRows: number; page: (offset: number) => void }) {
  const [note, setNote] = useState('')
  const r = tab.result
  const flash = (t: string) => {
    setNote(t)
    window.setTimeout(() => setNote(''), 2000)
  }

  if (tab.error)
    return (
      <div className="db-result">
        <pre className="db-error">{tab.error}</pre>
      </div>
    )
  if (!r) return null
  if (r.kind === 'update') {
    return (
      <div className="db-result db-status">
        {r.rowsAffected ?? 0} row{r.rowsAffected === 1 ? '' : 's'} affected · {r.ms} ms
        {r.inTx && <span className="db-uncommitted"> · not committed yet</span>}
      </div>
    )
  }
  const cols = r.columns ?? []
  const rows = r.rows ?? []
  const off = r.offset ?? 0
  const paged = off > 0 || r.truncated
  return (
    <div className="db-result">
      <div className="db-status">
        {paged ? (
          <span className="db-pager">
            <button className="btn text small" disabled={off === 0} title="Previous page" onClick={() => page(Math.max(0, off - maxRows))}>
              ‹ Prev {maxRows.toLocaleString('en-US')}
            </button>
            <span className="db-range">{rows.length > 0 ? `Rows ${(off + 1).toLocaleString('en-US')}–${(off + rows.length).toLocaleString('en-US')}` : 'No rows'}</span>
            <button className="btn text small" disabled={!r.truncated} title="Next page" onClick={() => page(off + maxRows)}>
              Next {maxRows.toLocaleString('en-US')} ›
            </button>
          </span>
        ) : (
          <span>{`${rows.length.toLocaleString('en-US')} row${rows.length === 1 ? '' : 's'}`}</span>
        )}
        <span className="muted small">{r.ms} ms</span>
        <span className="spacer" />
        {note && <span className="muted small">{note}</span>}
        <button
          className="btn text small"
          title="Copy the table as tab-separated text"
          onClick={() => navigator.clipboard.writeText(toTSV(cols.map((c) => c.name), rows)).then(() => flash('Copied'), () => flash('Copy failed'))}
        >
          Copy
        </button>
        <button className="btn text small" title="Download as CSV" onClick={() => download('result.csv', toCSV(cols.map((c) => c.name), rows))}>
          CSV
        </button>
      </div>
      {cols.length > 0 && <ResultGrid columns={cols.map((c) => c.name)} types={cols.map((c) => c.type)} rows={rows} start={off} onCopy={(v) => navigator.clipboard.writeText(v).then(() => flash('Cell copied'), () => {})} />}
    </div>
  )
}

const ROW_H = 24

function ResultGrid({ columns, types, rows, start, onCopy }: { columns: string[]; types: string[]; rows: (string | null)[][]; start: number; onCopy: (v: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(0)
  const [height, setHeight] = useState(300)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    box.current?.scrollTo({ top: 0, left: 0 })
    setTop(0)
  }, [rows])

  const numW = Math.max(40, String(start + rows.length).length * 9 + 22)
  const widths = useMemo(
    () =>
      columns.map((name, i) => {
        let n = name.length + 2
        for (let r = 0; r < Math.min(rows.length, 200); r++) n = Math.max(n, (rows[r][i] ?? 'NULL').length)
        return Math.min(48, Math.max(6, n)) * 8 + 18
      }),
    [columns, rows],
  )
  const template = `${numW}px ${widths.map((w) => `${w}px`).join(' ')}`
  const total = numW + widths.reduce((a, b) => a + b, 0)
  const first = Math.max(0, Math.floor(top / ROW_H) - 8)
  const last = Math.min(rows.length, Math.ceil((top + height) / ROW_H) + 8)
  const numeric = types.map((t) => /NUMBER|FLOAT|INT|DECIMAL|BINARY_DOUBLE/i.test(t))

  return (
    <div className="db-grid" ref={box} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
      <div style={{ width: total, minWidth: '100%' }}>
        <div className="db-grid-head" style={{ gridTemplateColumns: template }}>
          <div className="db-cell db-rownum" />
          {columns.map((c, i) => (
            <div key={i} className={`db-cell ${numeric[i] ? 'num' : ''}`} title={`${c} ${types[i]}`}>
              {c}
            </div>
          ))}
        </div>
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          {rows.slice(first, last).map((row, k) => {
            const i = first + k
            return (
              <div key={i} className="db-grid-row" style={{ gridTemplateColumns: template, top: i * ROW_H, height: ROW_H }}>
                <div className="db-cell db-rownum">{start + i + 1}</div>
                {row.map((v, j) => (
                  <div
                    key={j}
                    className={`db-cell ${numeric[j] ? 'num' : ''} ${v === null ? 'null' : ''}`}
                    title={v ?? 'NULL'}
                    onDoubleClick={() => onCopy(v ?? '')}
                  >
                    {v === null ? 'NULL' : v}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function toTSV(cols: string[], rows: (string | null)[][]) {
  const cell = (v: string | null) => (v ?? '').replace(/[\t\r\n]+/g, ' ')
  return [cols.join('\t'), ...rows.map((r) => r.map(cell).join('\t'))].join('\n')
}

function toCSV(cols: string[], rows: (string | null)[][]) {
  const cell = (v: string | null) => (v === null ? '' : /[",\r\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return '\ufeff' + [cols.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n')
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---- connection form ----

const blank = (): DbConn => ({ name: '', kind: 'oracle', mode: 'service', host: '', port: 1521, service: '', user: '', password: '', autoCommit: false, mcp: 'readonly' })

export function DbForm({ editing, onClose, onSaved }: { editing: DbView | null; onClose: () => void; onSaved: (v: DbView, old: string | null) => void }) {
  const [c, setC] = useState<DbConn>(() => (editing ? { ...editing, password: '' } : blank()))
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<{ ok: boolean; text: string } | 'running' | null>(null)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof DbConn>(k: K, v: DbConn[K]) => setC((cur) => ({ ...cur, [k]: v }))

  const doTest = () => {
    setTest('running')
    dbTest(c, editing?.name ?? null).then(
      (r) => setTest({ ok: r.ok, text: r.ok ? (r.message ?? 'Connected') : (r.error ?? 'Failed') }),
      (e) => setTest({ ok: false, text: message(e) }),
    )
  }
  const save = () => {
    setSaving(true)
    setError(null)
    dbSave(editing?.name ?? null, c).then(
      (v) => onSaved(v, editing?.name ?? null),
      (e) => {
        setError(message(e))
        setSaving(false)
      },
    )
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="modal modal-narrow" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{editing ? `Edit ${editing.name}` : 'New database connection'}</h2>
          <div className="spacer" />
          <button className="btn" title="Close (Esc)" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span>Name</span>
            <input value={c.name} onChange={(e) => set('name', e.target.value)} placeholder="orders-dev" autoFocus spellCheck={false} />
          </label>
          <label className="field">
            <span>Connect with</span>
            <select value={c.mode} onChange={(e) => set('mode', e.target.value as DbMode)}>
              <option value="service">Host, port and service name</option>
              <option value="sid">Host, port and SID</option>
              <option value="tns">TNS descriptor or alias</option>
            </select>
          </label>
          {c.mode !== 'tns' ? (
            <div className="grid-2">
              <label className="field">
                <span>Host</span>
                <input value={c.host ?? ''} onChange={(e) => set('host', e.target.value)} placeholder="db.example.com" spellCheck={false} />
              </label>
              <label className="field narrow">
                <span>Port</span>
                <input type="number" value={c.port ?? 1521} onChange={(e) => set('port', Number(e.target.value))} />
              </label>
            </div>
          ) : null}
          {c.mode === 'service' && (
            <label className="field">
              <span>Service name</span>
              <input value={c.service ?? ''} onChange={(e) => set('service', e.target.value)} placeholder="ORCLPDB1" spellCheck={false} />
            </label>
          )}
          {c.mode === 'sid' && (
            <label className="field">
              <span>SID</span>
              <input value={c.sid ?? ''} onChange={(e) => set('sid', e.target.value)} placeholder="ORCL" spellCheck={false} />
            </label>
          )}
          {c.mode === 'tns' && (
            <>
              <label className="field">
                <span>Descriptor or alias</span>
                <textarea
                  className="mono"
                  rows={3}
                  value={c.tns ?? ''}
                  onChange={(e) => set('tns', e.target.value)}
                  placeholder={'(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=…)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=…)))\nor an alias from tnsnames.ora'}
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span>Folder with tnsnames.ora (for an alias; default: the TNS_ADMIN variable)</span>
                <input className="mono" value={c.tnsAdmin ?? ''} onChange={(e) => set('tnsAdmin', e.target.value)} placeholder="C:/oracle/network/admin" spellCheck={false} />
              </label>
            </>
          )}
          <div className="grid-2">
            <label className="field">
              <span>User</span>
              <input value={c.user} onChange={(e) => set('user', e.target.value)} spellCheck={false} autoComplete="off" />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={c.password ?? ''}
                onChange={(e) => set('password', e.target.value)}
                placeholder={editing?.hasPassword ? 'unchanged' : ''}
                autoComplete="new-password"
              />
            </label>
          </div>
          <div className="checks">
            <label className="check" title="Off: changes wait for Commit or Rollback (safer). On: every statement is committed at once.">
              <input type="checkbox" checked={c.autoCommit} onChange={(e) => set('autoCommit', e.target.checked)} />
              <span>Commit every statement automatically</span>
            </label>
          </div>
          <label className="field" style={{ marginTop: 12 }}>
            <span>AI access (MCP)</span>
            <select value={c.mcp} onChange={(e) => set('mcp', e.target.value as McpAccess)}>
              <option value="readonly">Read-only: SELECT only, in a read-only transaction</option>
              <option value="readwrite">Read and write: the AI may change data and structure</option>
              <option value="off">Not shared with AI</option>
            </select>
          </label>
          <div className="muted small">
            The password is stored as plain text in ~/.grid/connections.json (readable by your user only). Whatever the AI reads goes to the model provider.
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn text" onClick={doTest} disabled={test === 'running'}>
            <span>{test === 'running' ? 'Testing…' : 'Test connection'}</span>
          </button>
          <span className={test && test !== 'running' && !test.ok ? 'field-error' : 'muted small'} style={{ flex: 1, minWidth: 0 }}>
            {test && test !== 'running' ? test.text : error}
          </span>
          <button className="btn text" onClick={onClose}>
            <span>Cancel</span>
          </button>
          <button className="btn text primary" onClick={save} disabled={saving}>
            <span>{saving ? 'Saving…' : 'Save'}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
