import { useEffect, useMemo, useRef, useState } from 'react'
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
import { CloseIcon, FolderIcon, TrashIcon, WarnIcon } from './icons'
import { RuntimeForm } from './RuntimeForm'
import { FolderPicker } from './FolderPicker'
import { CommandField, JarFields, NodeFields, ScriptFields, ShellField, SpringFields, TYPES } from './ServiceTypeFields'
import { AdvancedSection, CommandPreview, DetectLine, EnvSection, GeneralSection, RuntimeField, StartupSection, type ReadyMode } from './ServiceFormSections'

// The service form: state, project detection and saving are here; the fields
// live in ServiceTypeFields.tsx (per type) and ServiceFormSections.tsx.

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

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
  const [step, setStep] = useState(0)
  const steps = ['Project', 'Run', 'General', 'Environment', 'Startup']
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
          <span className="step-indicator muted small">{steps[step]} ({step + 1}/{steps.length})</span>
          <button className="btn" title="Close (Esc)" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        {!spec ? (
          <div className="modal-body muted">{error ?? 'Loading…'}</div>
        ) : (
          <div className="modal-body">
            {step === 0 && (
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
            )}

            {step === 1 && (
              <section className="form-section">
                <h3>Run</h3>
                {spec.type === 'spring-boot' && <SpringFields spec={spec} det={det} setSpring={setSpring} />}
                {spec.type === 'node' && <NodeFields spec={spec} det={det} setNode={setNode} />}
                {spec.type === 'script' && <ScriptFields spec={spec} det={det} setScript={setScript} />}
                {spec.type === 'jar' && <JarFields spec={spec} det={det} setJar={setJar} />}
                {spec.type === 'custom' && <CommandField spec={spec} set={set} />}
                {(spec.type === 'custom' || spec.type === 'script') && <ShellField spec={spec} set={set} />}
                <RuntimeField spec={spec} state={state} det={det} onToggle={toggleRuntime} onNew={() => setNewRuntime(true)} />
                {preview && <CommandPreview preview={preview} />}
              </section>
            )}

            {step === 2 && <GeneralSection spec={spec} set={set} nameRef={nameRef} nameError={nameError} editing={editing} active={active} groups={groups} />}

            {step === 3 && <EnvSection spec={spec} set={set} />}

            {step === 4 && (
              <>
                <StartupSection
                  spec={spec}
                  set={set}
                  readyMode={readyMode}
                  setReadyMode={(m) => {
                    touched.current.add('ready')
                    setReadyMode(m)
                  }}
                  others={others}
                  toggleDep={toggleDep}
                />
                <AdvancedSection spec={spec} set={set} />
              </>
            )}
          </div>
        )}

        {error && spec && <div className="form-error">{error}</div>}

        <div className="modal-foot">
          {editing && spec && step === 4 && (
            <button className={`btn text red ${confirmDelete ? 'danger' : ''}`} onClick={remove} disabled={busy}>
              <TrashIcon size={14} />
              <span>{confirmDelete ? (active ? 'Stop & delete?' : 'Click again to delete') : 'Delete'}</span>
            </button>
          )}
          <div className="spacer" />
          {error && spec && <span className="muted small">{error}</span>}
          {!error && typeError && spec && step === 4 && <span className="muted small">{typeError}</span>}
          {!error && !typeError && editing && active && step === 4 && <span className="muted small">Changes apply on the next start.</span>}
          {step > 0 && (
            <button className="btn text" onClick={() => setStep((s) => Math.max(0, s - 1))}>
              <span>Back</span>
            </button>
          )}
          {step < steps.length - 1 ? (
            <button className="btn text primary" onClick={() => setStep((s) => Math.min(steps.length - 1, s + 1))}>
              <span>Next</span>
            </button>
          ) : (
            <>
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
            </>
          )}
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
