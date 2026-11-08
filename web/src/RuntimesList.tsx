import type { State } from './api'
import { PlusIcon, RuntimeTypeIcon, WarnIcon } from './icons'
import { Btn } from './ui'

/** Runtimes panel in the sidebar; a click opens the runtime form (null = new). */
export function RuntimesList({ state, onOpen }: { state: State | null; onOpen: (name: string | null) => void }) {
  const services = state?.services ?? []
  return (
    <>
      <div className="sidebar-head divided">
        <span>Runtimes</span>
        <Btn icon={<PlusIcon size={14} />} label="New" title="New runtime (java / node / script)" kind="text small" onClick={() => onOpen(null)} />
      </div>
      {state?.runtimes.map((r) => {
        const users = services.filter((s) => s.runtimes?.includes(r.name)).map((s) => s.name)
        return (
          <div
            key={r.name}
            className="rt-item"
            onClick={() => onOpen(r.name)}
            title={`${r.type} · ${r.home}${r.error ? `\n⚠ ${r.error}` : ''}${users.length ? `\nUsed by ${users.join(', ')}` : ''}`}
          >
            <RuntimeTypeIcon type={r.type} size={18} />
            <span className="name">{r.name}</span>
            {r.error && (
              <span className="rt-warn">
                <WarnIcon size={14} />
              </span>
            )}
          </div>
        )
      })}
      {state && state.runtimes.length === 0 && (
        <div className="empty rt-empty">
          No runtimes yet.
          <Btn icon={<PlusIcon size={14} />} label="Add a runtime" title="New runtime" kind="text" onClick={() => onOpen(null)} />
        </div>
      )}
    </>
  )
}
