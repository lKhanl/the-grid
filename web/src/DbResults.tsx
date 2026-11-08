import { useEffect, useMemo, useRef, useState } from 'react'
import type { RunState, Tab } from './dbState'
import { CloseIcon } from './icons'

// Result panel of the Database workbench: one tab per statement, a virtual grid.

export function ResultPane({ run, maxRows, page, select, close, closeAll }: { run: RunState; maxRows: number; page: (offset: number) => void; select: (i: number) => void; close: (i: number) => void; closeAll: () => void }) {
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
