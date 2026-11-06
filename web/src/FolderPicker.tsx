import { useEffect, useState } from 'react'
import { listDir, type DirListing } from './api'
import { CloseIcon, FileIcon, FolderIcon, JavaIcon, NodeIcon, UpIcon } from './icons'

interface Props {
  /** where to start; "" = the config folder, "~" = the user's home */
  start: string
  title?: string
  /** also list *.yml / *.yaml files; clicking one picks it (no "use this folder") */
  yamlFiles?: boolean
  onPick: (path: string) => void
  onClose: () => void
}

// The browser cannot open a native folder dialog, so the server lists folders.
export function FolderPicker({ start, title = 'Choose working directory', yamlFiles, onPick, onClose }: Props) {
  const [path, setPath] = useState(start)
  const [list, setList] = useState<DirListing | null>(null)
  const [typed, setTyped] = useState('')

  useEffect(() => {
    let live = true
    listDir(path).then(
      (l) => {
        if (!live) return
        setList(l)
        setTyped(l.path)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [path])

  const sep = list?.path.includes('\\') ? '\\' : '/'
  const join = (name: string) => (list!.path.endsWith(sep) ? list!.path + name : list!.path + sep + name)

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="modal modal-narrow picker" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <div className="spacer" />
          <button className="btn" title="Close (Esc)" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="picker-bar">
          <button className="btn" title="Up one folder" disabled={!list?.parent} onClick={() => list?.parent && setPath(list.parent)}>
            <UpIcon size={15} />
          </button>
          <input
            className="mono"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setPath(typed)}
            spellCheck={false}
          />
          {list?.roots?.map((r) => (
            <button key={r} className="btn text small" onClick={() => setPath(r)}>
              {r.replace('\\', '')}
            </button>
          ))}
        </div>
        <div className="picker-list">
          {list?.error && <div className="field-error picker-msg">{list.error}</div>}
          {list && !list.error && list.dirs.length === 0 && !(yamlFiles && list.files?.length) && (
            <div className="muted picker-msg">{yamlFiles ? 'No sub-folders or YAML files.' : 'No sub-folders.'}</div>
          )}
          {list?.dirs.map((d) => (
            <button key={d.name} className={`picker-row ${d.kind ? 'project' : ''}`} onClick={() => setPath(join(d.name))}>
              <span className={`rt-icon ${d.kind === 'maven' ? 'rt-icon-java' : d.kind === 'node' ? 'rt-icon-node' : 'picker-folder'}`}>
                {d.kind === 'maven' ? <JavaIcon size={17} /> : d.kind === 'node' ? <NodeIcon size={17} /> : <FolderIcon size={17} />}
              </span>
              <span className="name">{d.name}</span>
              {d.kind && <span className="muted small">{d.kind === 'maven' ? 'Maven project' : 'Node project'}</span>}
            </button>
          ))}
          {yamlFiles &&
            list?.files?.map((f) => (
              <button key={f} className="picker-row project" onClick={() => onPick(join(f))}>
                <span className="rt-icon picker-folder">
                  <FileIcon size={17} />
                </span>
                <span className="name">{f}</span>
              </button>
            ))}
        </div>
        <div className="modal-foot">
          <span className="muted small picker-current" title={list?.path}>
            {list?.path}
          </span>
          <div className="spacer" />
          <button className="btn text" onClick={onClose}>
            <span>Cancel</span>
          </button>
          {!yamlFiles && (
            <button className="btn text primary" disabled={!list || !!list.error} onClick={() => list && onPick(list.path)}>
              <span>Use this folder</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
