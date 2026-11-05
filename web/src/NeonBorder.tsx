import { useEffect, useRef, useState } from 'react'

// A light-cycle trail running around the window edge. Drawn with plain SVG
// strokes (no CSS filters), so it stays cheap on VDIs without a GPU.
// The trail is a few stacked dashes that end at the same point, so it fades
// out behind the bright head.
// Sizes are set as attributes in pixels and the motion uses the Web
// Animations API: both work in locked-down / older Edge builds, where SVG
// geometry in CSS or calc() inside keyframes may not.
const TRAIL = [
  { len: 130, cls: 'neon-trail t1' },
  { len: 75, cls: 'neon-trail t2' },
  { len: 35, cls: 'neon-trail t3' },
  { len: 45, cls: 'neon-halo' },
  { len: 12, cls: 'neon-head' },
]

const TOTAL = TRAIL[0].len
const LAP_MS = 14000

export function NeonBorder() {
  const svg = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const rects = svg.current ? Array.from(svg.current.querySelectorAll('rect')) : []
    const anims = rects.map((r, i) => {
      // every dash moves at the same speed; o shifts it so all of them end at the head
      const o = TOTAL - TRAIL[i].len
      return r.animate([{ strokeDashoffset: String(1000 - o) }, { strokeDashoffset: String(-o) }], {
        duration: LAP_MS,
        iterations: Infinity,
        easing: 'linear',
      })
    })
    return () => anims.forEach((a) => a.cancel())
  }, [])

  return (
    <svg ref={svg} className="neon" aria-hidden="true" width={size.w} height={size.h}>
      {TRAIL.map(({ len, cls }) => (
        <rect
          key={cls}
          className={cls}
          x={1.5}
          y={1.5}
          width={Math.max(0, size.w - 3)}
          height={Math.max(0, size.h - 3)}
          fill="none"
          pathLength={1000}
          strokeDasharray={`${len} ${1000 - len}`}
        />
      ))}
    </svg>
  )
}
