import type { RefObject } from 'react'
import type { Action, Info, State } from './api'
import { ClearIcon, EditIcon, ExternalIcon, HammerIcon, PlayIcon, RestartIcon, SearchIcon, StopIcon } from './icons'
import { SHORTCUTS } from './SettingsPanel'
import { ServiceStats } from './ServiceStats'
import { ACTIVE, Btn, StatusIcon, statusLabel, uptime } from './ui'

interface Props {
  current: Info | null
  state: State | null
  run: (target: string, action: Action) => void
  onEdit: (name: string) => void
  filter: string
  setFilter: (f: string) => void
  filterRef: RefObject<HTMLInputElement | null>
}

/** Toolbar and command line above the log of the selected service. */
export function ServiceHeader({ current, state, run, onEdit, filter, setFilter, filterRef }: Props) {
  return (
    <>
      {current ? (
        <div className="toolbar">
          <StatusIcon status={current.status} type={current.type} size={18} />
          <span className="title">{current.name}</span>
          <span className={`badge badge-${current.status}`}>{statusLabel(current)}</span>
          {current.startedAt ? (
            <span className="muted uptime" title={current.pid ? `pid ${current.pid}` : undefined}>
              {current.status === 'starting' ? 'starting for' : current.status === 'building' ? 'building for' : 'up'} {uptime(current.startedAt)}
            </span>
          ) : null}
          {current.restarts > 0 && <span className="muted restarts">restarts {current.restarts}</span>}
          <ServiceStats current={current} />
          {current.url && (
            <a className="link" href={current.url} target="_blank" rel="noreferrer" title={current.url}>
              <span className="link-text">{current.url}</span> <ExternalIcon size={13} />
            </a>
          )}
          <div className="spacer" />
          {ACTIVE.has(current.status) ? (
            <Btn icon={<StopIcon />} label="Stop" title="Derezz (s)" kind="text red" onClick={() => run(current.name, 'stop')} />
          ) : (
            <Btn icon={<PlayIcon />} label="Start" title="Start (s)" kind="text green" onClick={() => run(current.name, 'start')} />
          )}
          <Btn icon={<RestartIcon />} label="Restart" title="Restart (r)" kind="text" onClick={() => run(current.name, 'restart')} />
          <Btn icon={<ClearIcon />} label="Clear" title="Clear log (c)" kind="text" onClick={() => run(current.name, 'clear')} />
          <Btn icon={<EditIcon />} label="Edit" title="Edit service (e)" kind="text" onClick={() => onEdit(current.name)} />
          <label className="filter-wrap">
            <SearchIcon size={14} />
          <input
            ref={filterRef}
            className="filter"
            placeholder="Filter log  ( / )"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          </label>
        </div>
      ) : (
        <div className="no-service">
          <div className="no-service-shortcuts">
            <h3>Keyboard shortcuts</h3>
            {SHORTCUTS.map(([title, list]) => (
              <div key={title} className="shortcut-group">
                <div className="shortcut-title">{title}</div>
                {list.map(([keys, label]) => (
                  <div key={label} className="hint">
                    <span className="keys">
                      {keys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </span>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      {current && (
        <div className="subbar" title={current.cwd}>
          {current.runtimes?.map((name) => {
            const rt = state?.runtimes.find((r) => r.name === name)
            return (
              <span
                key={name}
                className={`chip chip-${rt?.type ?? 'script'} ${rt?.error ? 'chip-error' : ''}`}
                title={rt ? `${rt.type}: ${rt.home}${rt.error ? `\n⚠ ${rt.error}` : ''}` : 'unknown runtime'}
              >
                {name}
              </span>
            )
          })}
          {!current.runtimes?.length && (
            <span className="chip chip-system" title="java / mvn / node come from the system PATH">
              system PATH
            </span>
          )}
          {current.build && (
            <span className="sub-step" title="Runs before every start">
              <HammerIcon size={12} />
              <code>{current.build}</code>
            </span>
          )}
          <span className="sub-step">
            {current.build && <PlayIcon size={11} />}
            <code>{current.command}</code>
          </span>
          <span className="muted"> in {current.cwd}</span>
          {current.dependsOn?.length ? <span className="muted"> · after {current.dependsOn.join(', ')}</span> : null}
          {current.ready ? <span className="muted"> · ready on {current.ready}</span> : null}
        </div>
      )}
    </>
  )
}
