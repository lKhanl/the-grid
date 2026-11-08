import { ChangesIcon, DatabaseIcon, RuntimesIcon, ServicesIcon, SettingsIcon, TerminalIcon } from './icons'

export type Panel = 'services' | 'changes' | 'database' | 'runtimes' | 'settings'

interface Props {
  panel: Panel
  setPanel: (p: Panel) => void
  runningCount: number
  /** changed files in Changes */
  gitTotal: number
  /** the Database panel exists only in builds with -tags db */
  hasDb: boolean
  /** a connection has uncommitted changes */
  dbInTx: boolean
  runtimesBroken: boolean
  termOpen: boolean
  /** terminals still running */
  liveTerms: number
  onToggleTerm: () => void
}

/** The icon bar on the far left. */
export function ActivityBar({ panel, setPanel, runningCount, gitTotal, hasDb, dbInTx, runtimesBroken, termOpen, liveTerms, onToggleTerm }: Props) {
  return (
    <nav className="activitybar">
      <button
        className={`activity ${panel === 'services' ? 'on' : ''}`}
        aria-label="Services"
        onClick={() => setPanel('services')}
      >
        <ServicesIcon size={22} />
        <span className="activity-tip">Services</span>
        {runningCount > 0 && <span className="activity-badge">{runningCount}</span>}
      </button>
      <button
        className={`activity ${panel === 'changes' ? 'on' : ''}`}
        aria-label="Changes"
        onClick={() => setPanel('changes')}
      >
        <ChangesIcon size={22} />
        <span className="activity-tip">Changes (git diff)</span>
        {gitTotal > 0 && <span className="activity-badge">{gitTotal}</span>}
      </button>
      {hasDb && (
        <button
          className={`activity ${panel === 'database' ? 'on' : ''}`}
          aria-label="Database"
          onClick={() => setPanel('database')}
        >
          <DatabaseIcon size={22} />
          <span className="activity-tip">Database</span>
          {dbInTx && <span className="activity-badge warn">!</span>}
        </button>
      )}
      <button
        className={`activity ${panel === 'runtimes' ? 'on' : ''}`}
        aria-label="Runtimes"
        onClick={() => setPanel('runtimes')}
      >
        <RuntimesIcon size={22} />
        <span className="activity-tip">Runtimes</span>
        {runtimesBroken && <span className="activity-badge warn">!</span>}
      </button>
      <div className="activity-spacer" />
      <button
        className={`activity ${termOpen ? 'on' : ''}`}
        aria-label="Terminal"
        aria-pressed={termOpen}
        onClick={onToggleTerm}
      >
        <TerminalIcon size={22} />
        <span className="activity-tip">Terminal panel (Ctrl+`)</span>
        {liveTerms > 0 && <span className="activity-badge">{liveTerms}</span>}
      </button>
      <button
        className={`activity ${panel === 'settings' ? 'on' : ''}`}
        aria-label="Settings"
        onClick={() => setPanel('settings')}
      >
        <SettingsIcon size={21} />
        <span className="activity-tip">Settings</span>
      </button>
    </nav>
  )
}
