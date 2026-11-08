import { lazy, Suspense, useRef, useState } from 'react'
import { ResultPane } from './DbResults'
import { ROW_OPTIONS, where, type DbState } from './dbState'
import type { SqlEditorHandle } from './SqlEditor'
import { DatabaseIcon, PlayIcon, PlusIcon, StopIcon } from './icons'
// CodeMirror is ~400 KB: only fetched and parsed when a SQL editor is actually shown
const SqlEditor = lazy(() => import('./SqlEditor').then((m) => ({ default: m.SqlEditor })))

// The Database panel: the workbench (editor and result) is here; its parts live in
// dbState.ts (shared state), DbSidebar.tsx, DbResults.tsx and DbForm.tsx.
export { useDatabase, type DbState } from './dbState'
export { DbSidebar } from './DbSidebar'
export { DbForm } from './DbForm'

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
        key={`${c.name}|${c.kind}`} /* another connection: a fresh editor with its own text and undo history */
        value={dbs.sql}
        rev={dbs.sqlRev}
        onChange={dbs.setSql}
        onRun={dbs.exec}
        handle={editor}
        connection={c.name}
        kind={c.kind}
        placeholderText={(c.kind === 'postgres' ? 'SELECT now()' : 'SELECT * FROM dual') + '\n\nCtrl+Enter runs the selection (or everything), Ctrl+Shift+Enter the statement under the cursor. Double-click a table on the left to write a SELECT.'}
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
