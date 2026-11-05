import { useEffect, useRef, useState } from 'react'
import { deleteRuntime, getRuntime, probeRuntime, saveRuntime, type ProbeResult, type RuntimeSpec, type RuntimeType, type State } from './api'
import { CheckIcon, CloseIcon, PlusIcon, RuntimeTypeIcon, TrashIcon, WarnIcon } from './icons'

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const TYPES: { type: RuntimeType; label: string; help: string; name: string; home: string }[] = [
  {
    type: 'java',
    label: 'Java',
    help: 'A JDK folder. Sets JAVA_HOME and puts its bin first on PATH, so java and mvn use this JDK.',
    name: 'java-17',
    home: 'C:/Program Files/Java/jdk-17',
  },
  {
    type: 'node',
    label: 'Node',
    help: 'A Node.js folder (the unzipped zip is enough). node, npm and npx come from here.',
    name: 'node-20',
    home: 'C:/tools/node-v20.18.0-win-x64',
  },
  {
    type: 'script',
    label: 'Script / tool',
    help: 'Any tool folder: Maven, Gradle, Python, your own scripts. Its bin folder (or the folder itself) goes first on PATH.',
    name: 'maven-3.9',
    home: 'C:/Program Files/JetBrains/IntelliJ IDEA/plugins/maven/lib/maven3',
  },
]

function guessType(name: string): RuntimeType | null {
  const n = name.toLowerCase()
  if (/^(java|jdk|jre)/.test(n)) return 'java'
  if (n.startsWith('node')) return 'node'
  if (/^(maven|mvn|gradle|python|py|tool|script)/.test(n)) return 'script'
  return null
}

interface Props {
  state: State
  /** null = create */
  editing: string | null
  onClose: () => void
  /** called after save (with the runtime name and type) or delete (null) */
  onDone: (name: string | null, type?: RuntimeType) => void
}

export function RuntimeForm({ state, editing, onClose, onDone }: Props) {
  const [spec, setSpec] = useState<RuntimeSpec | null>(editing ? null : { name: '', type: 'java', home: '', bin: '', env: [] })
  const [typeTouched, setTypeTouched] = useState(!!editing)
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [probing, setProbing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  const users = state.services.filter((s) => editing && s.runtimes?.includes(editing)).map((s) => s.name)
  const meta = TYPES.find((t) => t.type === spec?.type) ?? TYPES[0]

  useEffect(() => {
    if (!editing) return
    getRuntime(editing).then((s) => setSpec({ ...s, env: s.env ?? [] }), (e) => setError(e.message))
  }, [editing])

  useEffect(() => {
    if (spec) nameRef.current?.focus()
  }, [spec === null]) // eslint-disable-line react-hooks/exhaustive-deps

  // Check the folder and read the real version, debounced.
  const key = spec ? `${spec.type}|${spec.home}|${spec.bin}` : ''
  useEffect(() => {
    if (!spec || !spec.home.trim()) {
      setProbe(null)
      return
    }
    setProbing(true)
    let live = true
    const id = setTimeout(() => {
      probeRuntime(spec.type, spec.home, spec.bin).then(
        (p) => live && (setProbe(p), setProbing(false)),
        () => live && (setProbe(null), setProbing(false)),
      )
    }, 400)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof RuntimeSpec>(k: K, v: RuntimeSpec[K]) => setSpec((s) => (s ? { ...s, [k]: v } : s))

  function setName(name: string) {
    setSpec((s) => {
      if (!s) return s
      const g = !typeTouched && guessType(name)
      return { ...s, name, type: g || s.type }
    })
  }

  const exists = !!spec && state.runtimes.some((r) => r.name === spec.name.trim() && r.name !== editing)
  const nameError =
    spec && spec.name && !NAME_RE.test(spec.name.trim()) ? "letters, digits, '.', '_' or '-' only" : exists ? 'a runtime with this name exists' : null
  const canSave = !!spec && !!spec.name.trim() && !nameError && !!spec.home.trim() && !busy

  async function save() {
    if (!spec || !canSave) return
    setBusy(true)
    setError(null)
    try {
      const out = { ...spec, name: spec.name.trim(), env: (spec.env ?? []).filter((e) => e.key.trim()) }
      await saveRuntime(out, editing)
      onDone(out.name, out.type)
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
      await deleteRuntime(editing, users.length > 0)
      onDone(null)
    } catch (e) {
      setError((e as Error).message)
      setConfirmDelete(false)
    } finally {
      setBusy(false)
    }
  }

  const env = spec?.env ?? []
  const setEnv = (i: number, k: 'key' | 'value', v: string) => set('env', env.map((e, j) => (j === i ? { ...e, [k]: v } : e)))

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        e.stopPropagation() // may be stacked on the service form
        if (e.key === 'Escape') onClose()
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
      }}
    >
      <div className="modal modal-narrow" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{editing ? `Edit runtime ${editing}` : 'New runtime'}</h2>
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
              <div className="field">
                <span>Type</span>
                <div className="type-cards">
                  {TYPES.map((t) => (
                    <button
                      key={t.type}
                      type="button"
                      className={`type-card type-${t.type} ${spec.type === t.type ? 'on' : ''}`}
                      onClick={() => {
                        setTypeTouched(true)
                        set('type', t.type)
                      }}
                    >
                      <RuntimeTypeIcon type={t.type} size={22} />
                      <strong>{t.label}</strong>
                    </button>
                  ))}
                </div>
                <em className="muted small help">{meta.help}</em>
              </div>
              <label className="field">
                <span>Name *</span>
                <input ref={nameRef} value={spec.name} onChange={(e) => setName(e.target.value)} placeholder={meta.name} />
                {nameError ? (
                  <em className="field-error">{nameError}</em>
                ) : (
                  <em className="muted small">Services pick it by this name, e.g. runtime: {spec.name.trim() || meta.name}</em>
                )}
              </label>
              <label className="field">
                <span>Home folder *</span>
                <input className="mono" value={spec.home} onChange={(e) => set('home', e.target.value)} placeholder={meta.home} />
                {probing && !probe && <em className="muted small">checking…</em>}
                {probe && <ProbeLine probe={probe} type={spec.type} />}
              </label>
            </section>

            <details className="form-section" open={!!spec.bin || env.length > 0}>
              <summary>
                <h3>Advanced</h3>
              </summary>
              <label className="field">
                <span>Bin folder</span>
                <input className="mono" value={spec.bin} onChange={(e) => set('bin', e.target.value)} placeholder="bin (relative to home; leave empty for the default)" />
              </label>
              <div className="field">
                <span>Extra environment</span>
                <div className="env-rows">
                  {env.map((e, i) => (
                    <div className="env-row" key={i}>
                      <input className="mono" value={e.key} placeholder={spec.type === 'script' ? 'MAVEN_OPTS' : 'NAME'} onChange={(ev) => setEnv(i, 'key', ev.target.value)} />
                      <span className="muted">=</span>
                      <input className="mono" value={e.value} placeholder={spec.type === 'script' ? '-Xmx1g' : 'value'} onChange={(ev) => setEnv(i, 'value', ev.target.value)} />
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
              </div>
            </details>

            {editing && (
              <div className="muted small used-by">
                {users.length ? `Used by: ${users.join(', ')}` : 'Not used by any service yet.'}
              </div>
            )}
          </div>
        )}

        {error && spec && <div className="form-error">{error}</div>}

        <div className="modal-foot">
          {editing && spec && (
            <button
              className={`btn text red ${confirmDelete ? 'danger' : ''}`}
              onClick={remove}
              disabled={busy}
              title={users.length ? `Also removes it from ${users.join(', ')}` : 'Delete runtime'}
            >
              <TrashIcon size={14} />
              <span>
                {confirmDelete
                  ? users.length
                    ? `Remove from ${users.join(', ')} and delete?`
                    : 'Click again to delete'
                  : 'Delete'}
              </span>
            </button>
          )}
          <div className="spacer" />
          {editing && users.length > 0 && !confirmDelete && <span className="muted small">Running services pick up changes on their next start.</span>}
          <button className="btn text" onClick={onClose}>
            <span>Cancel</span>
          </button>
          <button className="btn text primary" disabled={!canSave} onClick={save} title="Ctrl/⌘ + Enter">
            <span>Save</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function ProbeLine({ probe, type }: { probe: ProbeResult; type: RuntimeType }) {
  if (probe.error) {
    return (
      <em className="field-error">
        <WarnIcon size={12} />
        {probe.exists ? probe.error : `folder not found: ${probe.home}`}
      </em>
    )
  }
  if (type === 'script') {
    return (
      <em className="field-ok">
        <CheckIcon size={12} />
        PATH gets {probe.binDir}
        {probe.tools?.length ? ` · ${probe.tools.join(', ')}` : ''}
      </em>
    )
  }
  return (
    <em className="field-ok">
      <CheckIcon size={12} />
      {probe.version || `${type} found`} <span className="muted">· {probe.exe}</span>
    </em>
  )
}
