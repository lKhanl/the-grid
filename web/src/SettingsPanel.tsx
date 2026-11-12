import type { Dispatch, SetStateAction } from 'react'
import { saveSettings, setLogLines, type State } from './api'
import type { Theme } from './theme'
import { formatBytes } from './ui'

export const SHORTCUTS: [string, [string[], string][]][] = [
  [
    'Services',
    [
      [['↑', '↓'], 'Select service'],
      [['S'], 'Start / stop'],
      [['R'], 'Restart'],
      [['C'], 'Clear log'],
      [['/'], 'Filter log'],
      [['Esc'], 'Close service / clear filter'],
      [['N'], 'New service'],
      [['E'], 'Edit service'],
    ],
  ],
  [
    'Terminals',
    [
      [['Ctrl', '`'], 'Show / hide terminal panel'],
      [['Ctrl', '⇧', '`'], 'New terminal'],
    ],
  ],
]

const LOG_BYTES_PER_LINE = 2000 // measured (server RSS + browser heap) with ~300-byte Spring-style lines

function logMemoryMB(lines: number, services: number) {
  const mb = (lines * services * LOG_BYTES_PER_LINE) / 1048576
  return mb < 10 ? mb.toFixed(1) : Math.round(mb)
}

interface Props {
  state: State | null
  setState: (s: State) => void
  setError: (e: string) => void
  theme: Theme
  setTheme: (t: Theme) => void
  neon: boolean
  setNeon: Dispatch<SetStateAction<boolean>>
  /** the system asks for less motion (the neon line starts off) */
  reducedMotion: boolean
}

/** Settings panel in the sidebar: theme, effects, logs, keyboard shortcuts. */
export function SettingsPanel({ state, setState, setError, theme, setTheme, neon, setNeon, reducedMotion }: Props) {
  const logLines = state?.logLines ?? 1000
  return (
    <>
      <div className="sidebar-head divided">
        <span>Settings</span>
      </div>
      <div className="settings">
        <section>
          <h4>Theme</h4>
          <div className="theme-cards">
            {(
              [
                ['grid', 'The Grid', 'Cyan light lines on black, neon.'],
                ['basic', 'Basic', 'Calm neutral greys, no glow.'],
              ] as [Theme, string, string][]
            ).map(([id, label, help]) => (
              <button key={id} className={`theme-card ${theme === id ? 'on' : ''}`} onClick={() => setTheme(id)}>
                <span className={`swatch swatch-${id}`}>
                  <i />
                  <i />
                  <i />
                </span>
                <strong>{label}</strong>
                <small>{help}</small>
              </button>
            ))}
          </div>
        </section>
        <section>
          <h4>Effects</h4>
          <div
            className={`setting-row ${theme !== 'grid' ? 'disabled' : ''}`}
            role="switch"
            aria-checked={neon}
            onClick={() => theme === 'grid' && setNeon((v) => !v)}
          >
            <span className="setting-text">
              <span>Neon line around the window</span>
              <small>
                {theme !== 'grid'
                  ? 'Only in The Grid theme.'
                  : reducedMotion
                    ? 'Your system asks for reduced motion, so it starts off here.'
                    : 'A light cycle running along the edges.'}
              </small>
            </span>
            <span className={`switch ${neon && theme === 'grid' ? 'on' : ''}`} />
          </div>
        </section>
        <section>
          <h4>Logs</h4>
          <div className="setting-text">
            <span>History per service</span>
            <small>Lines kept in memory. Fewer lines switch faster and use less memory.</small>
          </div>
          <div className="seg" role="radiogroup" aria-label="Log lines per service">
            {(state?.logLineOptions ?? [1000, 2500, 5000, 10000]).map((n) => (
              <button
                key={n}
                role="radio"
                aria-checked={logLines === n}
                className={logLines === n ? 'on' : ''}
                onClick={() => setLogLines(n).then(setState, (e) => setError(String(e.message ?? e)))}
              >
                {n.toLocaleString('en-US')}
              </button>
            ))}
          </div>
          <small className="seg-note">
            About {logMemoryMB(logLines, state?.services.length ?? 0)} MB for {state?.services.length ?? 0} services. Lowering it drops the oldest lines now.
            Saved in ~/.grid.
          </small>
          <div
            className="setting-row"
            role="switch"
            aria-checked={!!state?.logFiles}
            onClick={() => state && saveSettings({ logFiles: !state.logFiles }).then(setState, (e) => setError(String(e.message ?? e)))}
          >
            <span className="setting-text">
              <span>Save logs to files</span>
              <small>
                Keeps the logs on this machine after the Grid restarts, at most {formatBytes(state?.logFileMax ?? 10 << 20)} per service
                (the current file and the previous one).
              </small>
            </span>
            <span className={`switch ${state?.logFiles ? 'on' : ''}`} />
          </div>
          {state?.logFiles && state.logDir && (
            <small className="seg-note">
              Folder:{' '}
              <code className="path" title="Click to copy" onClick={() => navigator.clipboard?.writeText(state.logDir!)}>
                {state.logDir}
              </code>
            </small>
          )}
        </section>
        <section>
          <h4>Keyboard shortcuts</h4>
          {SHORTCUTS.map(([title, list]) => (
            <div key={title} className="shortcut-group">
              <div className="shortcut-title">{title}</div>
              {list.map(([keys, label]) => (
                <div key={label} className="hint">
                  <span className="keys">
                    {keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </span>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          ))}
        </section>
        <div className="settings-foot">
          {state?.version && <span className="settings-version">The Grid {state.version}</span>}
        </div>
      </div>
    </>
  )
}
