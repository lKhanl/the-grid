import { type ReactNode, useEffect, useState } from 'react'
import type { Info } from './api'
import { CodeIcon, JarIcon, NodeIcon, ScriptIcon, SpringIcon } from './icons'

// Small pieces shared by the Services screens.

/** Statuses in which a service has (or is getting) a process. */
export const ACTIVE = new Set(['starting', 'building', 'running', 'stopping'])
/** Types with a build step (they offer "Run without build"). */
export const BUILDS = new Set(['spring-boot', 'node'])

export function formatBytes(n: number) {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`
  if (n >= 1 << 20) return `${Math.round(n / (1 << 20))} MB`
  return `${Math.round(n / 1024)} KB`
}

export function uptime(ms?: number) {
  if (!ms) return ''
  let s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`
}

export function statusLabel(i: Info) {
  if ((i.status === 'crashed' || i.status === 'exited') && i.exitCode !== undefined) return `${i.status} (${i.exitCode})`
  return i.status
}

/** Re-renders the caller every ms (for uptimes). */
export function useTick(ms: number) {
  const [, set] = useState(0)
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), ms)
    return () => clearInterval(id)
  }, [ms])
}

const TYPE_ICONS = { 'spring-boot': SpringIcon, node: NodeIcon, script: ScriptIcon, jar: JarIcon, custom: CodeIcon } as const

/** Icon of a service type (fallback: custom). */
export function TypeIcon({ type, size = 16 }: { type: string; size?: number }) {
  const I = TYPE_ICONS[type as keyof typeof TYPE_ICONS] ?? CodeIcon
  return <I size={size} />
}

/** Service type icon, colored by status. */
export function StatusIcon({ status, type, size = 16 }: { status: Info['status']; type: Info['type']; size?: number }) {
  const I = TYPE_ICONS[type] ?? CodeIcon
  return (
    <span className={`status-icon st-${status}`} title={`${type} · ${status}`}>
      <I size={size} />
    </span>
  )
}

export function Btn(props: { icon: ReactNode; label?: string; title: string; onClick: () => void; disabled?: boolean; kind?: string }) {
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
