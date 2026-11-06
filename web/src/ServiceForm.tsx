import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  checkPath,
  deleteService,
  detect,
  emptyNode,
  emptyJar,
  emptyScript,
  emptySpec,
  emptySpring,
  getSpec,
  previewSpec,
  saveSpec,
  type DetectResult,
  type Info,
  type NodeSpec,
  type RuntimeType,
  type JarSpec,
  type ScriptSpec,
  type ServiceSpec,
  type ServiceType,
  type SpringSpec,
  type State,
} from './api'
import { CheckIcon, CloseIcon, CodeIcon, FolderIcon, HammerIcon, JarIcon, NodeIcon, PlayIcon, PlusIcon, ScriptIcon, SpringIcon, TrashIcon, WarnIcon } from './icons'
import { RuntimeForm } from './RuntimeForm'
import { FolderPicker } from './FolderPicker'

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SHELLS = ['cmd', 'powershell', 'pwsh', 'bash', 'C:/Program Files/Git/bin/bash.exe', '/bin/zsh']

const TYPES: { type: ServiceType; label: string; icon: ReactNode; help: string }[] = [
  { type: 'spring-boot', label: 'Spring Boot', icon: <SpringIcon size={20} />, help: 'Maven project. Every start builds the app, then runs it.' },
  { type: 'node', label: 'Node', icon: <NodeIcon size={20} />, help: 'Runs a package.json script; installs dependencies when they change.' },
  { type: 'script', label: 'Script', icon: <ScriptIcon size={20} />, help: 'A .bat, .cmd, .ps1, .sh or .py file in the folder.' },
  { type: 'jar', label: 'Jar', icon: <JarIcon size={20} />, help: 'An already built .jar, run with java -jar (no build step).' },
  { type: 'custom', label: 'Custom command', icon: <CodeIcon size={20} />, help: 'Any command line, run as you type it.' },
]

interface Props {
  state: State
  /** null = create a new service */
  editing: string | null
  /** prefill for "new service in group X" */
  initialGroup?: string
  /** prefill the working directory */
  initialCwd?: string
  onClose: () => void
  /** called after a successful save/delete with the service to select */
  onDone: (select: string | null, then?: 'start' | 'restart') => void
}

type ReadyMode = 'none' | 'port' | 'log'

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '')

export function ServiceForm({ state, editing, initialGroup, initialCwd, onClose, onDone }: Props) {
  const [spec, setSpec] = useState<ServiceSpec | null>(editing ? null : { ...emptySpec(), group: initialGroup ?? '', cwd: initialCwd ?? '' })
  const [readyMode, setReadyMode] = useState<ReadyMode>('none')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [cwdInfo, setCwdInfo] = useState<{ path: string; exists: boolean; dir: boolean } | null>(null)
  const [det, setDet] = useState<DetectResult | null>(null)
  const [preview, setPreview] = useState<{ build: string; run: string; error?: string } | null>(null)
  const [newRuntime, setNewRuntime] = useState(false)
  const [picker, setPicker] = useState(false)
  const [profileInput, setProfileInput] = useState('')
  // Fields the user changed by hand are never overwritten by detection.
  const touched = useRef(new Set<string>(editing ? ['*'] : []))
  const nameRef = useRef<HTMLInputElement>(null)

  const current: Info | undefined = state.services.find((s) => s.name === editing)
  const active = !!current && ['starting', 'building', 'running', 'stopping'].includes(current.status)
  const groups = useMemo(() => [...new Set(state.services.map((s) => s.group).filter(Boolean))], [state])
  const others = state.services.filter((s) => s.name !== editing)
  const configDir = state.configPath.replace(/[\\/][^\\/]*$/, '')
  const isTouched = (k: string) => touched.current.has('*') || touched.current.has(k)

  useEffect(() => {
    if (!editing) return
    getSpec(editing).then(
      (s) => {
        setSpec({ ...s, runtime: s.runtime ?? [], env: s.env ?? [], dependsOn: s.dependsOn ?? [], type: s.type || 'custom' })
        setReadyMode(s.readyPort ? 'port' : s.readyLog ? 'log' : 'none')
      },
      (e) => setError(e.message),
    )
  }, [editing])

  useEffect(() => {
    if (spec && !editing) nameRef.current?.focus()
  }, [spec === null]) // eslint-disable-line react-hooks/exhaustive-deps

  // Working directory: check it and detect the project (debounced).
  const cwd = spec?.cwd ?? ''
  useEffect(() => {
    if (!spec) return
    let live = true
    const id = setTimeout(() => {
      checkPath(cwd).then((i) => live && setCwdInfo(i), () => live && setCwdInfo(null))
      detect(cwd).then((d) => live && (setDet(d), autofill(d)), () => live && setDet(null))
    }, 300)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [cwd, spec === null]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live preview of the generated commands.
  const previewKey = spec ? JSON.stringify([spec.type, spec.cwd, spec.command, spec.spring, spec.node, spec.script, spec.jar]) : ''
  useEffect(() => {
    if (!spec) return
    let live = true
    const id = setTimeout(() => previewSpec(spec).then((p) => live && setPreview(p), () => {}), 250)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [previewKey]) // eslint-disable-line react-hooks/exhaustive-deps

  function runtimesOf(type: RuntimeType) {
    return state.runtimes.filter((r) => r.type === type)
  }

  /** Runtime whose name carries the wanted major version (java-17 for "17"). */
  function matchRuntime(type: RuntimeType, version?: string) {
    const major = version?.match(/\d+/)?.[0]
    if (!major) return undefined
    return runtimesOf(type).find((r) => new RegExp(`(^|\\D)${major}(\\D|$)`).test(r.name))
  }

  function autofill(d: DetectResult) {
    if (touched.current.has('*') || !d.exists) return
    setSpec((s) => {
      if (!s) return s
      const n: ServiceSpec = { ...s }
      if (!isTouched('type')) n.type = d.suggested
      const pickRuntimes: string[] = []
      let name = '',
        url = '',
        ready: { mode: ReadyMode; port?: number; log?: string } | null = null
      if (n.type === 'spring-boot' && d.spring) {
        const mod = d.spring.modules[0]
        if (!isTouched('spring')) n.spring = { ...emptySpring(), module: mod?.path ?? '' }
        name = mod?.artifactId || d.spring.artifactId
        if (mod?.port) url = `http://localhost:${mod.port}`
        ready = { mode: 'log', log: 'Started .* in' }
        const java = matchRuntime('java', d.spring.javaVersion)
        if (java) pickRuntimes.push(java.name)
        const mvn = runtimesOf('script').find((r) => /^(maven|mvn)/i.test(r.name))
        if (mvn) pickRuntimes.push(mvn.name)
      } else if (n.type === 'node' && d.node) {
        const script = d.node.scripts[0] ?? ''
        if (!isTouched('node')) n.node = { ...emptyNode(), script }
        name = d.node.name
        const port = d.node.ports?.[n.node?.script || script]
        if (port) {
          url = `http://localhost:${port}`
          ready = { mode: 'port', port }
        }
        const node = matchRuntime('node', d.node.nodeVersion)
        if (node) pickRuntimes.push(node.name)
      } else if (n.type === 'script' && d.scripts?.length) {
        if (!isTouched('script')) n.script = { ...emptyScript(), file: d.scripts[0] }
      } else if (n.type === 'jar' && d.jars?.length) {
        const jar = d.jars[0]
        if (!isTouched('jar')) n.jar = { ...emptyJar(), file: jar }
        name = jar.split('/').pop()!.replace(/\.jar$/i, '').replace(/-\d.*$/, '')
        const java = runtimesOf('java')[0]
        if (java) pickRuntimes.push(java.name)
      }
      if (!isTouched('name') && name) n.name = slug(name)
      if (!isTouched('url') && url) n.url = url
      if (!isTouched('runtime') && pickRuntimes.length) n.runtime = pickRuntimes
      if (!isTouched('ready') && ready) {
        setReadyMode(ready.mode)
        n.readyPort = ready.port ?? 0
        n.readyLog = ready.log ?? ''
      }
      return n
    })
  }

  const set = <K extends keyof ServiceSpec>(k: K, v: ServiceSpec[K]) => {
    touched.current.add(k === 'readyPort' || k === 'readyLog' ? 'ready' : k)
    setSpec((s) => (s ? { ...s, [k]: v } : s))
  }
  const setSpring = <K extends keyof SpringSpec>(k: K, v: SpringSpec[K]) => {
    touched.current.add('spring')
    setSpec((s) => (s ? { ...s, spring: { ...(s.spring ?? emptySpring()), [k]: v } } : s))
  }
  const setNode = <K extends keyof NodeSpec>(k: K, v: NodeSpec[K]) => {
    touched.current.add('node')
    setSpec((s) => (s ? { ...s, node: { ...(s.node ?? emptyNode()), [k]: v } } : s))
  }
  const setScript = <K extends keyof ScriptSpec>(k: K, v: ScriptSpec[K]) => {
    touched.current.add('script')
    setSpec((s) => (s ? { ...s, script: { ...(s.script ?? emptyScript()), [k]: v } } : s))
  }

  const setJar = <K extends keyof JarSpec>(k: K, v: JarSpec[K]) => {
    touched.current.add('jar')
    setSpec((s) => (s ? { ...s, jar: { ...(s.jar ?? emptyJar()), [k]: v } } : s))
  }

  function chooseType(t: ServiceType) {
    touched.current.add('type')
    setSpec((s) => {
      if (!s) return s
      const n = { ...s, type: t }
      if (t === 'spring-boot' && !n.spring) n.spring = { ...emptySpring(), module: det?.spring?.modules[0]?.path ?? '' }
      if (t === 'node' && !n.node) n.node = { ...emptyNode(), script: det?.node?.scripts[0] ?? '' }
      if (t === 'script' && !n.script) n.script = { ...emptyScript(), file: det?.scripts?.[0] ?? '' }
      if (t === 'jar' && !n.jar) n.jar = { ...emptyJar(), file: det?.jars?.[0] ?? '' }
      return n
    })
  }

  function pickFolder(p: string) {
    setPicker(false)
    // keep paths inside the config folder relative (portable between machines)
    const rel = p === configDir ? '.' : p.startsWith(configDir + '/') || p.startsWith(configDir + '\\') ? p.slice(configDir.length + 1) : p
    set('cwd', rel)
  }

  const nameError = spec && spec.name && !NAME_RE.test(spec.name) ? "letters, digits, '.', '_' or '-' only" : null
  const typeError = !spec
    ? null
    : spec.type === 'custom' && !spec.command.trim()
      ? 'Enter a command'
      : spec.type === 'node' && !spec.node?.script
        ? 'Pick a package.json script'
        : spec.type === 'script' && !spec.script?.file
          ? 'Pick a script file'
          : spec.type === 'jar' && !spec.jar?.file
            ? 'Pick a jar file'
            : null
  const canSave = !!spec && !!spec.name && !nameError && !typeError && !busy

  async function save(then?: 'start' | 'restart') {
    if (!spec || !canSave) return
    const out: ServiceSpec = {
      ...spec,
      name: spec.name.trim(),
      env: (spec.env ?? []).filter((e) => e.key.trim()),
      readyPort: readyMode === 'port' ? Number(spec.readyPort) || 0 : 0,
      readyLog: readyMode === 'log' ? spec.readyLog : '',
      readyTimeout: readyMode === 'none' ? '' : spec.readyTimeout,
      maxRestarts: Number(spec.maxRestarts) || 0,
      spring: spec.type === 'spring-boot' ? (spec.spring ?? emptySpring()) : null,
      node: spec.type === 'node' ? spec.node : null,
      script: spec.type === 'script' ? spec.script : null,
      jar: spec.type === 'jar' ? spec.jar : null,
    }
    setBusy(true)
    setError(null)
    try {
      await saveSpec(out, editing)
      onDone(out.name, then)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!editing) return
    if (!confirmDelete) return setConfirmDelete(true)
    setBusy(true)
    try {
      await deleteService(editing)
      onDone(null)
    } catch (e) {
      setError((e as Error).message)
      setConfirmDelete(false)
    } finally {
      setBusy(false)
    }
  }

  function toggleRuntime(name: string, knownType?: RuntimeType) {
    if (!spec) return
    const type = knownType ?? state.runtimes.find((r) => r.name === name)?.type
    const cur = spec.runtime ?? []
    if (cur.includes(name)) return set('runtime', cur.filter((n) => n !== name))
    // one java and one node at most; any number of script runtimes
    const keep = cur.filter((n) => type === 'script' || state.runtimes.find((r) => r.name === n)?.type !== type)
    set('runtime', [...keep, name])
  }

  function toggleDep(name: string) {
    if (!spec) return
    const cur = spec.dependsOn ?? []
    set('dependsOn', cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name])
  }

  function toggleProfile(p: string) {
    const cur = spec?.spring?.profiles ?? []
    setSpring('profiles', cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p])
  }

  const env = spec?.env ?? []
  const setEnv = (i: number, k: 'key' | 'value', v: string) => set('env', env.map((e, j) => (j === i ? { ...e, [k]: v } : e)))

  const springMods = det?.spring?.modules ?? []
  const selMod = springMods.find((m) => m.path === (spec?.spring?.module ?? ''))
  const detProfiles = selMod?.profiles ?? []
  const profiles = spec?.spring?.profiles ?? []
  const allProfiles = [...new Set([...detProfiles, ...profiles])]
  const javaWanted = det?.spring?.javaVersion
  const javaPicked = state.runtimes.find((r) => r.type === 'java' && spec?.runtime?.includes(r.name))
  const pickedMajor = Number(javaPicked?.name.match(/\d+/)?.[0] ?? 0)
  const javaTooOld = !!javaWanted && pickedMajor > 0 && pickedMajor < Number(javaWanted.match(/\d+/)?.[0] ?? 0)

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{editing ? `Edit ${editing}` : 'New service'}</h2>
          <span className="muted small">{state.configPath}</span>
          <div className="spacer" />
          <button className="btn" title="Close (Esc)" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        {!spec ? (
          <div className="modal-body muted">{error ?? 'Loading…'}</div>
        ) : (
          <div className="modal-body">
            <section className="form-section">
              <h3>Project</h3>
              <div className="field">
                <span>Working directory</span>
                <div className="input-row">
                  <input className="mono" value={spec.cwd} onChange={(e) => set('cwd', e.target.value)} placeholder="C:/dev/account-api" spellCheck={false} />
                  <button className="btn text" onClick={() => setPicker(true)}>
                    <FolderIcon size={15} />
                    <span>Browse…</span>
                  </button>
                </div>
                {cwdInfo && !cwdInfo.dir && (
                  <em className="field-error">
                    <WarnIcon size={12} />
                    not found: {cwdInfo.path}
                  </em>
                )}
                {cwdInfo?.dir && det && <DetectLine det={det} path={cwdInfo.path} />}
              </div>
              <div className="field">
                <span>Type</span>
                <div className="type-cards four">
                  {TYPES.map((t) => (
                    <button
                      key={t.type}
                      type="button"
                      className={`type-card svc-${t.type} ${spec.type === t.type ? 'on' : ''}`}
                      onClick={() => chooseType(t.type)}
                    >
                      <span className="type-icon">{t.icon}</span>
                      <strong>{t.label}</strong>
                      {det?.exists && det.suggested === t.type && t.type !== 'custom' && <span className="detected">detected</span>}
                    </button>
                  ))}
                </div>
                <em className="muted small help">{TYPES.find((t) => t.type === spec.type)?.help}</em>
              </div>
            </section>

            <section className="form-section">
              <h3>Run</h3>

              {spec.type === 'spring-boot' && (
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
              )}

              {spec.type === 'node' && (
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
              )}

              {spec.type === 'script' && (
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
              )}

              {spec.type === 'jar' && (
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
              )}

              {spec.type === 'custom' && (
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
              )}

              {(spec.type === 'custom' || spec.type === 'script') && (
                <label className="field narrow-2">
                  <span>Shell</span>
                  <input list="pr-shells" value={spec.shell} onChange={(e) => set('shell', e.target.value)} placeholder="default (cmd on Windows, sh elsewhere)" />
                  <datalist id="pr-shells">
                    {SHELLS.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </label>
              )}

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
                        onClick={() => toggleRuntime(r.name)}
                      >
                        {on && <CheckIcon size={12} />}
                        {r.name}
                      </button>
                    )
                  })}
                  <button type="button" className="chip toggle chip-add" onClick={() => setNewRuntime(true)} title="Add a java / node / script installation">
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

              {preview && (
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
              )}
            </section>

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
                      onClick={() => {
                        touched.current.add('ready')
                        setReadyMode(m)
                      }}
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
            </section>

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
          </div>
        )}

        {error && spec && <div className="form-error">{error}</div>}

        <div className="modal-foot">
          {editing && spec && (
            <button className={`btn text red ${confirmDelete ? 'danger' : ''}`} onClick={remove} disabled={busy}>
              <TrashIcon size={14} />
              <span>{confirmDelete ? (active ? 'Stop & delete?' : 'Click again to delete') : 'Delete'}</span>
            </button>
          )}
          <div className="spacer" />
          {typeError && spec && <span className="muted small">{typeError}</span>}
          {!typeError && editing && active && <span className="muted small">Changes apply on the next start.</span>}
          <button className="btn text" onClick={onClose}>
            <span>Cancel</span>
          </button>
          {editing && active ? (
            <button className="btn text" disabled={!canSave} onClick={() => save('restart')}>
              <span>Save & restart</span>
            </button>
          ) : (
            <button className="btn text" disabled={!canSave} onClick={() => save('start')}>
              <span>Save & start</span>
            </button>
          )}
          <button className="btn text primary" disabled={!canSave} onClick={() => save()} title="Ctrl/⌘ + Enter">
            <span>Save</span>
          </button>
        </div>
      </div>
      {newRuntime && (
        <RuntimeForm
          state={state}
          editing={null}
          onClose={() => setNewRuntime(false)}
          onDone={(name, type) => {
            setNewRuntime(false)
            if (name) toggleRuntime(name, type)
          }}
        />
      )}
      {picker && spec && (
        <FolderPicker start="~" onClose={() => setPicker(false)} onPick={pickFolder} />
      )}
    </div>
  )
}

function DetectLine({ det, path }: { det: DetectResult; path: string }) {
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
