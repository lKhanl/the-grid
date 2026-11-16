import { type CSSProperties, type RefObject, useCallback, useEffect, useState } from 'react'

// Text size of a read-only code view (Files, Changes): buttons, Ctrl/Cmd + wheel (a trackpad pinch too) and Ctrl/Cmd + / - / 0.
// The size is one setting for both views, kept in localStorage; only one of them is on screen at a time.
const KEY = 'grid.zoom'
const MIN = 60, MAX = 250, STEP = 10

export function useZoom(target: RefObject<HTMLElement | null>) {
  const [zoom, setZoomState] = useState(() => {
    const n = Number(localStorage.getItem(KEY) ?? localStorage.getItem('grid.files.zoom'))
    return n >= MIN && n <= MAX ? n : 100
  })
  const setZoom = useCallback((f: (z: number) => number) => {
    setZoomState((z) => {
      const n = Math.min(MAX, Math.max(MIN, f(z)))
      localStorage.setItem(KEY, String(n))
      return n
    })
  }, [])
  useEffect(() => {
    const el = target.current
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      setZoom((z) => z + (e.deltaY < 0 ? STEP : -STEP))
    }
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key === '+' || e.key === '=') setZoom((z) => z + STEP)
      else if (e.key === '-' || e.key === '_') setZoom((z) => z - STEP)
      else if (e.key === '0') setZoom(() => 100)
      else return
      e.preventDefault() // not the browser's page zoom
    }
    el?.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('keydown', key)
    return () => {
      el?.removeEventListener('wheel', wheel)
      window.removeEventListener('keydown', key)
    }
  }, [target, setZoom])
  return {
    style: { '--fz': zoom / 100 } as CSSProperties, // put on the scrolling body: the CSS scales fonts and gutters from it
    controls: (
      <div className="seg zoom" role="group" aria-label="Text size">
        <button title="Smaller text (Ctrl/Cmd −)" onClick={() => setZoom((z) => z - STEP)} disabled={zoom <= MIN}>−</button>
        <button title="Reset to 100% (Ctrl/Cmd 0)" onClick={() => setZoom(() => 100)}>{zoom}%</button>
        <button title="Larger text (Ctrl/Cmd +)" onClick={() => setZoom((z) => z + STEP)} disabled={zoom >= MAX}>+</button>
      </div>
    ),
  }
}
