import { useEffect, useState } from 'react'
import { forgetWorkspace, listWorkspaces, openWorkspace, type State, type Workspace } from './api'
import { CloseIcon, FolderIcon } from './icons'
import { FolderPicker } from './FolderPicker'

interface Props {
  current: string
  /** no workspace is open yet: say so, and keep the dialog until one is picked */
  required?: boolean
  onClose: () => void
  /** called with the new state after a successful switch */
  onSwitched: (state: State) => void
}

function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

/** Pick which grid.yaml (workspace) the Grid runs. Recent ones come from ~/.grid. */
export function Workspaces({ current, required, onClose, onSwitched }: Props) {
  const [recent, setRecent] = useState<Workspace[]>([])
  const [typed, setTyped] = useState('')
  const [browse, setBrowse] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refresh = () => listWorkspaces().then((r) => setRecent(r.workspaces), () => {})
  useEffect(() => {
    refresh()
  }, [])

  const open = async (path: string) => {
    if (path === current && path !== '') return onClose()
    setBusy(true)
    setErr(null)
    try {
      onSwitched(await openWorkspace(path))
      onClose()
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !required && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && !browse && !required && onClose()}
    >
      <div className="modal modal-narrow" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>Workspaces</h2>
          <div className="spacer" />
          {!required && (
            <button className="btn" title="Close (Esc)" onClick={onClose}>
              <CloseIcon />
            </button>
          )}
        </div>
        <div className="picker-list">
          {recent.length === 0 && <div className="muted picker-msg">No workspace is open yet. Open a workspace file below.</div>}
          {recent.map((w) => (
            <div key={w.path} className="picker-row ws-row" onClick={() => !busy && open(w.path)}>
              <span className="rt-icon picker-folder">
                <FolderIcon size={17} />
              </span>
              <span className="name" title={w.path}>
                {w.name || w.path}
                {w.path === current && <span className="muted small"> · open</span>}
                <div className="muted small mono ws-path">
                  {w.path}
                </div>
              </span>
              <span className="muted small">{ago(w.lastOpened)}</span>
              {w.path !== current && (
                <button
                  className="btn"
                  title="Forget (the file is not touched)"
                  onClick={(e) => {
                    e.stopPropagation()
                    forgetWorkspace(w.path).then(refresh, (x) => setErr(x.message))
                  }}
                >
                  <CloseIcon />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="picker-bar">
          <input
            className="mono"
            placeholder="path to a .yml file or its folder"
            title="Path to a workspace .yml / .yaml file, or a folder that has grid.yaml"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && typed.trim() && !busy && open(typed.trim())}
            spellCheck={false}
          />
          <button className="btn text small" onClick={() => setBrowse(true)}>
            Browse…
          </button>
          <button className="btn text primary" disabled={!typed.trim() || busy} onClick={() => open(typed.trim())}>
            <span>Open</span>
          </button>
        </div>
        <div className="modal-foot">
          <span className={err ? 'field-error' : 'muted small'}>
            {err ?? (required ? 'Pick the .yml / .yaml file that describes your services.' : 'Switching stops every running service of the current workspace.')}
          </span>
        </div>
      </div>
      {browse && (
        <FolderPicker
          start="~"
          title="Choose a workspace file (.yml / .yaml)"
          yamlFiles
          onClose={() => setBrowse(false)}
          onPick={(p) => {
            setBrowse(false)
            open(p)
          }}
        />
      )}
    </div>
  )
}
