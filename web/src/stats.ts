// CPU / memory history of each service, kept in the browser (the server only sends the latest
// sample, every 2 s). Enough for a sparkline and a "growing" hint; lost on reload, which is fine.
import type { Info } from './api'

export interface Sample {
  t: number
  cpu?: number
  mem?: number
}

const WINDOW_MS = 2 * 60 * 1000 // what the sparklines show
const MIN_GAP_MS = 1500 // service events also come for other reasons: one sample per stats tick

const history = new Map<string, { pid?: number; samples: Sample[] }>()

/** Called for every service update; keeps a sample when it carries new numbers. */
export function recordStats(s: Info) {
  if (s.cpu === undefined && !s.mem) {
    history.delete(s.name) // stopped: the next run starts a new history
    return
  }
  let h = history.get(s.name)
  if (!h || h.pid !== s.pid) {
    h = { pid: s.pid, samples: [] }
    history.set(s.name, h)
  }
  const now = Date.now()
  const last = h.samples[h.samples.length - 1]
  if (last && now - last.t < MIN_GAP_MS) return
  h.samples.push({ t: now, cpu: s.cpu, mem: s.mem })
  while (h.samples.length && now - h.samples[0].t > WINDOW_MS) h.samples.shift()
}

export function statsOf(name: string): Sample[] {
  return history.get(name)?.samples ?? []
}

/** CPU is per core, so a busy multi-threaded service goes past 100%. */
export function cpuLevel(cpu: number): '' | 'warn' | 'hot' {
  return cpu >= 150 ? 'hot' : cpu >= 80 ? 'warn' : ''
}

/** Memory has no natural limit; only flag a steady climb over at least a minute (a leak, maybe). */
export function memGrowing(samples: Sample[]): boolean {
  const mem = samples.map((s) => s.mem).filter((m): m is number => !!m)
  if (mem.length < 30) return false
  const third = Math.floor(mem.length / 3)
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
  const a = avg(mem.slice(0, third))
  const b = avg(mem.slice(third, 2 * third))
  const c = avg(mem.slice(2 * third))
  return a < b && b < c && c > a * 1.25
}
