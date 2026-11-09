import type { RefObject } from 'react'
import type { DetectResult, RuntimeType, ServiceSpec, State } from './api'
import { CheckIcon, CloseIcon, HammerIcon, PlayIcon, PlusIcon, WarnIcon } from './icons'

// Sections of the service form that don't depend on the service type.

type Setter<T> = <K extends keyof T>(k: K, v: T[K]) => void

export type ReadyMode = 'none' | 'port' | 'log'

/** What was found in the working directory. */
export function DetectLine({ det, path }: { det: DetectResult; path: string }) {
  let text = 'No Maven or Node project found here'
  if (det.spring?.modules.length) {
    const n = det.spring.modules.length
    text = `Spring Boot (Maven) · ${det.spring.artifactId}${det.spring.javaVersion ? ` · Java ${det.spring.javaVersion}` : ''}${n > 1 ? ` · ${n} apps` : ''}${det.spring.wrapper ? ' · mvnw' : ''}`
  } else if (det.node) {
    text = `Node · ${det.node.name || 'package.json'} · ${det.node.packageManager}${det.node.nodeVersion ? ` · node ${det.node.nodeVersion}` : ''}`
  } else if (det.jars?.length) {
    text = `${det.jars.length} jar file${det.jars.length > 1 ? 's' : ''}`
  } else if (det.scripts?.length) {
    text = `${det.scripts.length} script file${det.scripts.length > 1 ? 's' : ''}`
  }
  return (
    <em className="field-ok" title={path}>
      <CheckIcon size={12} />
      {text}
    </em>
  )
}

/** Runtime chips (java / node / script installations), with a Java version hint for Spring Boot. */
export function RuntimeField({
  spec,
  state,
  det,
  onToggle,
  onNew,
}: {
  spec: ServiceSpec
  state: State
  det: DetectResult | null
  onToggle: (name: string, type?: RuntimeType) => void
  onNew: () => void
}) {
  const javaWanted = det?.spring?.javaVersion
  const javaPicked = state.runtimes.find((r) => r.type === 'java' && spec.runtime?.includes(r.name))
  const pickedMajor = Number(javaPicked?.name.match(/\d+/)?.[0] ?? 0)
  const javaTooOld = !!javaWanted && pickedMajor > 0 && pickedMajor < Number(javaWanted.match(/\d+/)?.[0] ?? 0)
  return (
    <div className="field">
      <span>Runtime{spec.type === 'spring-boot' ? ' (Java + Maven)' : spec.type === 'jar' ? ' (Java)' : spec.type === 'node' ? ' (Node)' : ''}</span>
      <div className="chips">
        {state.runtimes.map((r) => {
          const on = spec.runtime?.includes(r.name)
          return (
            <button
              key={r.name}
              type="button"
              className={`chip toggle chip-${r.type} ${on ? 'on' : ''} ${r.error ? 'chip-error' : ''}`}
              title={`${r.type}: ${r.home}${r.error ? `\n⚠ ${r.error}` : ''}`}
              onClick={() => onToggle(r.name)}
            >
              {on && <CheckIcon size={12} />}
              {r.name}
            </button>
          )
        })}
        <button type="button" className="chip toggle chip-add" onClick={onNew} title="Add a java / node / script installation">
          <PlusIcon size={12} />
          New runtime
        </button>
        {!spec.runtime?.length && <span className="muted small">none selected: java / mvn / node come from the system PATH</span>}
      </div>
      {spec.type === 'spring-boot' && javaWanted && (
        <em className={`small ${javaTooOld ? 'field-warn' : 'muted'}`}>
          pom.xml asks for Java {javaWanted}
          {javaPicked ? ` · using ${javaPicked.name}` : ' · using java from the system PATH'}
          {javaTooOld && ' (older than required, the build will likely fail)'}
        </em>
      )}
    </div>
  )
}

/** The build and run commands the form would produce. */
export function CommandPreview({ preview }: { preview: { build: string; run: string; error?: string } }) {
  return (
    <div className={`preview ${preview.error ? 'bad' : ''}`}>
      {preview.error ? (
        <div className="preview-row">
          <WarnIcon size={14} />
          <span>{preview.error}</span>
        </div>
      ) : (
        <>
          {preview.build && (
            <div className="preview-row">
              <span className="preview-tag build">
                <HammerIcon size={12} /> build
              </span>
              <code>{preview.build}</code>
            </div>
          )}
          <div className="preview-row">
            <span className="preview-tag run">
              <PlayIcon size={11} /> run
            </span>
            <code>{preview.run}</code>
          </div>
        </>
      )}
    </div>
  )
}

/** Name, group, URL. */
export function GeneralSection({
  spec,
  set,
  nameRef,
  nameError,
  editing,
  active,
  groups,
}: {
  spec: ServiceSpec
  set: Setter<ServiceSpec>
  nameRef: RefObject<HTMLInputElement | null>
  nameError: string | null
  editing: string | null
  active: boolean
  groups: string[]
}) {
  return (
    <section className="form-section">
      <h3>General</h3>
      <div className="grid-2">
        <label className="field">
          <span>Name *</span>
          <input ref={nameRef} value={spec.name} onChange={(e) => set('name', e.target.value)} placeholder="account-api" />
          {nameError && <em className="field-error">{nameError}</em>}
          {editing && active && spec.name !== editing && <em className="field-error">stop the service to rename it</em>}
        </label>
        <label className="field">
          <span>Group</span>
          <input list="pr-groups" value={spec.group} onChange={(e) => set('group', e.target.value)} placeholder="backend" />
          <datalist id="pr-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
      </div>
      <label className="field">
        <span>
          URL <span className="optional">optional</span>
        </span>
        <input value={spec.url} onChange={(e) => set('url', e.target.value)} placeholder="http://localhost:8080/swagger-ui.html" />
        <em className="muted small">Shown as a link next to the service name.</em>
      </label>
    </section>
  )
}

/** Environment variables and env file. */
export function EnvSection({ spec, set }: { spec: ServiceSpec; set: Setter<ServiceSpec> }) {
  const env = spec.env ?? []
  const setEnv = (i: number, k: 'key' | 'value', v: string) => set('env', env.map((e, j) => (j === i ? { ...e, [k]: v } : e)))
  return (
    <section className="form-section">
      <h3>Environment</h3>
      <div className="env-rows">
        {env.map((e, i) => (
          <div className="env-row" key={i}>
            <input className="mono" value={e.key} placeholder="NAME" onChange={(ev) => setEnv(i, 'key', ev.target.value)} />
            <span className="muted">=</span>
            <input className="mono" value={e.value} placeholder="value  (may use ${OTHER})" onChange={(ev) => setEnv(i, 'value', ev.target.value)} />
            <button className="btn" title="Remove" onClick={() => set('env', env.filter((_, j) => j !== i))}>
              <CloseIcon size={14} />
            </button>
          </div>
        ))}
        <button className="btn text" onClick={() => set('env', [...env, { key: '', value: '' }])}>
          <PlusIcon size={14} />
          <span>Add variable</span>
        </button>
      </div>
      <label className="field">
        <span>Env file</span>
        <input className="mono" value={spec.envFile} onChange={(e) => set('envFile', e.target.value)} placeholder=".env.local" />
      </label>
    </section>
  )
}

/** Readiness, dependencies, autostart, Changes visibility. */
export function StartupSection({
  spec,
  set,
  readyMode,
  setReadyMode,
  others,
  toggleDep,
}: {
  spec: ServiceSpec
  set: Setter<ServiceSpec>
  readyMode: ReadyMode
  setReadyMode: (m: ReadyMode) => void
  /** the other services (candidates for depends_on) */
  others: { name: string }[]
  toggleDep: (name: string) => void
}) {
  return (
    <section className="form-section">
      <h3>Startup</h3>
      <div className="field">
        <span>Ready when</span>
        <div className="segmented">
          {(['none', 'port', 'log'] as ReadyMode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={readyMode === m ? 'on' : ''}
              onClick={() => setReadyMode(m)}
            >
              {m === 'none' ? 'Immediately' : m === 'port' ? 'Port is open' : 'Log line matches'}
            </button>
          ))}
        </div>
      </div>
      {readyMode !== 'none' && (
        <div className="grid-2">
          {readyMode === 'port' ? (
            <label className="field">
              <span>Port</span>
              <input type="number" value={spec.readyPort || ''} onChange={(e) => set('readyPort', Number(e.target.value))} placeholder="8080" />
            </label>
          ) : (
            <label className="field">
              <span>Log regex</span>
              <input className="mono" value={spec.readyLog} onChange={(e) => set('readyLog', e.target.value)} placeholder="Started .* in" />
            </label>
          )}
          <label className="field">
            <span>Timeout</span>
            <input value={spec.readyTimeout} onChange={(e) => set('readyTimeout', e.target.value)} placeholder="3m" />
          </label>
        </div>
      )}
      {others.length > 0 && (
        <div className="field">
          <span>Start after (depends on)</span>
          <div className="chips">
            {others.map((s) => {
              const on = spec.dependsOn?.includes(s.name)
              return (
                <button key={s.name} type="button" className={`chip toggle ${on ? 'on' : ''}`} onClick={() => toggleDep(s.name)}>
                  {on && <CheckIcon size={12} />}
                  {s.name}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={spec.autostart} onChange={(e) => set('autostart', e.target.checked)} />
        <span>Start automatically when The Grid starts</span>
      </label>
      <label className="check" title="Services that share a working directory are one project in Changes: unticking this on any of them hides it">
        <input type="checkbox" checked={!spec.noChanges} onChange={(e) => set('noChanges', !e.target.checked)} />
        <span>Show this project in Changes</span>
      </label>
      {!spec.noChanges && (
        <label className="field" title="Not shown in Changes, without touching git: works for tracked files too. Right-click a file in Changes to add one.">
          <span>Hide from Changes (one pattern per line, relative to the working directory)</span>
          <textarea
            className="mono"
            rows={3}
            value={(spec.changesIgnore ?? []).join('\n')}
            onChange={(e) => set('changesIgnore', e.target.value.split('\n'))}
            placeholder={'*.iml\ntmp/\nsrc/main/resources/application-local.yml'}
            spellCheck={false}
          />
        </label>
      )}
    </section>
  )
}

/** Restart policy, encoding, stop timeout. */
export function AdvancedSection({ spec, set }: { spec: ServiceSpec; set: Setter<ServiceSpec> }) {
  return (
    <details className="form-section">
      <summary>
        <h3>Advanced</h3>
      </summary>
      <div className="grid-3">
        <label className="field">
          <span>Restart policy</span>
          <select value={spec.restart || 'no'} onChange={(e) => set('restart', e.target.value)}>
            <option value="no">Never</option>
            <option value="on-failure">On failure</option>
            <option value="always">Always</option>
          </select>
        </label>
        <label className="field">
          <span>Max restarts</span>
          <input
            type="number"
            disabled={!spec.restart || spec.restart === 'no'}
            value={spec.maxRestarts || ''}
            onChange={(e) => set('maxRestarts', Number(e.target.value))}
            placeholder="5"
          />
        </label>
        <label className="field">
          <span>Log encoding</span>
          <select value={spec.encoding || 'auto'} onChange={(e) => set('encoding', e.target.value)}>
            <option value="auto">Auto (UTF-8, else cp1254)</option>
            <option value="utf-8">UTF-8</option>
            <option value="cp1254">cp1254 (Turkish Windows)</option>
          </select>
        </label>
      </div>
      <label className="field narrow">
        <span>Stop timeout</span>
        <input value={spec.stopTimeout} onChange={(e) => set('stopTimeout', e.target.value)} placeholder="10s" />
      </label>
    </details>
  )
}
