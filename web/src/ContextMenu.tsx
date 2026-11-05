import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  icon?: ReactNode
  hint?: string
  kind?: 'danger' | 'green' | 'red'
  disabled?: boolean
  /** ask for a second click before running onSelect */
  confirm?: string
  onSelect: () => void
}

export type MenuEntry = MenuItem | 'sep'

interface Props {
  x: number
  y: number
  title?: string
  items: MenuEntry[]
  onClose: () => void
}

export function ContextMenu({ x, y, title, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [armed, setArmed] = useState<string | null>(null)

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    })
  }, [x, y])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div ref={ref} className="ctx-menu" style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {title && <div className="ctx-title">{title}</div>}
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={it.label}
            role="menuitem"
            className={`ctx-item ${it.kind ?? ''} ${armed === it.label ? 'armed' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              if (it.confirm && armed !== it.label) return setArmed(it.label)
              onClose()
              it.onSelect()
            }}
          >
            <span className="ctx-icon">{it.icon}</span>
            <span className="ctx-label">{armed === it.label ? it.confirm : it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  )
}
