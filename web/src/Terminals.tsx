import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { listShells, termSocketURL, type ShellInfo, type State, type TermInfo } from './api'
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, PlusIcon, TerminalIcon } from './icons'
import { termTheme, type Theme } from './theme'

const FONT = 'JetBrains Mono, Cascadia Mono, Consolas, Menlo, monospace'
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)

/** The log theme hides the cursor; a shell needs one. */
function shellTheme(theme: Theme) {
  const base = termTheme[theme]
  return { ...base, cursor: theme === 'grid' ? '#5ef2ff' : '#bcbec4', cursorAccent: base.background }
}

export function shellName(path: string) {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.exe$/i, '')
}

/** Titles with a counter when the same one appears more than once ("zsh", "zsh 2"). */
export function termTitles(terms: TermInfo[]): Record<string, string> {
  const seen: Record<string, number> = {}
  const out: Record<string, string> = {}
  for (const t of terms) {
    const n = (seen[t.title] = (seen[t.title] ?? 0) + 1)
    out[t.id] = n > 1 ? `${t.title} ${n}` : t.title
  }
  return out
}

// ---- new-terminal choices, remembered in the browser ----

export interface NewTermPrefs {
  shell: string
  runtimes: string[]
  cwd: string
}

export function loadPrefs(): NewTermPrefs {
  try {
    const p = JSON.parse(localStorage.getItem('grid.term.new') ?? '{}')
    return { shell: p.shell ?? '', runtimes: Array.isArray(p.runtimes) ? p.runtimes : [], cwd: p.cwd ?? '' }
  } catch {
    return { shell: '', runtimes: [], cwd: '' }
  }
}

function savePrefs(p: NewTermPrefs) {
  localStorage.setItem('grid.term.new', JSON.stringify(p))
}

// ---- new-terminal form (dropdown under the panel's chevron) ----

interface FormProps {
  /** open upwards (over the log) when the panel is too low for it */
  up: boolean
  state: State | null
  onOpen: (p: NewTermPrefs) => void
  onCancel: () => void
}

function NewTermForm({ up, state, onOpen, onCancel }: FormProps) {
  const [shells, setShells] = useState<ShellInfo[]>([])
  const [prefs, setPrefs] = useState<NewTermPrefs>(loadPrefs)
  const configDir = state?.configPath.replace(/[\\/][^\\/]*$/, '') ?? ''
  const ref = useRef<HTMLFormElement>(null)

  useEffect(() => {
    listShells().then(setShells, () => setShells([]))
  }, [])
  // click outside / Esc closes
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.('.term-new-toggle')) onCancel()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [onCancel])

  const runtimes = state?.runtimes ?? []
  const toggleRt = (name: string) =>
    setPrefs((p) => ({ ...p, runtimes: p.runtimes.includes(name) ? p.runtimes.filter((n) => n !== name) : [...p.runtimes, name] }))

  return (
    <form
      ref={ref}
      className={`term-new ${up ? 'up' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        const p = { ...prefs, runtimes: prefs.runtimes.filter((n) => runtimes.some((r) => r.name === n)) }
        savePrefs(p)
        onOpen(p)
      }}
    >
      <div className="term-new-title">New terminal</div>
      <label className="field">
        <span>Shell</span>
        <select value={prefs.shell} onChange={(e) => setPrefs({ ...prefs, shell: e.target.value })}>
          <option value="">{shells[0] ? `Default (${shells[0].name})` : 'Default'}</option>
          {shells.map((s) => (
            <option key={s.path} value={s.path}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {runtimes.length > 0 && (
        <div className="field">
          <span>Runtimes on PATH</span>
          <div className="chips">
            {runtimes.map((r) => (
              <button
                key={r.name}
                type="button"
                className={`chip toggle chip-${r.type} ${prefs.runtimes.includes(r.name) ? 'on' : ''} ${r.error ? 'chip-error' : ''}`}
                title={`${r.type}: ${r.home}${r.error ? `\n⚠ ${r.error}` : ''}`}
                onClick={() => toggleRt(r.name)}
              >
                {r.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <label className="field">
        <span>Folder</span>
        <input value={prefs.cwd} placeholder={configDir} onChange={(e) => setPrefs({ ...prefs, cwd: e.target.value })} />
      </label>
      <div className="term-new-actions">
        <button type="button" className="btn text small" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn text small primary">
          <TerminalIcon size={14} />
          <span>Open</span>
        </button>
      </div>
    </form>
  )
}

// ---- bottom panel ----

const MIN_H = 120

function loadHeight() {
  const h = Number(localStorage.getItem('grid.term.height'))
  return h >= MIN_H ? h : 300
}

interface PanelProps {
  /** hidden panels stay mounted so the shells' screens survive */
  open: boolean
  state: State | null
  terms: TermInfo[]
  selected: string | null
  theme: Theme
  maximized: boolean
  onMaximize: (v: boolean) => void
  onSelect: (id: string) => void
  onKill: (id: string) => void
  onNew: (p: NewTermPrefs) => void
  onHide: () => void
}

function statusClass(t: TermInfo) {
  return t.exited ? (t.exitCode ? 'st-crashed' : 'st-exited') : 'st-running'
}

/** VS Code style panel under the log; drag its top edge to resize. Every terminal stays mounted so screens and sockets survive switching. */
export function TermPanel({ open, state, terms, selected, theme, maximized, onMaximize, onSelect, onKill, onNew, onHide }: PanelProps) {
  const titles = useMemo(() => termTitles(terms), [terms])
  const current = terms.find((t) => t.id === selected) ?? null
  const [height, setHeight] = useState(loadHeight)
  const [adding, setAdding] = useState(false)
  const [dragging, setDragging] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const closeForm = useMemo(() => () => setAdding(false), [])

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const parent = panel.current?.parentElement
    if (!parent) return
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    setDragging(true)
    if (maximized) onMaximize(false)
    const bottom = parent.getBoundingClientRect().bottom
    const max = () => parent.getBoundingClientRect().height - 90
    let h = height
    const move = (ev: PointerEvent) => {
      h = Math.round(Math.max(MIN_H, Math.min(max(), bottom - ev.clientY)))
      setHeight(h)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setDragging(false)
      localStorage.setItem('grid.term.height', String(h))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <div
      ref={panel}
      className={`term-panel ${maximized ? 'max' : ''} ${dragging ? 'dragging' : ''}`}
      style={{ ...(maximized ? {} : { height }), ...(open ? {} : { display: 'none' }) }}
    >
      <div
        className="term-resizer"
        onPointerDown={startDrag}
        onDoubleClick={() => onMaximize(!maximized)}
        title="Drag to resize, double-click to maximize"
      />
      <div className="term-head">
        <span className="term-head-label">Terminal</span>
        <div className="term-tabs" role="tablist">
          {terms.map((t) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === selected}
              className={`term-tab ${t.id === selected ? 'on' : ''} ${t.exited ? 'term-exited' : ''}`}
              title={`${t.shell}\n${t.cwd}${t.runtimes?.length ? `\nruntimes: ${t.runtimes.join(', ')}` : ''}${t.service ? `\nenv of ${t.service}` : ''}`}
              onClick={() => onSelect(t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) onKill(t.id) // middle click
              }}
            >
              <span className={`status-icon ${statusClass(t)}`}>
                <TerminalIcon size={13} />
              </span>
              <span className="name">{titles[t.id]}</span>
              <button
                className="tab-close"
                title={t.exited ? 'Remove' : 'Kill terminal'}
                onClick={(e) => {
                  e.stopPropagation()
                  onKill(t.id)
                }}
              >
                <CloseIcon size={11} />
              </button>
            </div>
          ))}
        </div>
        {current && (
          <span className="term-info" title={current.cwd}>
            {current.exited && <span className={`badge ${current.exitCode ? 'badge-crashed' : ''}`}>exited ({current.exitCode ?? '?'})</span>}
            {current.service ? (
              <span className="chip chip-system">env of {current.service}</span>
            ) : (
              current.runtimes?.map((name) => {
                const rt = state?.runtimes.find((r) => r.name === name)
                return (
                  <span key={name} className={`chip chip-${rt?.type ?? 'script'}`}>
                    {name}
                  </span>
                )
              })
            )}
            <span className="muted term-cwd">{current.cwd}</span>
          </span>
        )}
        <div className="term-actions">
          <button className="icon-btn" title="New terminal (Ctrl+Shift+`)" onClick={() => onNew(loadPrefs())}>
            <PlusIcon size={15} />
          </button>
          <button className={`icon-btn term-new-toggle ${adding ? 'on' : ''}`} title="New terminal with shell / runtimes / folder…" onClick={() => setAdding((a) => !a)}>
            <ChevronDownIcon size={15} />
          </button>
          <button className="icon-btn" title={maximized ? 'Restore panel size' : 'Maximize panel'} onClick={() => onMaximize(!maximized)}>
            {maximized ? <ChevronDownIcon size={15} /> : <ChevronUpIcon size={15} />}
          </button>
          <button className="icon-btn" title="Hide panel (Ctrl+`) — terminals keep running" onClick={onHide}>
            <CloseIcon size={14} />
          </button>
        </div>
        {adding && (
          <NewTermForm
            up={!maximized && height < 400}
            state={state}
            onCancel={closeForm}
            onOpen={(p) => {
              setAdding(false)
              onNew(p)
            }}
          />
        )}
      </div>
      <div className="term-stack">
        {terms.map((t) => (
          <TermScreen key={t.id} id={t.id} shown={open && t.id === selected} theme={theme} />
        ))}
        {terms.length === 0 && (
          <div className="term-empty">
            <button className="btn text" onClick={() => onNew(loadPrefs())}>
              <TerminalIcon size={16} />
              <span>Open a terminal</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function TermScreen({ id, shown, theme }: { id: string; shown: boolean; theme: Theme }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)

  useEffect(() => {
    const t = new Terminal({
      cursorBlink: true,
      scrollback: 10000,
      fontFamily: FONT,
      fontSize: 14,
      lineHeight: 1.15,
      macOptionIsMeta: true,
      theme: shellTheme(theme),
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current!)
    term.current = t
    fit.current = f

    const enc = new TextEncoder()
    let ws: WebSocket | null = null
    let disposed = false
    let exited = false
    let retry: number | undefined
    const send = (data: string | Uint8Array<ArrayBuffer>) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data)
    }
    const sendSize = () => send(JSON.stringify({ t: 'r', c: t.cols, r: t.rows }))
    const connect = () => {
      const s = new WebSocket(termSocketURL(id))
      s.binaryType = 'arraybuffer'
      ws = s
      s.onopen = () => {
        t.reset() // the server replays the history first
        sendSize()
      }
      s.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            if (JSON.parse(ev.data).t === 'exit') exited = true
          } catch {
            /* ignore */
          }
          return
        }
        t.write(new Uint8Array(ev.data as ArrayBuffer))
      }
      s.onclose = () => {
        if (ws === s) ws = null
        if (!disposed && !exited) retry = window.setTimeout(connect, 1000)
      }
    }
    connect()

    const subs = [
      t.onData((d) => send(enc.encode(d))),
      t.onBinary((d) => send(Uint8Array.from(d, (c) => c.charCodeAt(0)))),
      t.onResize(sendSize),
    ]
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // Ctrl+` (and Ctrl+Shift+`) belong to the app.
      if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) return false
      if (IS_MAC) return true // Cmd+C / Cmd+V already work
      // Windows/Linux: Ctrl+C copies when text is selected (else it is ^C), Ctrl+V and Ctrl+Shift+V paste.
      const k = e.key.toLowerCase()
      if (e.ctrlKey && k === 'c' && (e.shiftKey || t.hasSelection())) {
        if (t.hasSelection()) {
          navigator.clipboard?.writeText(t.getSelection()).catch(() => {})
          t.clearSelection()
        }
        e.preventDefault()
        return false
      }
      if (e.ctrlKey && k === 'v') return false // let the browser fire its paste event
      return true
    })

    const ro = new ResizeObserver(() => {
      if (!host.current?.offsetParent) return // hidden
      try {
        f.fit()
      } catch {
        /* not laid out yet */
      }
    })
    ro.observe(host.current!)
    return () => {
      disposed = true
      window.clearTimeout(retry)
      ws?.close()
      subs.forEach((s) => s.dispose())
      ro.disconnect()
      t.dispose()
    }
  }, [id])

  useEffect(() => {
    if (term.current) term.current.options.theme = shellTheme(theme)
  }, [theme])

  useEffect(() => {
    if (!shown) return
    const raf = requestAnimationFrame(() => {
      try {
        fit.current?.fit()
      } catch {
        /* ignore */
      }
      term.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [shown])

  return <div className="term-host" ref={host} style={{ display: shown ? 'block' : 'none' }} />
}
