import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { act, reload, reorderServices, LogStore, type Action, type Info, type RunnerEvent, type State } from './api'
import { LogView } from './LogView'
import { ChevronDownIcon, FolderIcon, GridIcon, PlayIcon, ReloadIcon, StopIcon } from './icons'
import { recordStats } from './stats'
import { ServiceForm } from './ServiceForm'
import { RuntimeForm } from './RuntimeForm'
import { Workspaces } from './Workspaces'
import { NeonBorder } from './NeonBorder'
import { applyTheme, loadTheme, type Theme } from './theme'
import { ChangesList, DiffPane, useGit } from './Changes'
import { DbForm, DbSidebar, DbWorkbench, useDatabase } from './Database'
import type { DbKind } from './dbApi'
import { loadPrefs, TermPanel } from './Terminals'
import { ActivityBar, type Panel } from './ActivityBar'
import { RuntimesList } from './RuntimesList'
import { ServiceHeader } from './ServiceHeader'
import { ServiceList } from './ServiceList'
import { ServiceMenu } from './ServiceMenu'
import { SettingsPanel } from './SettingsPanel'
import { ACTIVE, Btn, TypeIcon, useTick } from './ui'
import { useTerminals } from './useTerminals'

const SIDE_MIN = 220
const SIDE_DEFAULT = 330

export default function App() {
  const store = useMemo(() => new LogStore(), [])
  const [state, setState] = useState<State | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const logLines = state?.logLines ?? 1000
  store.setMax(logLines) // cheap no-op unless the setting changed
  const nameKey = state?.services.map((s) => s.name).join('\n') ?? ''
  const serviceNames = useMemo(() => (nameKey ? nameKey.split('\n') : []), [nameKey])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unread, setUnread] = useState<Record<string, 'out' | 'err'>>({})
  const [form, setForm] = useState<{ editing: string | null; group?: string; cwd?: string } | null>(null)
  const [wsOpen, setWsOpen] = useState(false)
  const noWorkspace = !!state && state.configPath === ''
  const [rtForm, setRtForm] = useState<{ editing: string | null } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; service: string } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
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
  // Off by default when the system asks for less motion (VDIs often turn animations off), but an explicit choice wins.
  const reducedMotion = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, [])
  const [neon, setNeon] = useState(() => {
    const v = localStorage.getItem('grid.neon')
    return v === 'on' || (v !== 'off' && !reducedMotion)
  })
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [panel, setPanel] = useState<Panel>(() => {
    const p = localStorage.getItem('grid.panel')
    return p === 'runtimes' || p === 'settings' || p === 'changes' || p === 'database' || p === 'services' ? (p as Panel) : 'services'
  })
  const [sideW, setSideW] = useState(() => {
    const n = Number(localStorage.getItem('grid.sideW'))
    return n >= SIDE_MIN && n <= 900 ? n : SIDE_DEFAULT
  })
  const [sideDrag, setSideDrag] = useState(false)
  const dragSide = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    setSideDrag(true)
    const left = (el.previousElementSibling as HTMLElement).getBoundingClientRect().left
    let w = sideW
    const move = (ev: PointerEvent) => {
      w = Math.round(Math.max(SIDE_MIN, Math.min(window.innerWidth * 0.6, ev.clientX - left)))
      setSideW(w)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setSideDrag(false)
      localStorage.setItem('grid.sideW', String(w))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  const git = useGit(panel === 'changes')
  // The Database panel exists only in builds with -tags db.
  const hasDb = state?.features?.includes('db') ?? false
  // the database drivers compiled in (db:oracle, db:postgres)
  const dbKinds = useMemo(() => (state?.features ?? []).filter((f) => f.startsWith('db:')).map((f) => f.slice(3) as DbKind), [state?.features])
  const dbs = useDatabase(panel === 'database' && hasDb)
  useEffect(() => {
    if (state && !hasDb && panel === 'database') setPanel('services')
  }, [state, hasDb, panel])
  useEffect(() => localStorage.setItem('grid.panel', panel ?? 'off'), [panel])
  const filterRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const selectedCwd = state?.services.find((s) => s.name === selected)?.cwd ?? ''
  const term = useTerminals(selectedCwd, setError)
  const { onServerList, setTermOpen } = term

  useEffect(() => localStorage.setItem('grid.neon', neon ? 'on' : 'off'), [neon])
  useEffect(() => applyTheme(theme), [theme])

  // Deep links: #new, #new=group, #edit=service, #select=service, #runtime=new, #runtime=name
  useEffect(() => {
    const open = () => {
      const h = decodeURIComponent(location.hash.slice(1))
      if (h === 'new' || h.startsWith('new=')) setForm({ editing: null, group: h.slice(4) || undefined })
      else if (h.startsWith('new-dir=')) setForm({ editing: null, cwd: h.slice(8) })
      else if (h.startsWith('edit=')) setForm({ editing: h.slice(5) })
      else if (h === 'runtimes' || h === 'services' || h === 'settings' || h === 'database') setPanel(h as Panel)
      else if (h === 'terminal') setTermOpen(true)
      else if (h === 'theme=basic' || h === 'theme=grid') setTheme(h.slice(6) as Theme)
      else if (h.startsWith('select=')) setSelected(h.slice(7))
      else if (h.startsWith('runtime=')) setRtForm({ editing: h.slice(8) === 'new' ? null : h.slice(8) })
      if (h) history.replaceState(null, '', location.pathname)
    }
    open()
    window.addEventListener('hashchange', open)
    return () => window.removeEventListener('hashchange', open)
  }, [setTermOpen])

  // One SSE stream carries status changes and log lines for every service.
  useEffect(() => {
    const es = new EventSource('/api/events')
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (msg) => {
      const ev: RunnerEvent = JSON.parse(msg.data)
      if (ev.type === 'snapshot' && ev.state) {
        const st = ev.state
        st.services.forEach(recordStats)
        setState(st)
        setSelected((cur) => (cur && st.services.some((s) => s.name === cur) ? cur : (st.services[0]?.name ?? null)))
        // The first snapshot of a connection carries the log history; later
        // ones (after a config change) don't, and the buffers stay as they are.
        // (set, not merge: after a server restart line numbers start again)
        if (ev.logs) for (const s of st.services) store.set(s.name, ev.logs[s.name] ?? [])
        if (ev.terms) onServerList(ev.terms, true)
      } else if (ev.type === 'terms') {
        onServerList(ev.terms ?? [], false)
      } else if (ev.type === 'service' && ev.info) {
        const info = ev.info
        recordStats(info)
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
  }, [store, onServerList])

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

  const current = services.find((s) => s.name === selected) ?? null

  // Keyboard: ↑/↓ select, s start/stop, r restart, c clear, / filter, Esc clears filter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (form || rtForm || menu) return // the forms and the menu handle their own keys
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable) // the SQL editor
      if (e.key === 'Escape' && e.target instanceof HTMLInputElement) {
        setFilter('')
        ;(e.target as HTMLInputElement).blur()
        return
      }
      if (e.key === 'Escape') {
        setSelected(null)
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
          {state?.version && (
            <span className="version" title={`The Grid ${state.version}`}>
              v{state.version.split('+')[0]}
            </span>
          )}
          {state && (
            <button className={`workspace ${wsOpen ? 'on' : ''}`} title={`${state.configPath}\nSwitch workspace`} onClick={() => setWsOpen(true)}>
              <FolderIcon size={15} />
              <span className="workspace-name">{state.configPath === '' ? 'Open workspace' : state.name || 'workspace'}</span>
              <ChevronDownIcon size={14} />
            </button>
          )}
        </div>
        <div className="summary">
          {runningCount}/{services.length} on the grid
        </div>
        <div className="spacer" />
        {!connected && <div className="offline">disconnected, retrying…</div>}
        {panel === 'services' && (
          <>
            <Btn icon={<PlayIcon />} label="Start all" title="Start all" kind="text green" onClick={() => run('all', 'start')} />
            <Btn icon={<StopIcon />} label="Stop all" title="End of line: stop every program" kind="text red" disabled={runningCount === 0} onClick={() => run('all', 'stop')} />
            <Btn
              icon={<ReloadIcon />}
              label="Reload config"
              title={`Re-read ${state?.configPath ?? 'grid.yaml'}`}
              kind="text"
              onClick={() => reload().catch((e) => setError(`reload: ${e.message}`))}
            />
          </>
        )}
      </header>
      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <div className="main">
        <ActivityBar
          panel={panel}
          setPanel={setPanel}
          runningCount={runningCount}
          gitTotal={git.total}
          hasDb={hasDb}
          dbInTx={dbs.conns.some((c) => c.inTx)}
          runtimesBroken={!!state?.runtimes.some((r) => r.error)}
          termOpen={term.termOpen}
          liveTerms={term.terms.filter((t) => !t.exited).length}
          onToggleTerm={term.toggle}
        />
        <aside className="sidebar" style={{ width: sideW, display: panel ? 'flex' : 'none' }}>
          {panel === 'services' ? (
            <ServiceList
              state={state}
              groups={groups}
              collapsed={collapsed}
              toggleGroup={toggleGroup}
              selected={selected}
              setSelected={setSelected}
              unread={unread}
              run={run}
              onNew={(group) => setForm({ editing: null, group })}
              onEdit={(name) => setForm({ editing: name })}
              onMenu={(x, y, service) => setMenu({ x, y, service })}
              onReorder={saveOrder}
            />
          ) : panel === 'database' ? (
            <DbSidebar dbs={dbs} />
          ) : panel === 'changes' ? (
            <ChangesList git={git} typeIcon={(t) => <TypeIcon type={t} size={15} />} />
          ) : panel === 'settings' ? (
            <SettingsPanel
              state={state}
              setState={setState}
              setError={setError}
              theme={theme}
              setTheme={setTheme}
              neon={neon}
              setNeon={setNeon}
              reducedMotion={reducedMotion}
            />
          ) : (
            <RuntimesList state={state} onOpen={(editing) => setRtForm({ editing })} />
          )}
        </aside>
        <div
          className={`side-resizer ${sideDrag ? 'dragging' : ''}`}
          onPointerDown={dragSide}
          onDoubleClick={() => {
            setSideW(SIDE_DEFAULT)
            localStorage.removeItem('grid.sideW')
          }}
          title="Drag to resize, double-click to reset"
        />
        <section className={`detail ${term.termOpen ? 'term-open' : ''}`}>
          {panel === 'changes' && !(term.termOpen && term.termMax) && <DiffPane git={git} />}
          {panel === 'database' && !(term.termOpen && term.termMax) && <DbWorkbench dbs={dbs} />}
          <div
            className="detail-pane"
            style={{ display: (term.termOpen && term.termMax) || panel === 'changes' || panel === 'database' || panel === 'runtimes' ? 'none' : 'flex' }}
          >
            <ServiceHeader
              current={current}
              state={state}
              run={run}
              onEdit={(name) => setForm({ editing: name })}
              filter={filter}
              setFilter={setFilter}
              filterRef={filterRef}
            />
            <LogView service={selected} store={store} filter={filter} theme={theme} maxLines={logLines} known={serviceNames} />
          </div>
          {(term.termOpen || term.terms.length > 0) && (
            <TermPanel
              open={term.termOpen}
              state={state}
              defaultCwd={selectedCwd}
              terms={term.terms}
              selected={term.selectedTerm}
              theme={theme}
              maximized={term.termMax}
              onMaximize={term.setTermMax}
              onSelect={term.setSelectedTerm}
              onKill={term.killTerm}
              onNew={(p) => term.newTerm(p)}
              onHide={() => setTermOpen(false)}
            />
          )}
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
      {menu && state && (
        <ServiceMenu
          state={state}
          service={menu.service}
          x={menu.x}
          y={menu.y}
          run={run}
          onEdit={(name) => setForm({ editing: name })}
          onTerminal={(service) => term.newTerm({ ...loadPrefs(), service })}
          onDeleted={(name) => setSelected((cur) => (cur === name ? null : cur))}
          setError={setError}
          onClose={closeMenu}
        />
      )}
      {(wsOpen || noWorkspace) && state && (
        <Workspaces
          current={state.configPath}
          required={noWorkspace}
          onClose={() => setWsOpen(false)}
          onSwitched={(st) => {
            for (const s of st.services) store.set(s.name, [])
            setState(st)
            setSelected(st.services[0]?.name ?? null)
          }}
        />
      )}
      {dbs.form && <DbForm editing={dbs.form.editing} kinds={dbKinds} group={dbs.form.group} onClose={dbs.closeForm} onSaved={dbs.saved} />}
      {rtForm && state && <RuntimeForm state={state} editing={rtForm.editing} onClose={() => setRtForm(null)} onDone={() => setRtForm(null)} />}
    </div>
  )
}
