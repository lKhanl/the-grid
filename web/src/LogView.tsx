import { useEffect, useRef } from 'react'
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

function matcher(filter: string): (e: Entry) => boolean {
  const f = filter.trim().toLowerCase()
  if (!f) return () => true
  return (e) => e.line.replace(ANSI, '').toLowerCase().includes(f)
}

interface Props {
  service: string | null
  store: LogStore
  filter: string
  theme: Theme
}

/** One read-only terminal; switching services rewrites it from the store. */
export function LogView({ service, store, filter, theme }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)

  useEffect(() => {
    const t = new Terminal({
      disableStdin: true,
      convertEol: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      scrollback: 15000,
      fontFamily: 'JetBrains Mono, Cascadia Mono, Consolas, Menlo, monospace',
      fontSize: 15,
      lineHeight: 1.2,
      theme: termTheme[theme],
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current!)
    f.fit()
    term.current = t
    fit.current = f
    const ro = new ResizeObserver(() => {
      try {
        f.fit()
      } catch {
        /* hidden */
      }
    })
    ro.observe(host.current!)
    return () => {
      ro.disconnect()
      t.dispose()
    }
  }, [])

  useEffect(() => {
    const t = term.current
    if (!t) return
    t.options.theme = termTheme[theme]
    const fmt = (e: Entry) => format(e, theme)
    const match = matcher(filter)
    const rewrite = () => {
      t.reset()
      if (!service) return
      const lines = store.get(service).filter(match).map(fmt)
      if (lines.length) t.write(lines.join('\n') + '\n')
    }
    rewrite()
    return store.subscribe((svc, entries, reset) => {
      if (svc !== service) return
      if (reset) return rewrite()
      const lines = entries.filter(match).map(fmt)
      if (lines.length) t.write(lines.join('\n') + '\n')
    })
  }, [service, store, filter, theme])

  return <div className="log-host" ref={host} />
}

