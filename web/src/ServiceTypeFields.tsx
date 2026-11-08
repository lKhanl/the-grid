import { type ReactNode, useState } from 'react'
import type { DetectResult, JarSpec, NodeSpec, ScriptSpec, ServiceSpec, ServiceType, SpringSpec } from './api'
import { CheckIcon, CodeIcon, JarIcon, NodeIcon, ScriptIcon, SpringIcon } from './icons'

// The "Run" fields of the service form that depend on the service type.

export const SHELLS = ['cmd', 'powershell', 'pwsh', 'bash', 'C:/Program Files/Git/bin/bash.exe', '/bin/zsh']

export const TYPES: { type: ServiceType; label: string; icon: ReactNode; help: string }[] = [
  { type: 'spring-boot', label: 'Spring Boot', icon: <SpringIcon size={20} />, help: 'Maven project. Every start builds the app, then runs it.' },
  { type: 'node', label: 'Node', icon: <NodeIcon size={20} />, help: 'Runs a package.json script; installs dependencies when they change.' },
  { type: 'script', label: 'Script', icon: <ScriptIcon size={20} />, help: 'A .bat, .cmd, .ps1, .sh or .py file in the folder.' },
  { type: 'jar', label: 'Jar', icon: <JarIcon size={20} />, help: 'An already built .jar, run with java -jar (no build step).' },
  { type: 'custom', label: 'Custom command', icon: <CodeIcon size={20} />, help: 'Any command line, run as you type it.' },
]

type Setter<T> = <K extends keyof T>(k: K, v: T[K]) => void

/** Spring Boot: application (module), how to run, profiles, VM options, build switches. */
export function SpringFields({ spec, det, setSpring }: { spec: ServiceSpec; det: DetectResult | null; setSpring: Setter<SpringSpec> }) {
  const [profileInput, setProfileInput] = useState('')
  const springMods = det?.spring?.modules ?? []
  const selMod = springMods.find((m) => m.path === (spec.spring?.module ?? ''))
  const detProfiles = selMod?.profiles ?? []
  const profiles = spec.spring?.profiles ?? []
  const allProfiles = [...new Set([...detProfiles, ...profiles])]

  function toggleProfile(p: string) {
    setSpring('profiles', profiles.includes(p) ? profiles.filter((x) => x !== p) : [...profiles, p])
  }

  return (
    <>
      <div className="grid-2">
        <label className="field">
          <span>Application</span>
          {springMods.length > 0 ? (
            <select value={spec.spring?.module ?? ''} onChange={(e) => setSpring('module', e.target.value)}>
              {springMods.map((m) => (
                <option key={m.path} value={m.path}>
                  {(m.path || m.artifactId) + (m.mainClass ? `  —  ${m.mainClass.split('.').pop()}` : '')}
                </option>
              ))}
              {selMod === undefined && <option value={spec.spring?.module ?? ''}>{spec.spring?.module || '(root)'}</option>}
            </select>
          ) : (
            <input className="mono" value={spec.spring?.module ?? ''} onChange={(e) => setSpring('module', e.target.value)} placeholder="module folder (empty = root)" />
          )}
          {selMod?.mainClass && <em className="muted small mono">{selMod.mainClass}</em>}
        </label>
        <div className="field">
          <span>How to run</span>
          <div className="segmented">
            <button type="button" className={spec.spring?.mode !== 'run' ? 'on' : ''} onClick={() => setSpring('mode', 'package')}>
              Build jar, then run
            </button>
            <button type="button" className={spec.spring?.mode === 'run' ? 'on' : ''} onClick={() => setSpring('mode', 'run')}>
              mvn spring-boot:run
            </button>
          </div>
        </div>
      </div>
      <div className="field">
        <span>Profiles</span>
        <div className="chips">
          {allProfiles.map((p) => {
            const on = profiles.includes(p)
            return (
              <button key={p} type="button" className={`chip toggle ${on ? 'on' : ''}`} onClick={() => toggleProfile(p)}>
                {on && <CheckIcon size={12} />}
                {p}
              </button>
            )
          })}
          <input
            className="chip-input"
            value={profileInput}
            placeholder={allProfiles.length ? '+ other' : 'e.g. local'}
            onChange={(e) => setProfileInput(e.target.value)}
            onKeyDown={(e) => {
              const v = profileInput.trim()
              if ((e.key === 'Enter' || e.key === ',') && v) {
                e.preventDefault()
                if (!profiles.includes(v)) setSpring('profiles', [...profiles, v])
                setProfileInput('')
              }
            }}
          />
        </div>
      </div>
      <div className="grid-2">
        <label className="field">
          <span>VM options</span>
          <input className="mono" value={spec.spring?.jvmArgs ?? ''} onChange={(e) => setSpring('jvmArgs', e.target.value)} placeholder="-Xmx1g -Dfile.encoding=UTF-8" />
        </label>
        <label className="field">
          <span>Program arguments</span>
          <input className="mono" value={spec.spring?.args ?? ''} onChange={(e) => setSpring('args', e.target.value)} placeholder="--server.port=8081" />
        </label>
      </div>
      <div className="checks">
        {spec.spring?.mode !== 'run' && (
          <label className="check" title="Passes -Dmaven.test.skip=true: tests are neither run nor compiled (faster). Turn off if a module needs another module's test jar.">
            <input type="checkbox" checked={spec.spring?.skipTests ?? true} onChange={(e) => setSpring('skipTests', e.target.checked)} />
            <span>Skip tests</span>
          </label>
        )}
        {spec.spring?.mode !== 'run' && (
          <label className="check" title="By default the build is skipped when nothing under src/ or in a pom.xml is newer than the jar. Turn this on to run mvn package on every start (for example when a dependency changed in ~/.m2).">
            <input type="checkbox" checked={spec.spring?.alwaysBuild ?? false} onChange={(e) => setSpring('alwaysBuild', e.target.checked)} />
            <span>Always rebuild</span>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={spec.spring?.offline ?? false} onChange={(e) => setSpring('offline', e.target.checked)} />
          <span>Offline (mvn -o)</span>
        </label>
      </div>
    </>
  )
}

/** Node: package.json script, arguments, install policy, package manager. */
export function NodeFields({ spec, det, setNode }: { spec: ServiceSpec; det: DetectResult | null; setNode: Setter<NodeSpec> }) {
  return (
    <>
      <div className="grid-2">
        <label className="field">
          <span>Script</span>
          {det?.node?.scripts.length ? (
            <select value={spec.node?.script ?? ''} onChange={(e) => setNode('script', e.target.value)}>
              {!det.node.scripts.includes(spec.node?.script ?? '') && <option value={spec.node?.script ?? ''}>{spec.node?.script || '—'}</option>}
              {det.node.scripts.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : (
            <input className="mono" value={spec.node?.script ?? ''} onChange={(e) => setNode('script', e.target.value)} placeholder="dev" />
          )}
          {det?.node?.commands?.[spec.node?.script ?? ''] && <em className="muted small mono">{det.node.commands[spec.node!.script]}</em>}
        </label>
        <label className="field">
          <span>Arguments</span>
          <input className="mono" value={spec.node?.args ?? ''} onChange={(e) => setNode('args', e.target.value)} placeholder="--host" />
        </label>
      </div>
      <div className="grid-2">
        <label className="field">
          <span>Install dependencies</span>
          <select value={spec.node?.install || 'if-changed'} onChange={(e) => setNode('install', e.target.value)}>
            <option value="if-changed">When package.json / lock file changed</option>
            <option value="always">Before every start</option>
            <option value="never">Never</option>
          </select>
        </label>
        <label className="field">
          <span>Package manager</span>
          <select value={spec.node?.packageManager || 'auto'} onChange={(e) => setNode('packageManager', e.target.value)}>
            <option value="auto">Auto{det?.node ? ` (${det.node.packageManager})` : ''}</option>
            <option value="npm">npm</option>
            <option value="yarn">yarn</option>
            <option value="pnpm">pnpm</option>
          </select>
        </label>
      </div>
    </>
  )
}

/** Script: the file to run and its arguments. */
export function ScriptFields({ spec, det, setScript }: { spec: ServiceSpec; det: DetectResult | null; setScript: Setter<ScriptSpec> }) {
  return (
    <div className="grid-2">
      <label className="field">
        <span>Script file</span>
        <input list="pr-scripts" className="mono" value={spec.script?.file ?? ''} onChange={(e) => setScript('file', e.target.value)} placeholder="start.bat" />
        <datalist id="pr-scripts">
          {det?.scripts?.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>
      <label className="field">
        <span>Arguments</span>
        <input className="mono" value={spec.script?.args ?? ''} onChange={(e) => setScript('args', e.target.value)} />
      </label>
    </div>
  )
}

/** Jar: the jar file, program arguments, VM options. */
export function JarFields({ spec, det, setJar }: { spec: ServiceSpec; det: DetectResult | null; setJar: Setter<JarSpec> }) {
  return (
    <>
      <div className="grid-2">
        <label className="field">
          <span>Jar file *</span>
          <input list="pr-jars" className="mono" value={spec.jar?.file ?? ''} onChange={(e) => setJar('file', e.target.value)} placeholder="target/app.jar  (or target/*.jar)" />
          <datalist id="pr-jars">
            {det?.jars?.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>Program arguments</span>
          <input className="mono" value={spec.jar?.args ?? ''} onChange={(e) => setJar('args', e.target.value)} placeholder="--server.port=8081" />
        </label>
      </div>
      <label className="field">
        <span>VM options</span>
        <input className="mono" value={spec.jar?.jvmArgs ?? ''} onChange={(e) => setJar('jvmArgs', e.target.value)} placeholder="-Xmx1g -Dfile.encoding=UTF-8" />
      </label>
    </>
  )
}

/** Custom: the command line. */
export function CommandField({ spec, set }: { spec: ServiceSpec; set: Setter<ServiceSpec> }) {
  return (
    <label className="field">
      <span>Command *</span>
      <textarea
        className="mono"
        rows={2}
        value={spec.command}
        onChange={(e) => set('command', e.target.value)}
        placeholder="java -jar target/app.jar"
      />
    </label>
  )
}

/** Shell of custom and script services. */
export function ShellField({ spec, set }: { spec: ServiceSpec; set: Setter<ServiceSpec> }) {
  return (
    <label className="field narrow-2">
      <span>Shell</span>
      <input list="pr-shells" value={spec.shell} onChange={(e) => set('shell', e.target.value)} placeholder="default (cmd on Windows, sh elsewhere)" />
      <datalist id="pr-shells">
        {SHELLS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </label>
  )
}
