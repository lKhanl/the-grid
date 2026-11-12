import { useEffect, useMemo, useState } from 'react'
import { dbDescribe, dbSchemas, dbTables, quoteName, type DbView, type TableInfo, type TableRef } from './dbApi'
import { message, where, type DbState } from './dbState'
import { Btn } from './ui'
import { ChevronDownIcon, ChevronIcon, EditIcon, PlusIcon, RefreshIcon, TrashIcon } from './icons'

// Database sidebar: connections and the schema tree.

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return v
}

const aiAccess = {
  readonly: 'AI agents (MCP): read-only, SELECT queries only',
  readwrite: 'AI agents (MCP): may read and change data',
  off: 'Not shared with AI agents',
}

export function DbSidebar({ dbs }: { dbs: DbState }) {
  const groups = useMemo(() => {
    const m = new Map<string, DbView[]>()
    for (const c of dbs.conns) {
      const g = c.group ?? ''
      if (!m.has(g)) m.set(g, [])
      m.get(g)!.push(c)
    }
    return [...m.entries()]
  }, [dbs.conns])

  return (
    <>
      <div className="sidebar-head divided">
        <span>Database</span>
        <span className="head-actions">
          <button className={`icon-btn ${dbs.loading ? 'spin' : ''}`} title="Refresh (also re-reads connections.json)" onClick={dbs.refresh}>
            <RefreshIcon size={14} />
          </button>
          <Btn icon={<PlusIcon size={14} />} label="New" title="New connection (Oracle / PostgreSQL)" kind="text small" onClick={() => dbs.openForm(null)} />
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
      <ConnGroups dbs={dbs} groups={groups} />
      {dbs.current && <SchemaTree key={dbs.current.name} dbs={dbs} conn={dbs.current} />}
    </>
  )
}

function ConnGroups({ dbs, groups }: { dbs: DbState; groups: [string, DbView[]][] }) {
  // drag & drop reordering inside a group, and moving whole groups
  const [drag, setDrag] = useState<{ name: string; group: string } | null>(null)
  const [dropAt, setDropAt] = useState<{ name: string; after: boolean } | null>(null)
  const [dragGroup, setDragGroup] = useState<string | null>(null)
  const [groupDropAt, setGroupDropAt] = useState<{ group: string; after: boolean } | null>(null)

  const endDrag = () => {
    setDrag(null)
    setDropAt(null)
    setDragGroup(null)
    setGroupDropAt(null)
  }

  /** All connection names in the displayed group order (after a drag). */
  const names = () => groups.flatMap(([, list]) => list.map((c) => c.name))
  /** groups map name -> group, for the reorder call. */
  const groupMap = () => {
    const m: Record<string, string> = {}
    for (const [g, list] of groups) for (const c of list) m[c.name] = g
    return m
  }

  function moveService(name: string, target: string, after: boolean) {
    if (name === target) return
    const all = names()
    const group = dbs.conns.find((c) => c.name === name)?.group ?? ''
    const slots = dbs.conns.flatMap((c, i) => ((c.group ?? '') === group ? [i] : []))
    const members = slots.map((i) => all[i]).filter((n) => n !== name)
    const at = members.indexOf(target) + (after ? 1 : 0)
    members.splice(at, 0, name)
    const next = [...all]
    slots.forEach((i, k) => (next[i] = members[k]))
    dbs.reorder(next, groupMap())
  }

  function moveGroup(name: string, target: string, after: boolean) {
    if (name === target) return
    const order = groups.map(([g]) => g).filter((g) => g !== name)
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, name)
    dbs.reorder(order.flatMap((g) => groups.find(([x]) => x === g)![1].map((c) => c.name)), groupMap())
  }

  /** Move a connection into another group (drops at the end of that group). */
  function moveToGroup(name: string, targetGroup: string) {
    if ((dbs.conns.find((c) => c.name === name)?.group ?? '') === targetGroup) return
    const all = names()
    const next = all.filter((n) => n !== name)
    // build the groups map with the new group for the moved connection
    const gm = groupMap()
    gm[name] = targetGroup
    dbs.reorder(next, gm)
  }

  return (
    <>
      {groups.map(([group, list]) => (
        <div
          key={group}
          className={`group ${dragGroup === group ? 'dragging' : ''} ${
            groupDropAt?.group === group && dragGroup !== group ? (groupDropAt.after ? 'drop-after' : 'drop-before') : ''
          }`}
          onDragOver={(e) => {
            if (dragGroup === null) return // a connection is being dragged: rows handle it
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            const r = e.currentTarget.getBoundingClientRect()
            const after = e.clientY > r.top + r.height / 2
            if (groupDropAt?.group !== group || groupDropAt.after !== after) setGroupDropAt({ group, after })
          }}
          onDrop={(e) => {
            if (dragGroup === null) return
            e.preventDefault()
            if (groupDropAt) moveGroup(dragGroup, groupDropAt.group, groupDropAt.after)
            endDrag()
          }}
        >
          {group && (
            <div
              className="group-head"
              draggable
              title="Click to collapse or expand, drag to reorder"
              onClick={() => dbs.toggleGroup(group)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', 'group:' + group)
                setDragGroup(group)
              }}
              onDragEnd={endDrag}
            >
              <span className={`group-chevron ${dbs.collapsed.has(group) ? '' : 'open'}`}>
                <ChevronIcon size={13} />
              </span>
              <span className="group-name">{group}</span>
              {dbs.collapsed.has(group) && (
                <span className="group-count">
                  {list.some((c) => c.connected) && <span className="dot dot-running" />}
                  {list.filter((c) => c.connected).length}/{list.length}
                </span>
              )}
              <span className="row-actions">
                <Btn icon={<PlusIcon size={14} />} title={`New connection in ${group}`} onClick={() => dbs.openForm(null, group)} />
              </span>
            </div>
          )}
          {!(group && dbs.collapsed.has(group)) &&
            list.map((c) => (
              <div
                key={c.name}
                className={`row db-conn ${c.name === dbs.current?.name ? 'selected' : ''} ${group ? 'indent' : ''} ${
                  drag?.name === c.name ? 'dragging' : ''
                } ${dropAt?.name === c.name && drag?.name !== c.name ? (dropAt.after ? 'drop-after' : 'drop-before') : ''}`}
                onClick={() => dbs.select(c.name)}
                title={`${c.user}@${where(c)}\n${aiAccess[c.mcp] ?? aiAccess.readonly}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', c.name)
                  setDrag({ name: c.name, group })
                }}
                onDragOver={(e) => {
                  if (!drag) return // a group is being dragged: the group handles it
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  const r = e.currentTarget.getBoundingClientRect()
                  const after = e.clientY > r.top + r.height / 2
                  if (dropAt?.name !== c.name || dropAt.after !== after) setDropAt({ name: c.name, after })
                }}
                onDrop={(e) => {
                  if (!drag) return
                  e.preventDefault()
                  e.stopPropagation()
                  if (drag.group !== group) {
                    // dropped onto a row in another group: move the connection there
                    moveToGroup(drag.name, group)
                  } else if (dropAt) {
                    moveService(drag.name, dropAt.name, dropAt.after)
                  }
                  endDrag()
                }}
                onDragEnd={endDrag}
              >
                <span className={`db-dot ${c.connected ? 'on' : ''} ${c.inTx ? 'tx' : ''}`} title={c.inTx ? 'Uncommitted changes' : c.connected ? 'Connected' : 'Not connected'} />
                <span className="name">{c.name}</span>
                <span className="meta">{c.mcp === 'off' ? '' : c.mcp === 'readwrite' ? 'AI: write' : 'AI: read'}</span>
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
        </div>
      ))}
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
  const insertSelect = (t: TableRef) =>
    dbs.insertSql(`SELECT * FROM ${quoteName(t.schema, conn.kind)}.${quoteName(t.name, conn.kind)};`)
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
              title={`${t.type.toLowerCase()}${t.comment ? ` — ${t.comment}` : ''}\nClick: columns · SELECT button: SELECT * into the editor`}
              onClick={(e) => {
                if (e.detail === 1) toggle(t) // a fast second click does not close it again
              }}
            >
              {info ? <ChevronDownIcon size={13} /> : <ChevronIcon size={13} />}
              <span className="name">{t.name}</span>
              {t.type !== 'TABLE' && <span className="muted small db-kind">{t.type === 'VIEW' ? 'view' : 'mview'}</span>}
              <button
                className="db-select-btn"
                title="Insert SELECT * into the editor"
                onClick={(e) => {
                  e.stopPropagation()
                  insertSelect(t)
                }}
              >
                SELECT
              </button>
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
