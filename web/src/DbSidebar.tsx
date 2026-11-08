import { useEffect, useState } from 'react'
import { dbDescribe, dbSchemas, dbTables, quoteName, type DbView, type TableInfo, type TableRef } from './dbApi'
import { message, where, type DbState } from './dbState'
import { ChevronDownIcon, ChevronIcon, EditIcon, PlusIcon, ReloadIcon, TrashIcon } from './icons'

// Database sidebar: connections and the schema tree.

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return v
}

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
              onDoubleClick={() => dbs.insertSql(`SELECT * FROM ${quoteName(t.schema, conn.kind)}.${quoteName(t.name, conn.kind)};`)}
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
