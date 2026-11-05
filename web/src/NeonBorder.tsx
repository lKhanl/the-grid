// A light-cycle trail running around the window edge. Drawn with plain SVG
// strokes (no CSS filters), so it stays cheap on VDIs without a GPU.
// The trail is a few stacked dashes that end at the same point, so it fades
// out behind the bright head.
const TRAIL = [
  { len: 130, cls: 'neon-trail t1' },
  { len: 75, cls: 'neon-trail t2' },
  { len: 35, cls: 'neon-trail t3' },
  { len: 45, cls: 'neon-halo' },
  { len: 12, cls: 'neon-head' },
]

const TOTAL = TRAIL[0].len

export function NeonBorder() {
  return (
    <svg className="neon" aria-hidden="true">
      {TRAIL.map(({ len, cls }) => (
        // every dash ends at the head: start offset = 1000 - (TOTAL - len)
        <rect key={cls} className={cls} pathLength={1000} strokeDasharray={`${len} ${1000 - len}`} style={{ ['--o' as string]: TOTAL - len }} />
      ))}
    </svg>
  )
}
