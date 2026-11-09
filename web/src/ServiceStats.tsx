import type { Info } from './api'
import { cpuLevel, memGrowing, statsOf } from './stats'
import { formatBytes } from './ui'

/** A tiny line of the last two minutes; the y axis starts at 0 so a flat line means "steady". */
function Sparkline({ values, max }: { values: number[]; max?: number }) {
  const w = 48
  const h = 14
  if (values.length < 2) return <svg className="spark" width={w} height={h} aria-hidden="true" />
  const top = Math.max(max ?? 0, ...values) || 1
  const step = w / (values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (v / top) * (h - 2)).toFixed(1)}`).join(' ')
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length

/** CPU and RAM of the selected service: value, two-minute sparkline, colour when high. */
export function ServiceStats({ current }: { current: Info }) {
  if (current.cpu === undefined && !current.mem) return null
  const samples = statsOf(current.name)
  const cpus = samples.map((s) => s.cpu).filter((c): c is number => c !== undefined)
  const mems = samples.map((s) => s.mem).filter((m): m is number => !!m)
  const growing = memGrowing(samples)
  return (
    <span className="stats">
      {current.cpu !== undefined && (
        <span
          className={`metric ${cpuLevel(current.cpu)}`}
          title={`CPU of the process tree (one core = 100%)${cpus.length ? `\nlast 2 min: max ${Math.round(Math.max(...cpus))}% · avg ${Math.round(avg(cpus))}%` : ''}`}
        >
          <span className="metric-label">CPU</span>
          <span className="metric-value">{Math.round(current.cpu)}%</span>
          <Sparkline values={cpus} max={100} />
        </span>
      )}
      {!!current.mem && (
        <span
          className={`metric ${growing ? 'warn' : ''}`}
          title={`Memory (resident) of the process tree${mems.length ? `\nlast 2 min: max ${formatBytes(Math.max(...mems))} · avg ${formatBytes(avg(mems))}` : ''}${growing ? '\nSteadily growing for over a minute' : ''}`}
        >
          <span className="metric-label">RAM</span>
          <span className="metric-value">{formatBytes(current.mem)}</span>
          <Sparkline values={mems} />
        </span>
      )}
    </span>
  )
}

/** Short form for the service list: "12% · 412M". */
export function shortStats(s: Info): string {
  const parts: string[] = []
  if (s.cpu !== undefined) parts.push(`${Math.round(s.cpu)}%`)
  if (s.mem) parts.push(formatBytes(s.mem).replace(/ ([KMG])B$/, '$1'))
  return parts.join(' · ')
}
