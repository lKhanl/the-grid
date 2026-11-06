import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Entry, LogStore } from './api'
import { sysColor, termTheme, type Theme } from './theme'

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g

function format(e: Entry, theme: Theme): string {
  if (e.s === 'sys') {
    const time = new Date(e.t).toLocaleTimeString()
    return `\x1b[38;5;${sysColor[theme]}m▸ ${time}  ${e.line}\x1b[0m`
  }
  return e.line
}

// Lower-cased, ANSI-free text per entry, so typing in the filter box does not redo it for every line.
const plain = new WeakMap<Entry, string>()

function matcher(filter: string): (e: Entry) => boolean {
  const f = filter.trim().toLowerCase()
  if (!f) return () => true
  return (e) => {
    let t = plain.get(e)
    if (t === undefined) plain.set(e, (t = e.line.replace(ANSI, '').toLowerCase()))
    return t.includes(f)
  }
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return v
}

/** One service's terminal. Kept alive (hidden) so switching back costs nothing. */
interface Pane {
  el: HTMLDivElement
  term: Terminal
  fit: FitAddon
  filter: string
  theme: Theme
  match: (e: Entry) => boolean
  dirty: boolean // needs a full rewrite before it is shown again
  pending: string[] // live lines waiting for the next frame
}

function rewrite(p: Pane, service: string, store: LogStore, filter: string, theme: Theme) {
  p.pending = []
  p.filter = filter
  p.theme = theme
  p.match = matcher(filter)
  p.dirty = false
  p.term.reset()
  const lines = store.get(service).filter(p.match).map((e) => format(e, theme))
  if (lines.length) p.term.write(lines.join('\n') + '\n')
}

function createPane(host: HTMLDivElement, theme: Theme, scrollback: number): Pane {
  const el = document.createElement('div')
  el.className = 'log-pane'
  host.appendChild(el)
  const term = new Terminal({
    disableStdin: true,
    convertEol: true,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'none',
    scrollback,
    fontFamily: 'JetBrains Mono, Cascadia Mono, Consolas, Menlo, monospace',
    fontSize: 15,
    lineHeight: 1.2,
    theme: termTheme[theme],
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el)
  return { el, term, fit, filter: '', theme, match: () => true, dirty: true, pending: [] }
}

function safeFit(p: Pane) {
  try {
    p.fit.fit()
  } catch {
    /* hidden */
  }
}

interface Props {
  service: string | null
  store: LogStore
  filter: string
  theme: Theme
  /** Log lines kept per service (the terminals' scrollback matches it). */
  maxLines: number
  /** Names of all services; terminals of removed ones are disposed. */
  known: string[]
}

/** Read-only terminals, one per service you have looked at; only the selected one is visible. */
export function LogView({ service, store, filter: rawFilter, theme, maxLines, known }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const panes = useRef(new Map<string, Pane>())
  const shown = useRef<string | null>(null)
  const filter = useDebounced(rawFilter, 180)

  // Live lines are written once per frame instead of once per line.
  const flushTimer = useRef(false)
  const schedule = useRef(() => {})
  schedule.current = () => {
    if (flushTimer.current) return
    flushTimer.current = true
    const run = () => {
      if (!flushTimer.current) return
      flushTimer.current = false
      panes.current.forEach((p) => {
        if (!p.pending.length) return
        const lines = p.pending
        p.pending = []
        p.term.write(lines.join('\n') + '\n')
      })
    }
    requestAnimationFrame(run)
    window.setTimeout(run, 250) // rAF does not fire in a background tab
  }

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const p = shown.current ? panes.current.get(shown.current) : undefined
      if (p) safeFit(p)
    })
    ro.observe(host.current!)
    const off = store.subscribe((svc, entries, reset) => {
      const p = panes.current.get(svc)
      if (!p) return // created (and filled from the store) when first shown
      if (reset) {
        p.dirty = true
        if (svc === shown.current) rewrite(p, svc, store, p.filter, p.theme)
        return
      }
      if (p.dirty) return // the rewrite will include these
      for (const e of entries) if (p.match(e)) p.pending.push(format(e, p.theme))
      if (p.pending.length) schedule.current()
    })
    const all = panes.current
    return () => {
      off()
      ro.disconnect()
      all.forEach((p) => p.term.dispose())
      all.clear()
    }
  }, [store])

  useEffect(() => {
    panes.current.forEach((p, name) => {
      if (!known.includes(name)) {
        p.term.dispose()
        p.el.remove()
        panes.current.delete(name)
        if (shown.current === name) shown.current = null
      }
    })
  }, [known])

  useEffect(() => {
    panes.current.forEach((p) => {
      p.term.options.theme = termTheme[theme]
      if (p.term.options.scrollback !== maxLines) {
        p.term.options.scrollback = maxLines
        p.dirty = true // rewritten from the (re-sized) store the next time it is shown
      }
      if (p.filter !== filter || p.theme !== theme) p.dirty = true
    })
    const prev = shown.current ? panes.current.get(shown.current) : undefined
    if (prev && shown.current !== service) prev.el.style.display = 'none'
    shown.current = service
    if (!service) return
    let p = panes.current.get(service)
    if (!p) {
      p = createPane(host.current!, theme, maxLines)
      panes.current.set(service, p)
    }
    p.el.style.display = ''
    safeFit(p)
    if (p.dirty) rewrite(p, service, store, filter, theme)
  }, [service, store, filter, theme, maxLines])

  return <div className="log-host" ref={host} />
}
