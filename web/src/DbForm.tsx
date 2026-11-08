import { useState } from 'react'
import { dbSave, dbTest, type DbConn, type DbKind, type DbMode, type DbView, type McpAccess, type SslMode } from './dbApi'
import { message } from './dbState'
import { CloseIcon } from './icons'

// Form to add or edit a database connection.

const blank = (kind: DbKind): DbConn =>
  kind === 'postgres'
    ? { name: '', kind, host: '', port: 5432, database: '', sslMode: 'prefer', user: '', password: '', autoCommit: false, mcp: 'readonly' }
    : { name: '', kind, mode: 'service', host: '', port: 1521, service: '', user: '', password: '', autoCommit: false, mcp: 'readonly' }
const KIND_LABEL: Record<DbKind, string> = { oracle: 'Oracle', postgres: 'PostgreSQL' }
const DEFAULT_PORT: Record<DbKind, number> = { oracle: 1521, postgres: 5432 }

export function DbForm({
  editing,
  kinds,
  onClose,
  onSaved,
}: {
  editing: DbView | null
  /** the drivers in this build; empty = an older server, assume both */
  kinds: DbKind[]
  onClose: () => void
  onSaved: (v: DbView, old: string | null) => void
}) {
  const offered: DbKind[] = kinds.length ? kinds : ['oracle', 'postgres']
  const [c, setC] = useState<DbConn>(() => (editing ? { ...editing, password: '' } : blank(offered[0])))
  const missing = !offered.includes(c.kind) // a saved connection whose driver this build lacks
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<{ ok: boolean; text: string } | 'running' | null>(null)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof DbConn>(k: K, v: DbConn[K]) => setC((cur) => ({ ...cur, [k]: v }))
  // another kind: its own defaults, and the port follows unless it was changed by hand
  const setKind = (kind: DbKind) =>
    setC((cur) => ({
      ...cur,
      kind,
      port: !cur.port || cur.port === DEFAULT_PORT[cur.kind] ? DEFAULT_PORT[kind] : cur.port,
      mode: kind === 'oracle' ? (cur.mode ?? 'service') : undefined,
      sslMode: kind === 'postgres' ? (cur.sslMode ?? 'prefer') : undefined,
    }))
  const pg = c.kind === 'postgres'

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
          {(offered.length > 1 || missing) && (
            <label className="field">
              <span>Database</span>
              <select value={c.kind} onChange={(e) => setKind(e.target.value as DbKind)}>
                {[...offered, ...(missing ? [c.kind] : [])].map((k) => (
                  <option key={k} value={k} disabled={!offered.includes(k)}>
                    {KIND_LABEL[k]}
                    {offered.includes(k) ? '' : ' (not in this build)'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!pg && (
            <label className="field">
              <span>Connect with</span>
              <select value={c.mode} onChange={(e) => set('mode', e.target.value as DbMode)}>
                <option value="service">Host, port and service name</option>
                <option value="sid">Host, port and SID</option>
                <option value="tns">TNS descriptor or alias</option>
              </select>
            </label>
          )}
          {pg || c.mode !== 'tns' ? (
            <div className="grid-2">
              <label className="field">
                <span>Host</span>
                <input value={c.host ?? ''} onChange={(e) => set('host', e.target.value)} placeholder="db.example.com" spellCheck={false} />
              </label>
              <label className="field narrow">
                <span>Port</span>
                <input type="number" value={c.port ?? DEFAULT_PORT[c.kind]} onChange={(e) => set('port', Number(e.target.value))} />
              </label>
            </div>
          ) : null}
          {pg && (
            <div className="grid-2">
              <label className="field">
                <span>Database name</span>
                <input value={c.database ?? ''} onChange={(e) => set('database', e.target.value)} placeholder="orders" spellCheck={false} />
              </label>
              <label className="field narrow">
                <span>SSL</span>
                <select value={c.sslMode ?? 'prefer'} onChange={(e) => set('sslMode', e.target.value as SslMode)} title="disable: never · prefer: if the server offers it · require: always, without checking the certificate · verify-full: check the certificate and the host name">
                  <option value="disable">disable</option>
                  <option value="allow">allow</option>
                  <option value="prefer">prefer</option>
                  <option value="require">require</option>
                  <option value="verify-ca">verify-ca</option>
                  <option value="verify-full">verify-full</option>
                </select>
              </label>
            </div>
          )}
          {!pg && c.mode === 'service' && (
            <label className="field">
              <span>Service name</span>
              <input value={c.service ?? ''} onChange={(e) => set('service', e.target.value)} placeholder="ORCLPDB1" spellCheck={false} />
            </label>
          )}
          {!pg && c.mode === 'sid' && (
            <label className="field">
              <span>SID</span>
              <input value={c.sid ?? ''} onChange={(e) => set('sid', e.target.value)} placeholder="ORCL" spellCheck={false} />
            </label>
          )}
          {!pg && c.mode === 'tns' && (
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
