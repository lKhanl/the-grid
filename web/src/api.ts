export type Status = 'stopped' | 'starting' | 'building' | 'running' | 'stopping' | 'exited' | 'crashed'

export type ServiceType = 'spring-boot' | 'node' | 'script' | 'jar' | 'custom'

export interface Info {
  name: string
  group: string
  description?: string
  status: Status
  pid?: number
  exitCode?: number
  startedAt?: number
  restarts: number
  type: ServiceType
  /** build step preview (spring-boot / node) */
  build?: string
  /** run command preview */
  command: string
  cwd: string
  url?: string
  dependsOn?: string[]
  ready?: string
  runtimes?: string[]
  /** CPU of the process tree in percent of one core, and resident memory in bytes (while running) */
  cpu?: number
  mem?: number
  /** file the log is also written to */
  logFile?: string
}

export interface RuntimeInfo {
  name: string
  type: string
  home: string
  error?: string
}

export interface State {
  /** e.g. "0.1.0+414c167" */
  version: string
  name: string
  configPath: string
  /** log history kept per service, and the sizes the UI offers */
  logLines: number
  logLineOptions: number[]
  runtimes: RuntimeInfo[]
  services: Info[]
  /** optional modules compiled into this build, e.g. "db" (go build -tags db) */
  features: string[]
  /** folder of this workspace's log files, and the disk space per service (bytes) */
  logDir?: string
  logFileMax: number
  /** logs are also written to files (Settings → Logs, on by default) */
  logFiles: boolean
}

export interface Entry {
  seq: number
  t: number
  s: 'out' | 'err' | 'sys'
  line: string
}

export interface RunnerEvent {
  type: 'log' | 'service' | 'snapshot' | 'terms'
  /** terminal list (snapshot and 'terms' events) */
  terms?: TermInfo[]
  service?: string
  entry?: Entry
  info?: Info
  state?: State
  /** log history per service; only in the first snapshot of a connection */
  logs?: Record<string, Entry[]>
}

export type Action = 'start' | 'stop' | 'restart' | 'clear' | 'start-nobuild'

export const HEADERS = { 'X-Grid': 'ui' }

export async function check(r: Response) {
  if (!r.ok) {
    let msg = r.statusText
    try {
      msg = (await r.json()).error ?? msg
    } catch {
      /* not json */
    }
    throw new Error(msg)
  }
  return r
}

export async function act(target: string, action: Action) {
  await check(await fetch(`/api/do/${encodeURIComponent(target)}/${action}`, { method: 'POST', headers: HEADERS }))
}

export async function reload() {
  await check(await fetch('/api/reload', { method: 'POST', headers: HEADERS }))
}

/** Saves the given settings (the others stay as they are). */
export async function saveSettings(s: { logLines?: number; logFiles?: boolean }): Promise<State> {
  const r = await check(
    await fetch('/api/settings', { method: 'PUT', headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(s) }),
  )
  return r.json()
}

export const setLogLines = (n: number) => saveSettings({ logLines: n })

export async function fetchLogs(service: string, tail = 5000): Promise<Entry[]> {
  const r = await check(await fetch(`/api/services/${encodeURIComponent(service)}/logs?format=json&tail=${tail}`))
  return r.json()
}

const DEFAULT_MAX_LINES = 1000

type Listener = (service: string, entries: Entry[], reset: boolean) => void

/** Keeps the log lines of every service in memory, outside React state. */
export class LogStore {
  private buffers = new Map<string, Entry[]>()
  private max = DEFAULT_MAX_LINES
  private listeners = new Set<Listener>()

  /** Lines kept per service; a lower limit drops the oldest ones now. */
  setMax(n: number) {
    if (n === this.max) return
    this.max = n
    this.buffers.forEach((buf, k) => {
      if (buf.length > n) this.buffers.set(k, buf.slice(-n))
    })
  }

  get(service: string): Entry[] {
    return this.buffers.get(service) ?? []
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit(service: string, entries: Entry[], reset: boolean) {
    this.listeners.forEach((fn) => fn(service, entries, reset))
  }

  append(service: string, e: Entry) {
    let buf = this.buffers.get(service)
    if (!buf) this.buffers.set(service, (buf = []))
    if (buf.length && buf[buf.length - 1].seq >= e.seq) return
    buf.push(e)
    if (buf.length > this.max * 1.25) buf.splice(0, buf.length - this.max)
    this.emit(service, [e], false)
  }

  /** Set the whole buffer (log history from a fresh connection). */
  set(service: string, entries: Entry[]) {
    this.buffers.set(service, entries.slice(-this.max))
    this.emit(service, this.get(service), true)
  }

  /** Replace with a backlog, keeping live lines that arrived after it. */
  replace(service: string, backlog: Entry[]) {
    const last = backlog.length ? backlog[backlog.length - 1].seq : 0
    const live = this.get(service).filter((e) => e.seq > last)
    this.buffers.set(service, backlog.concat(live))
    this.emit(service, this.get(service), true)
  }

  clear(service: string) {
    this.buffers.set(service, [])
    this.emit(service, [], true)
  }
}

// ---- editing grid.yaml ----

export interface EnvVar {
  key: string
  value: string
}

export interface SpringSpec {
  module: string
  profiles: string[] | null
  jvmArgs: string
  args: string
  mode: string // package | run
  skipTests: boolean
  offline: boolean
  alwaysBuild: boolean
}

export interface NodeSpec {
  script: string
  args: string
  install: string // if-changed | always | never
  packageManager: string // auto | npm | yarn | pnpm
}

export interface ScriptSpec {
  file: string
  args: string
}

export interface JarSpec {
  file: string
  jvmArgs: string
  args: string
}

export const emptySpring = (): SpringSpec => ({ module: '', profiles: [], jvmArgs: '', args: '', mode: 'package', skipTests: true, offline: false, alwaysBuild: false })
export const emptyNode = (): NodeSpec => ({ script: '', args: '', install: 'if-changed', packageManager: 'auto' })
export const emptyScript = (): ScriptSpec => ({ file: '', args: '' })
export const emptyJar = (): JarSpec => ({ file: '', jvmArgs: '', args: '' })

export interface ServiceSpec {
  name: string
  group: string
  description: string
  type: ServiceType
  command: string
  spring?: SpringSpec | null
  node?: NodeSpec | null
  script?: ScriptSpec | null
  jar?: JarSpec | null
  cwd: string
  shell: string
  runtime: string[] | null
  env: EnvVar[] | null
  envFile: string
  encoding: string
  dependsOn: string[] | null
  readyPort: number
  readyLog: string
  readyTimeout: string
  restart: string
  maxRestarts: number
  autostart: boolean
  stopTimeout: string
  url: string
  noChanges: boolean // keep the project out of the Changes view
  changesIgnore?: string[] | null // paths (gitignore-like, relative to cwd) hidden from Changes
}

export const emptySpec = (): ServiceSpec => ({
  name: '',
  group: '',
  description: '',
  type: 'custom',
  command: '',
  cwd: '',
  shell: '',
  runtime: [],
  env: [],
  envFile: '',
  encoding: '',
  dependsOn: [],
  readyPort: 0,
  readyLog: '',
  readyTimeout: '',
  restart: '',
  maxRestarts: 0,
  autostart: false,
  stopTimeout: '',
  url: '',
  noChanges: false,
})

const JSON_HEADERS = { ...HEADERS, 'Content-Type': 'application/json' }

export async function getSpec(name: string): Promise<ServiceSpec> {
  const r = await check(await fetch(`/api/config/services/${encodeURIComponent(name)}`))
  return r.json()
}

/** Create when originalName is null, otherwise update (and maybe rename). */
export async function saveSpec(spec: ServiceSpec, originalName: string | null) {
  const url = originalName ? `/api/config/services/${encodeURIComponent(originalName)}` : '/api/config/services'
  await check(await fetch(url, { method: originalName ? 'PUT' : 'POST', headers: JSON_HEADERS, body: JSON.stringify(spec) }))
}

export async function deleteService(name: string) {
  await check(await fetch(`/api/config/services/${encodeURIComponent(name)}`, { method: 'DELETE', headers: HEADERS }))
}

export async function checkPath(path: string): Promise<{ path: string; exists: boolean; dir: boolean }> {
  const r = await check(await fetch(`/api/fs/check?path=${encodeURIComponent(path)}`))
  return r.json()
}

// ---- runtimes ----

export type RuntimeType = 'java' | 'node' | 'script'

export interface RuntimeSpec {
  name: string
  type: RuntimeType
  home: string
  bin: string
  env: EnvVar[] | null
}

export interface ProbeResult {
  home: string
  binDir: string
  exe?: string
  exists: boolean
  error?: string
  version?: string
  tools?: string[]
}

export async function getRuntime(name: string): Promise<RuntimeSpec> {
  const r = await check(await fetch(`/api/config/runtimes/${encodeURIComponent(name)}`))
  return r.json()
}

export async function saveRuntime(spec: RuntimeSpec, originalName: string | null) {
  const url = originalName ? `/api/config/runtimes/${encodeURIComponent(originalName)}` : '/api/config/runtimes'
  await check(await fetch(url, { method: originalName ? 'PUT' : 'POST', headers: JSON_HEADERS, body: JSON.stringify(spec) }))
}

/** detach: also remove it from the services that use it */
export async function deleteRuntime(name: string, detach = false) {
  const q = detach ? '?detach=1' : ''
  await check(await fetch(`/api/config/runtimes/${encodeURIComponent(name)}${q}`, { method: 'DELETE', headers: HEADERS }))
}

export async function probeRuntime(type: string, home: string, bin: string): Promise<ProbeResult> {
  const q = new URLSearchParams({ type, home, bin })
  const r = await check(await fetch(`/api/runtimes/probe?${q}`))
  return r.json()
}

// ---- project detection ----

export interface DetectModule {
  path: string
  artifactId: string
  mainClass?: string
  port?: number
  profiles?: string[]
}

export interface DetectResult {
  dir: string
  exists: boolean
  suggested: ServiceType
  spring?: { artifactId: string; javaVersion?: string; wrapper: boolean; modules: DetectModule[] }
  node?: {
    name: string
    scripts: string[]
    commands: Record<string, string>
    packageManager: string
    nodeVersion?: string
    ports?: Record<string, number>
    installed: boolean
  }
  scripts?: string[]
  jars?: string[]
}

export interface DirListing {
  path: string
  parent?: string
  dirs: { name: string; kind?: 'maven' | 'node' }[]
  /** *.yml / *.yaml files in this folder */
  files?: string[]
  roots?: string[]
  error?: string
}

export async function detect(dir: string): Promise<DetectResult> {
  const r = await check(await fetch(`/api/detect?dir=${encodeURIComponent(dir)}`))
  return r.json()
}

export async function listDir(path: string): Promise<DirListing> {
  const r = await check(await fetch(`/api/fs/list?path=${encodeURIComponent(path)}`))
  return r.json()
}

export async function previewSpec(spec: ServiceSpec): Promise<{ build: string; run: string; error?: string }> {
  const r = await check(await fetch('/api/preview', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(spec) }))
  return r.json()
}

/** Persist a new service order (every service, once). */
export async function reorderServices(names: string[]) {
  await check(await fetch('/api/config/order', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ services: names }) }))
}

// ---- terminals ----

export interface TermInfo {
  id: string
  title: string
  shell: string
  cwd: string
  service?: string
  runtimes?: string[]
  pid?: number
  started: number
  exited: boolean
  exitCode?: number
}

export interface ShellInfo {
  name: string
  path: string
}

export interface OpenTerm {
  shell?: string
  service?: string
  runtimes?: string[]
  cwd?: string
  cols?: number
  rows?: number
}

export async function listShells(): Promise<ShellInfo[]> {
  return (await check(await fetch('/api/terms/shells'))).json()
}

export async function openTerm(o: OpenTerm): Promise<TermInfo> {
  const r = await fetch('/api/terms', { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(o) })
  return (await check(r)).json()
}

export async function closeTerm(id: string) {
  await check(await fetch(`/api/terms/${encodeURIComponent(id)}`, { method: 'DELETE', headers: HEADERS }))
}

export function termSocketURL(id: string) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terms/${encodeURIComponent(id)}/ws`
}

// ---- git changes (read-only) ----
export interface GitFile {
  path: string // relative to the repository root
  status: 'M' | 'A' | 'D' | 'U'
  staged: boolean
  additions: number
  deletions: number
  binary?: boolean
}

export interface GitProject {
  key: string
  name: string
  services: string[]
  types: string[]
  root: string
  prefix: string // project folder inside the repository ("" = the root)
  branch: string
  files: GitFile[]
  ignored: (GitFile & { pattern: string })[] // changed, but hidden by a changes_ignore pattern
  more?: number // untracked files left out of files (the server lists 2000 per project)
  ignoredMore?: number // the same for ignored
}

export interface GitDiff {
  diff: string
  binary?: boolean
  truncated?: boolean
}

export async function gitChanges(): Promise<{ projects: GitProject[]; error?: string }> {
  return (await check(await fetch('/api/git/changes'))).json()
}

/** Hide a path from Changes (add) or show it again (remove) via the service's changes_ignore. */
export async function changesIgnore(service: string, pattern: string, add: boolean) {
  await check(
    await fetch(`/api/config/services/${encodeURIComponent(service)}/changes-ignore`, {
      method: add ? 'POST' : 'DELETE',
      headers: JSON_HEADERS,
      body: JSON.stringify({ pattern }),
    }),
  )
}

export async function gitDiff(repo: string, path: string, signal?: AbortSignal): Promise<GitDiff> {
  return (await check(await fetch(`/api/git/diff?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`, { signal }))).json()
}

// ---- workspaces ----

export interface Workspace {
  path: string
  name?: string
  lastOpened: number
}

export async function listWorkspaces(): Promise<{ current: string; workspaces: Workspace[] }> {
  return (await check(await fetch('/api/workspaces'))).json()
}

/** Switch to a grid.yaml (or a folder containing one). Stops the current workspace's services. */
export async function openWorkspace(path: string): Promise<State> {
  const r = await fetch('/api/workspaces/open', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ path }) })
  return (await check(r)).json()
}

export async function forgetWorkspace(path: string) {
  await check(await fetch(`/api/workspaces?path=${encodeURIComponent(path)}`, { method: 'DELETE', headers: HEADERS }))
}
