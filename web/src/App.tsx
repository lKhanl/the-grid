import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { act, deleteService, fetchLogs, reload, reorderServices, LogStore, type Action, type Info, type RunnerEvent, type State } from './api'
import { LogView } from './LogView'
import { ChevronIcon, ClearIcon, SettingsIcon, EditIcon, GridIcon, HammerIcon, TrashIcon, RuntimeTypeIcon, RuntimesIcon, ServicesIcon, WarnIcon, ExternalIcon, PlayIcon, PlusIcon, ReloadIcon, RestartIcon, SearchIcon, StopIcon } from './icons'
import { ServiceForm } from './ServiceForm'
import { RuntimeForm } from './RuntimeForm'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { NeonBorder } from './NeonBorder'
import { applyTheme, loadTheme, type Theme } from './theme'

const ACTIVE = new Set(['starting', 'building', 'running', 'stopping'])
const BUILDS = new Set(['spring-boot', 'node'])

function uptime(ms?: number) {
  if (!ms) return ''
  let s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`
}

function statusLabel(i: Info) {
  if ((i.status === 'crashed' || i.status === 'exited') && i.exitCode !== undefined) return `${i.status} (${i.exitCode})`
  return i.status
}

function useTick(ms: number) {
  const [, set] = useState(0)
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), ms)
    return () => clearInterval(id)
  }, [ms])
}

function Dot({ status }: { status: Info['status'] }) {
  return <span className={`dot dot-${status}`} title={status} />
}

function Btn(props: { icon: ReactNode; label?: string; title: string; onClick: () => void; disabled?: boolean; kind?: string }) {
  return (
    <button
      className={`btn ${props.kind ?? ''}`}
      title={props.title}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation()
        props.onClick()
      }}
    >
      {props.icon}
      {props.label && <span>{props.label}</span>}
    </button>
  )
}

export default function App() {
  const store = useMemo(() => new LogStore(), [])
  const [state, setState] = useState<State | null>(null)
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem('grid.selected'))
  const [filter, setFilter] = useState('')
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unread, setUnread] = useState<Record<string, 'out' | 'err'>>({})
  const [form, setForm] = useState<{ editing: string | null; group?: string; cwd?: string } | null>(null)
  const [rtForm, setRtForm] = useState<{ editing: string | null } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; service: string } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  // drag & drop reordering inside a group
  const [drag, setDrag] = useState<{ name: string; group: string } | null>(null)
  const [dropAt, setDropAt] = useState<{ name: string; after: boolean } | null>(null)
  const [dragGroup, setDragGroup] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('grid.collapsed') ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const toggleGroup = (g: string) =>
    setCollapsed((c) => {
      const n = new Set(c)
      if (!n.delete(g)) n.add(g)
      localStorage.setItem('grid.collapsed', JSON.stringify([...n]))
      return n
    })
  const [groupDropAt, setGroupDropAt] = useState<{ group: string; after: boolean } | null>(null)
  const [neon, setNeon] = useState(() => localStorage.getItem('grid.neon') !== 'off')
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [panel, setPanel] = useState<'services' | 'runtimes' | 'settings'>(() => {
    const p = localStorage.getItem('grid.panel')
    return p === 'runtimes' || p === 'settings' ? p : 'services'
  }
  )
  const filterRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  useEffect(() => {
    if (selected) localStorage.setItem('grid.selected', selected)
  }, [selected])
  useEffect(() => localStorage.setItem('grid.panel', panel), [panel])
  useEffect(() => localStorage.setItem('grid.neon', neon ? 'on' : 'off'), [neon])
  useEffect(() => applyTheme(theme), [theme])

  // Deep links: #new, #new=group, #edit=service, #runtime=new, #runtime=name
  useEffect(() => {
    const open = () => {
      const h = decodeURIComponent(location.hash.slice(1))
      if (h === 'new' || h.startsWith('new=')) setForm({ editing: null, group: h.slice(4) || undefined })
      else if (h.startsWith('new-dir=')) setForm({ editing: null, cwd: h.slice(8) })
      else if (h.startsWith('edit=')) setForm({ editing: h.slice(5) })
      else if (h === 'runtimes' || h === 'services' || h === 'settings') setPanel(h)
      else if (h === 'theme=basic' || h === 'theme=grid') setTheme(h.slice(6) as Theme)
      else if (h.startsWith('runtime=')) setRtForm({ editing: h.slice(8) === 'new' ? null : h.slice(8) })
      if (h) history.replaceState(null, '', location.pathname)
    }
    open()
    window.addEventListener('hashchange', open)
    return () => window.removeEventListener('hashchange', open)
  }, [])

  // One SSE stream carries status changes and log lines for every service.
  useEffect(() => {
    const es = new EventSource('/api/events')
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (msg) => {
      const ev: RunnerEvent = JSON.parse(msg.data)
      if (ev.type === 'snapshot' && ev.state) {
        const st = ev.state
        setState(st)
        setSelected((cur) => (cur && st.services.some((s) => s.name === cur) ? cur : (st.services[0]?.name ?? null)))
        for (const s of st.services) {
          store.clear(s.name)
          fetchLogs(s.name).then((b) => store.replace(s.name, b), () => {})
        }
      } else if (ev.type === 'service' && ev.info) {
        const info = ev.info
        setState((st) => st && { ...st, services: st.services.map((s) => (s.name === info.name ? info : s)) })
      } else if (ev.type === 'log' && ev.service && ev.entry) {
        store.append(ev.service, ev.entry)
        const svc = ev.service
        if (svc !== selectedRef.current && ev.entry.s !== 'sys') {
          const isErr = /\b(ERROR|FATAL|Exception|ERR!)\b/.test(ev.entry.line)
          setUnread((u) => (u[svc] === 'err' || (u[svc] === 'out' && !isErr) ? u : { ...u, [svc]: isErr ? 'err' : 'out' }))
        }
      }
    }
    return () => es.close()
  }, [store])

  useEffect(() => {
    if (!selected) return
    setUnread((u) => {
      if (!u[selected]) return u
      const { [selected]: _, ...rest } = u
      return rest
    })
  }, [selected])

  const run = useCallback(
    (target: string, action: Action) => {
      setError(null)
      if (action === 'clear') store.clear(target)
      act(target, action).catch((e) => setError(`${action} ${target}: ${e.message}`))
    },
    [store],
  )

  const services = state?.services ?? []
  const groups = useMemo(() => {
    const m = new Map<string, Info[]>()
    for (const s of services) {
      const g = s.group || ''
      if (!m.has(g)) m.set(g, [])
      m.get(g)!.push(s)
    }
    return [...m.entries()]
  }, [services])
  // ↑/↓ walk only the services that are visible (collapsed groups are skipped)
  const ordered = useMemo(() => groups.flatMap(([g, list]) => (collapsed.has(g) ? [] : list)), [groups, collapsed])

  function saveOrder(next: string[]) {
    if (!state || next.every((n, i) => n === state.services[i]?.name)) return
    // show it right away; the server confirms with a snapshot
    setState((st) => st && { ...st, services: next.map((n) => st.services.find((s) => s.name === n)!) })
    reorderServices(next).catch((e) => setError(`reorder: ${e.message}`))
  }

  /** Move a whole group before/after another one; services keep their group. */
  function moveGroup(name: string, target: string, after: boolean) {
    if (name === target) return
    const order = groups.map(([g]) => g).filter((g) => g !== name)
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, name)
    saveOrder(order.flatMap((g) => groups.find(([x]) => x === g)![1].map((s) => s.name)))
  }

  const endDrag = () => {
    setDrag(null)
    setDropAt(null)
    setDragGroup(null)
    setGroupDropAt(null)
  }

  /** Move `name` before/after `target` (same group) and save the order. */
  function moveService(name: string, target: string, after: boolean) {
    if (!state || name === target) return
    const all = state.services.map((s) => s.name)
    const group = state.services.find((s) => s.name === name)?.group ?? ''
    const slots = state.services.flatMap((s, i) => ((s.group ?? '') === group ? [i] : []))
    const members = slots.map((i) => all[i]).filter((n) => n !== name)
    const at = members.indexOf(target) + (after ? 1 : 0)
    members.splice(at, 0, name)
    const next = [...all]
    slots.forEach((i, k) => (next[i] = members[k]))
    saveOrder(next)
  }
  const current = services.find((s) => s.name === selected) ?? null

  // Keyboard: ↑/↓ select, s start/stop, r restart, c clear, / filter, Esc clears filter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (form || rtForm || menu) return // the forms and the menu handle their own keys
      const typing =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement
      if (e.key === 'Escape' && e.target instanceof HTMLInputElement) {
        setFilter('')
        ;(e.target as HTMLInputElement).blur()
        return
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      const idx = ordered.findIndex((s) => s.name === selected)
      if (e.key === 'ArrowDown' || e.key === 'j') {
        const n = ordered[Math.min(ordered.length - 1, idx + 1)]
        if (n) setSelected(n.name)
        e.preventDefault()
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        const n = ordered[Math.max(0, idx - 1)]
        if (n) setSelected(n.name)
        e.preventDefault()
      } else if (e.key === '/') {
        filterRef.current?.focus()
        e.preventDefault()
      } else if (current && e.key === 's') {
        run(current.name, ACTIVE.has(current.status) ? 'stop' : 'start')
      } else if (current && e.key === 'r') {
        run(current.name, 'restart')
      } else if (current && e.key === 'c') {
        run(current.name, 'clear')
      } else if (e.key === 'n') {
        setForm({ editing: null, group: current?.group })
        e.preventDefault()
      } else if (current && e.key === 'e') {
        setForm({ editing: current.name })
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ordered, selected, current, run, form, rtForm, menu])

  useTick(1000)
  const runningCount = services.filter((s) => s.status === 'running').length

  return (
    <div className="app">
      {neon && theme === 'grid' && <NeonBorder />}
      <header className="topbar">
        <div className="brand">
          <span className="logo">
            <GridIcon size={22} />
          </span>
          <span className="brand-name">THE GRID</span>
          {state?.name && <span className="workspace">{state.name}</span>}
        </div>
        <div className="summary">
          {runningCount}/{services.length} on the grid
        </div>
        <div className="spacer" />
        {!connected && <div className="offline">disconnected, retrying…</div>}
        <Btn icon={<PlayIcon />} label="Start all" title="Start all" kind="text green" onClick={() => run('all', 'start')} />
        <Btn icon={<StopIcon />} label="Stop all" title="End of line: stop every program" kind="text red" onClick={() => run('all', 'stop')} />
        <Btn
          icon={<ReloadIcon />}
          label="Reload config"
          title={`Re-read ${state?.configPath ?? 'grid.yaml'}`}
          kind="text"
          onClick={() => reload().catch((e) => setError(`reload: ${e.message}`))}
        />
      </header>
      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <div className="main">
        <nav className="activitybar">
          <button
            className={`activity ${panel === 'services' ? 'on' : ''}`}
            aria-label="Services"
            onClick={() => setPanel('services')}
          >
            <ServicesIcon size={22} />
            <span className="activity-tip">Services</span>
            {runningCount > 0 && <span className="activity-badge">{runningCount}</span>}
          </button>
          <button
            className={`activity ${panel === 'runtimes' ? 'on' : ''}`}
            aria-label="Runtimes"
            onClick={() => setPanel('runtimes')}
          >
            <RuntimesIcon size={22} />
            <span className="activity-tip">Runtimes</span>
            {state?.runtimes.some((r) => r.error) && <span className="activity-badge warn">!</span>}
          </button>
          <div className="activity-spacer" />
          <button
            className={`activity ${panel === 'settings' ? 'on' : ''}`}
            aria-label="Settings"
            onClick={() => setPanel('settings')}
          >
            <SettingsIcon size={21} />
            <span className="activity-tip">Settings</span>
          </button>
        </nav>
        <aside className="sidebar">
          {panel === 'services' ? (
            <>
          <div className="sidebar-head divided">
            <span>Services</span>
            <Btn icon={<PlusIcon size={14} />} label="New" title="New service (N)" kind="text small" onClick={() => setForm({ editing: null })} />
          </div>
          {groups.map(([group, list]) => (
            <div
              key={group}
              className={`group ${dragGroup === group ? 'dragging' : ''} ${
                groupDropAt?.group === group && dragGroup !== group ? (groupDropAt.after ? 'drop-after' : 'drop-before') : ''
              }`}
              onDragOver={(e) => {
                if (dragGroup === null) return // a service is being dragged: rows handle it
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
                  onClick={() => toggleGroup(group)}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', 'group:' + group)
                    setDragGroup(group)
                  }}
                  onDragEnd={endDrag}
                >
                  <span className={`group-chevron ${collapsed.has(group) ? '' : 'open'}`}>
                    <ChevronIcon size={13} />
                  </span>
                  <span className="group-name">{group}</span>
                  {collapsed.has(group) && (
                    <span className="group-count">
                      {list.some((s) => ACTIVE.has(s.status)) && <span className="dot dot-running" />}
                      {list.filter((s) => s.status === 'running').length}/{list.length}
                      {list.some((s) => s.status === 'crashed') && <span className="group-crashed">!</span>}
                    </span>
                  )}
                  <span className="row-actions">
                    <Btn icon={<PlusIcon size={14} />} title={`New service in ${group}`} onClick={() => setForm({ editing: null, group })} />
                    <Btn icon={<PlayIcon size={14} />} title={`Start ${group}`} onClick={() => run(group, 'start')} kind="green" />
                    <Btn icon={<StopIcon size={14} />} title={`Stop ${group}`} onClick={() => run(group, 'stop')} kind="red" />
                  </span>
                </div>
              )}
              {!(group && collapsed.has(group)) && list.map((s) => {
                const active = ACTIVE.has(s.status)
                return (
                  <div
                    key={s.name}
                    className={`row ${s.name === selected ? 'selected' : ''} ${group ? 'indent' : ''} ${drag?.name === s.name ? 'dragging' : ''} ${
                      dropAt?.name === s.name && drag?.name !== s.name ? (dropAt.after ? 'drop-after' : 'drop-before') : ''
                    }`}
                    onClick={() => setSelected(s.name)}
                    onDoubleClick={() => run(s.name, active ? 'restart' : 'start')}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', s.name)
                      setDrag({ name: s.name, group })
                    }}
                    onDragOver={(e) => {
                      if (!drag || drag.group !== group) return // only within the same group
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      const r = e.currentTarget.getBoundingClientRect()
                      const after = e.clientY > r.top + r.height / 2
                      if (dropAt?.name !== s.name || dropAt.after !== after) setDropAt({ name: s.name, after })
                    }}
                    onDrop={(e) => {
                      if (!drag) return // a group is being dragged: let the group handle it
                      e.preventDefault()
                      e.stopPropagation()
                      if (dropAt) moveService(drag.name, dropAt.name, dropAt.after)
                      endDrag()
                    }}
                    onDragEnd={endDrag}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setSelected(s.name)
                      setMenu({ x: e.clientX, y: e.clientY, service: s.name })
                    }}
                    title={s.description || s.command}
                  >
                    <Dot status={s.status} />
                    <span className="name">{s.name}</span>
                    {unread[s.name] && <span className={`unread unread-${unread[s.name]}`} />}
                    <span className="meta">
                      {s.status === 'running'
                        ? uptime(s.startedAt)
                        : s.status === 'starting' || s.status === 'building'
                          ? `${s.status} ${s.startedAt ? uptime(s.startedAt) : '…'}`
                          : s.status === 'stopped'
                            ? ''
                            : statusLabel(s)}
                    </span>
                    <span className="row-actions">
                      {active ? (
                        <Btn icon={<StopIcon size={14} />} title="Stop" onClick={() => run(s.name, 'stop')} kind="red" />
                      ) : (
                        <Btn icon={<PlayIcon size={14} />} title="Start" onClick={() => run(s.name, 'start')} kind="green" />
                      )}
                      <Btn icon={<RestartIcon size={14} />} title="Restart" onClick={() => run(s.name, 'restart')} />
                      <Btn icon={<EditIcon size={14} />} title="Edit (e)" onClick={() => setForm({ editing: s.name })} />
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
          {state && services.length === 0 && (
            <div className="empty">
              No services yet.
              <Btn icon={<PlusIcon size={14} />} label="Add your first service" title="New service" kind="text" onClick={() => setForm({ editing: null })} />
            </div>
          )}
          <div className="hints">
            <div className="hints-title">Shortcuts</div>
            {(
              [
                [['↑', '↓'], 'Select service'],
                [['S'], 'Start / stop'],
                [['R'], 'Restart'],
                [['C'], 'Clear log'],
                [['/'], 'Filter log'],
                [['N'], 'New service'],
                [['E'], 'Edit service'],
                [['Esc'], 'Clear filter'],
              ] as [string[], string][]
            ).map(([keys, label]) => (
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
            </>
          ) : panel === 'settings' ? (
            <>
              <div className="sidebar-head divided">
                <span>Settings</span>
              </div>
              <div className="settings">
                <section>
                  <h4>Theme</h4>
                  <div className="theme-cards">
                    {(
                      [
                        ['grid', 'The Grid', 'Cyan light lines on black, neon.'],
                        ['basic', 'Basic', 'Calm neutral greys, no glow.'],
                      ] as [Theme, string, string][]
                    ).map(([id, label, help]) => (
                      <button key={id} className={`theme-card ${theme === id ? 'on' : ''}`} onClick={() => setTheme(id)}>
                        <span className={`swatch swatch-${id}`}>
                          <i />
                          <i />
                          <i />
                        </span>
                        <strong>{label}</strong>
                        <small>{help}</small>
                      </button>
                    ))}
                  </div>
                </section>
                <section>
                  <h4>Effects</h4>
                  <div
                    className={`setting-row ${theme !== 'grid' ? 'disabled' : ''}`}
                    role="switch"
                    aria-checked={neon}
                    onClick={() => theme === 'grid' && setNeon((v) => !v)}
                  >
                    <span className="setting-text">
                      <span>Neon line around the window</span>
                      <small>{theme === 'grid' ? 'A light cycle running along the edges.' : 'Only in The Grid theme.'}</small>
                    </span>
                    <span className={`switch ${neon && theme === 'grid' ? 'on' : ''}`} />
                  </div>
                </section>
                <div className="settings-foot">Saved in this browser.</div>
              </div>
            </>
          ) : (
            <>
              <div className="sidebar-head divided">
                <span>Runtimes</span>
                <Btn icon={<PlusIcon size={14} />} label="New" title="New runtime (java / node / script)" kind="text small" onClick={() => setRtForm({ editing: null })} />
              </div>
              {state?.runtimes.map((r) => {
                const users = services.filter((s) => s.runtimes?.includes(r.name)).map((s) => s.name)
                return (
                  <div
                    key={r.name}
                    className="rt-item"
                    onClick={() => setRtForm({ editing: r.name })}
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
                <div className="empty">
                  No runtimes yet.
                  <Btn icon={<PlusIcon size={14} />} label="Add a runtime" title="New runtime" kind="text" onClick={() => setRtForm({ editing: null })} />
                </div>
              )}
            </>
          )}
        </aside>
        <section className="detail">
          {current ? (
            <div className="toolbar">
              <Dot status={current.status} />
              <span className="title">{current.name}</span>
              <span className={`badge badge-${current.status}`}>{statusLabel(current)}</span>
              {current.pid ? <span className="muted">pid {current.pid}</span> : null}
              {current.startedAt ? (
                <span className="muted">
                  {current.status === 'starting' ? 'starting for' : current.status === 'building' ? 'building for' : 'up'} {uptime(current.startedAt)}
                </span>
              ) : null}
              {current.restarts > 0 && <span className="muted">restarts {current.restarts}</span>}
              {current.url && (
                <a className="link" href={current.url} target="_blank" rel="noreferrer">
                  {current.url} <ExternalIcon size={13} />
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
              <Btn icon={<EditIcon />} label="Edit" title="Edit service (e)" kind="text" onClick={() => setForm({ editing: current.name })} />
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
            <div className="toolbar muted">No service selected</div>
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
          <LogView service={selected} store={store} filter={filter} theme={theme} />
        </section>
      </div>
      {form && state && (
        <ServiceForm
          state={state}
          editing={form.editing}
          initialGroup={form.group}
          initialCwd={form.cwd}
          onClose={() => setForm(null)}
          onDone={(name, then) => {
            setForm(null)
            if (name) {
              setSelected(name)
              if (then) run(name, then)
            } else {
              setSelected(null)
            }
          }}
        />
      )}
      {menu && state && (() => {
        const s = state.services.find((x) => x.name === menu.service)
        if (!s) return null
        const active = ACTIVE.has(s.status)
        const dependents = state.services.filter((x) => x.dependsOn?.includes(s.name)).map((x) => x.name)
        const items: MenuEntry[] = [
          active
            ? { label: 'Stop (derezz)', icon: <StopIcon size={14} />, hint: 'S', kind: 'red', onSelect: () => run(s.name, 'stop') }
            : { label: 'Start', icon: <PlayIcon size={14} />, hint: 'S', kind: 'green', onSelect: () => run(s.name, 'start') },
          ...(!active && BUILDS.has(s.type)
            ? [{ label: 'Run without build', icon: <PlayIcon size={14} />, onSelect: () => run(s.name, 'start-nobuild') }]
            : []),
          { label: 'Restart', icon: <RestartIcon size={14} />, hint: 'R', onSelect: () => run(s.name, 'restart') },
          { label: 'Clear log', icon: <ClearIcon size={14} />, hint: 'C', onSelect: () => run(s.name, 'clear') },
          ...(s.url ? [{ label: 'Open URL', icon: <ExternalIcon size={14} />, onSelect: () => window.open(s.url, '_blank', 'noreferrer') }] : []),
          'sep',
          { label: 'Edit…', icon: <EditIcon size={14} />, hint: 'E', onSelect: () => setForm({ editing: s.name }) },
          {
            label: dependents.length ? `Delete (needed by ${dependents.join(', ')})` : 'Delete',
            icon: <TrashIcon size={14} />,
            kind: 'danger',
            disabled: dependents.length > 0,
            confirm: active ? 'Stop & delete? Click again' : 'Click again to delete',
            onSelect: () =>
              deleteService(s.name).then(
                () => setSelected((cur) => (cur === s.name ? null : cur)),
                (e) => setError(`delete ${s.name}: ${e.message}`),
              ),
          },
        ]
        return <ContextMenu x={menu.x} y={menu.y} title={s.name} items={items} onClose={closeMenu} />
      })()}
      {rtForm && state && <RuntimeForm state={state} editing={rtForm.editing} onClose={() => setRtForm(null)} onDone={() => setRtForm(null)} />}
    </div>
  )
}
