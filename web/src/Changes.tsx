import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isYaml, langOf, tokenize, tokenizeMarkup, tokenizeYaml, type Tok } from './highlight'
import { changesIgnore, gitChanges, gitDiff, type GitDiff, type GitFile, type GitProject } from './api'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { ChevronIcon, FolderIcon, RefreshIcon } from './icons'

// ---- state shared by the sidebar tree and the diff pane ----

export interface Sel {
  root: string
  path: string
}

export interface GitState {
  projects: GitProject[]
  sel: Sel | null
  setSel: (s: Sel | null) => void
  error: string | null
  loading: boolean
  refresh: () => void
  total: number
}

const same = (a: Sel | null, b: Sel | null) => a?.root === b?.root && a?.path === b?.path

/** Polls while `active` (the Changes panel is open) and when the tab regains focus. */
export function useGit(active: boolean): GitState {
  const [projects, setProjects] = useState<GitProject[]>([])
  const [sel, setSel] = useState<Sel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const busy = useRef(false)
  const again = useRef(false)
  // `quiet` = the automatic poll: no spinner, and never a second request while one is still running.
  // An asked-for refresh (the button, after hiding a file) that arrives meanwhile is not dropped:
  // the answer on its way may be older than the change, so one more request follows it.
  const load = useCallback((quiet: boolean): Promise<void> => {
    if (busy.current) {
      if (!quiet) {
        again.current = true
        setLoading(true)
      }
      return Promise.resolve()
    }
    busy.current = true
    if (!quiet) setLoading(true)
    const run = (): Promise<void> =>
      gitChanges()
        .then(({ projects, error }) => {
          setProjects(projects)
          setError(projects.length ? null : error || null)
          setSel((cur) => {
            const all = projects.flatMap((p) => p.files.map((f) => ({ root: p.root, path: f.path })))
            if (cur && all.some((x) => same(x, cur))) return cur
            return all[0] ?? null
          })
        })
        .catch((e: Error) => setError(e.message))
        .then(() => {
          if (again.current) {
            again.current = false
            return run()
          }
          busy.current = false
          setLoading(false)
        })
    return run()
  }, [])
  const refresh = useCallback(() => void load(false), [load])

  useEffect(() => {
    void load(true)
    if (!active) return
    // poll every 5 s, but wait at least twice as long as the last refresh took (a slow machine or
    // many repositories must not be kept busy by git status all the time)
    let timer = 0
    let stopped = false
    const loop = () => {
      const t0 = Date.now()
      void load(true).then(() => {
        if (!stopped) timer = window.setTimeout(loop, Math.max(5000, 2 * (Date.now() - t0)))
      })
    }
    timer = window.setTimeout(loop, 5000)
    const onFocus = () => document.visibilityState === 'visible' && void load(true)
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
    }
  }, [active, load])

  const total = projects.reduce((n, p) => n + p.files.length, 0)
  return { projects, sel, setSel, error, loading, refresh, total }
}

// ---- sidebar: projects (services) > folders > files ----

function split(path: string): [string, string] {
  const i = path.lastIndexOf('/')
  return i < 0 ? ['', path] : [path.slice(0, i + 1), path.slice(i + 1)]
}

const STATUS_TITLE = { M: 'Modified', A: 'Added', D: 'Deleted', U: 'Untracked' } as const

interface DirNode {
  name: string // "a/b" when single-child folders are compacted
  path: string // full folder path, the collapse key
  dirs: DirNode[]
  files: GitFile[]
}

function buildTree(files: GitFile[], prefix: string): DirNode {
  const root: DirNode = { name: '', path: '', dirs: [], files: [] }
  for (const f of files) {
    const rel = prefix ? f.path.slice(prefix.length + 1) : f.path
    const parts = rel.split('/')
    let node = root
    for (const seg of parts.slice(0, -1)) {
      const path = node.path ? node.path + '/' + seg : seg
      let next = node.dirs.find((d) => d.path === path)
      if (!next) node.dirs.push((next = { name: seg, path, dirs: [], files: [] }))
      node = next
    }
    node.files.push(f)
  }
  // IntelliJ style: a folder with a single sub-folder and no files is shown as "a/b/c"
  const compact = (n: DirNode): DirNode => {
    n.dirs = n.dirs.map(compact)
    n.dirs.sort((a, b) => a.name.localeCompare(b.name))
    n.files.sort((a, b) => a.path.localeCompare(b.path))
    while (n.path !== '' && n.files.length === 0 && n.dirs.length === 1) {
      const only = n.dirs[0]
      n = { ...only, name: n.name + '/' + only.name }
    }
    return n
  }
  root.dirs = root.dirs.map(compact)
  root.dirs.sort((a, b) => a.name.localeCompare(b.name))
  root.files.sort((a, b) => a.path.localeCompare(b.path))
  return root
}

function countFiles(n: DirNode): number {
  return n.files.length + n.dirs.reduce((s, d) => s + countFiles(d), 0)
}

function useCollapsed() {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('grid.git.collapsed') ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const toggle = (k: string) =>
    setSet((cur) => {
      const n = new Set(cur)
      if (!n.delete(k)) n.add(k)
      localStorage.setItem('grid.git.collapsed', JSON.stringify([...n]))
      return n
    })
  return [set, toggle] as const
}

type Menu = { x: number; y: number; title: string; items: MenuEntry[] }

export function ChangesList({ git, typeIcon }: { git: GitState; typeIcon: (type: string) => ReactNode }) {
  const [collapsed, toggle] = useCollapsed()
  // files hidden by changes_ignore: counted in the header, shown dimmed on demand
  const [showIgnored, setShowIgnored] = useState(() => localStorage.getItem('grid.git.showIgnored') === '1')
  const [menu, setMenu] = useState<Menu | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)
  const hiddenCount = git.projects.reduce((n, p) => n + (p.ignored?.length ?? 0) + (p.ignoredMore ?? 0), 0)
  const flipIgnored = () =>
    setShowIgnored((v) => {
      localStorage.setItem('grid.git.showIgnored', v ? '0' : '1')
      return !v
    })

  // patterns live in grid.yaml under the project's services (the first one gets new ones)
  const hide = (p: GitProject, pattern: string) =>
    changesIgnore(p.services[0], pattern, true).then(
      () => {
        setActionErr(null)
        git.refresh()
      },
      (e: Error) => setActionErr(e.message),
    )
  const unhide = async (p: GitProject, pattern: string) => {
    let last: Error | null = null
    for (const s of p.services) {
      try {
        await changesIgnore(s, pattern, false)
        setActionErr(null)
        git.refresh()
        return
      } catch (e) {
        last = e as Error
      }
    }
    setActionErr(last?.message ?? 'pattern not found')
  }
  const fileMenu = (e: React.MouseEvent, p: GitProject, f: GitFile, rel: string, pattern?: string) => {
    e.preventDefault()
    if (!p.services.length) return // "(other files)": no service to keep the pattern
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot) : ''
    const items: MenuEntry[] = pattern
      ? [{ label: 'Show in Changes again', hint: pattern, onSelect: () => void unhide(p, pattern) }]
      : [
          { label: 'Hide from Changes', hint: rel, onSelect: () => void hide(p, rel) },
          ...(ext ? [{ label: `Hide all ${ext} files`, hint: `*${ext}`, onSelect: () => void hide(p, `*${ext}`) }] : []),
        ]
    setMenu({ x: e.clientX, y: e.clientY, title: f.path, items })
  }
  const dirMenu = (e: React.MouseEvent, p: GitProject, rel: string) => {
    e.preventDefault()
    if (!p.services.length) return
    setMenu({ x: e.clientX, y: e.clientY, title: rel + '/', items: [{ label: 'Hide folder from Changes', hint: rel + '/', onSelect: () => void hide(p, rel + '/') }] })
  }

  return (
    <>
      <div className="sidebar-head divided">
        <span>Changes{git.total ? ` · ${git.total}` : ''}</span>
        <span className="head-actions">
          {hiddenCount > 0 && (
            <button
              className={`btn text small git-hidden-btn ${showIgnored ? 'on' : ''}`}
              title={showIgnored ? 'Hide them again' : 'Files left out by "Hide from Changes" patterns: show them dimmed'}
              onClick={flipIgnored}
            >
              {hiddenCount} hidden
            </button>
          )}
          <button className={`icon-btn ${git.loading ? 'spin' : ''}`} title="Refresh" onClick={git.refresh}>
            <RefreshIcon size={14} />
          </button>
        </span>
      </div>
      {actionErr && <div className="db-msg field-error">{actionErr}</div>}
      {git.error && <div className="empty">{git.error}</div>}
      {!git.error && git.total === 0 && <div className="empty">No local changes in any service.</div>}
      {menu && <ContextMenu x={menu.x} y={menu.y} title={menu.title} items={menu.items} onClose={() => setMenu(null)} />}
      {git.projects.map((p) => {
        const ignored = p.ignored ?? []
        if (!p.files.length && !(showIgnored && ignored.length)) return null
        const patternOf = new Map(ignored.map((f) => [f.path, f.pattern]))
        const add = p.files.reduce((n, f) => n + f.additions, 0)
        const del = p.files.reduce((n, f) => n + f.deletions, 0)
        const closed = collapsed.has(p.key)
        const tree = buildTree(showIgnored ? [...p.files, ...ignored] : p.files, p.prefix)
        const renderDir = (d: DirNode, depth: number): ReactNode => {
          const key = p.key + '/' + d.path
          const shut = collapsed.has(key)
          return (
            <div key={key}>
              <div className="git-row git-dir" style={{ paddingLeft: 14 + depth * 14 }} onClick={() => toggle(key)} onContextMenu={(e) => dirMenu(e, p, d.path)}>
                <span className={`group-chevron ${shut ? '' : 'open'}`}><ChevronIcon size={12} /></span>
                <FolderIcon size={14} />
                <span className="git-name">
                  <span className="fname">{d.name}</span>
                </span>
                <span className="git-count">{countFiles(d)}</span>
              </div>
              {!shut && renderBody(d, depth + 1)}
            </div>
          )
        }
        const renderBody = (n: DirNode, depth: number): ReactNode => (
          <>
            {n.dirs.map((d) => renderDir(d, depth))}
            {n.files.map((f) => {
              const [, name] = split(f.path)
              const on = git.sel?.root === p.root && git.sel.path === f.path
              const pattern = patternOf.get(f.path)
              const rel = p.prefix ? f.path.slice(p.prefix.length + 1) : f.path
              return (
                <div
                  key={f.path}
                  className={`git-row git-file ${on ? 'on' : ''} ${pattern ? 'git-ignored' : ''}`}
                  style={{ paddingLeft: 14 + depth * 14 + 16 }}
                  onClick={() => git.setSel({ root: p.root, path: f.path })}
                  onContextMenu={(e) => fileMenu(e, p, f, rel, pattern)}
                  title={`${STATUS_TITLE[f.status]}${f.staged ? ' · staged' : ''}\n${f.path}${pattern ? `\nHidden by "${pattern}" (right-click to show it again)` : p.services.length ? '\nRight-click: hide from Changes' : ''}`}
                >
                  <span className={`git-status st-${f.status}`}>{f.status}</span>
                  <span className="git-name">
                    <span className="fname">{name}</span>
                  </span>
                  {f.binary ? (
                    <span className="git-num muted">bin</span>
                  ) : (
                    <span className="git-num">
                      {f.additions > 0 && <b className="add">+{f.additions}</b>}
                      {f.deletions > 0 && <b className="del">−{f.deletions}</b>}
                    </span>
                  )}
                </div>
              )
            })}
          </>
        )
        const more = p.services.length - 1
        return (
          <div key={p.key} className="git-project">
            <div
              className="git-row git-proj"
              onClick={() => toggle(p.key)}
              title={`${p.services.join(', ') || p.root}\n${p.root}${p.prefix ? '/' + p.prefix : ''}\nbranch ${p.branch}`}
            >
              <span className={`group-chevron ${closed ? '' : 'open'}`}><ChevronIcon size={12} /></span>
              {p.types[0] && <span className="git-type">{typeIcon(p.types[0])}</span>}
              <span className="git-name">
                <span className="fname">{p.name}</span>
                {more > 0 && <span className="fdir">+{more}</span>}
                <span className="fdir">{p.branch}</span>
              </span>
              <span className="git-num">
                <b className="add">+{add}</b>
                <b className="del">−{del}</b>
              </span>
              <span className="git-count">{p.files.length}</span>
            </div>
            {!closed && renderBody(tree, 1)}
            {!closed && !!p.more && (
              <div className="git-more" title="Listing and reading that many files would slow the Grid down. Add the folder to .gitignore, or right-click it and hide it from Changes.">
                {p.more.toLocaleString()} more untracked files are not listed. A folder such as node_modules or target is probably missing from .gitignore.
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

// ---- unified diff parsing ----

interface Line {
  kind: ' ' | '+' | '-'
  text: string
  o?: number // line number in the old file
  n?: number // line number in the new file
  toks?: Tok[] // coloured pieces of text (absent: plain)
}
interface Hunk {
  header: string
  lines: Line[]
}

export function parseDiff(text: string): Hunk[] {
  const hunks: Hunk[] = []
  let cur: Hunk | null = null
  let o = 0
  let n = 0
  for (const raw of text.split('\n')) {
    const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
    if (m) {
      o = Number(m[1])
      n = Number(m[2])
      cur = { header: m[3].trim(), lines: [] }
      hunks.push(cur)
      continue
    }
    if (!cur) continue // file header lines before the first hunk
    const c = raw[0]
    if (c === '+') cur.lines.push({ kind: '+', text: raw.slice(1), n: n++ })
    else if (c === '-') cur.lines.push({ kind: '-', text: raw.slice(1), o: o++ })
    else if (c === ' ') cur.lines.push({ kind: ' ', text: raw.slice(1), o: o++, n: n++ })
    // "\ No newline at end of file" and the trailing empty split are skipped
  }
  return hunks
}

interface Pair {
  l?: Line
  r?: Line
}

/** Side by side rows: a run of removed lines is paired with the added lines that follow it. */
function pairs(lines: Line[]): Pair[] {
  const rows: Pair[] = []
  for (let i = 0; i < lines.length; ) {
    const ln = lines[i]
    if (ln.kind === ' ') {
      rows.push({ l: ln, r: ln })
      i++
      continue
    }
    const dels: Line[] = []
    const adds: Line[] = []
    while (i < lines.length && lines[i].kind === '-') dels.push(lines[i++])
    while (i < lines.length && lines[i].kind === '+') adds.push(lines[i++])
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ l: dels[k], r: adds[k] })
  }
  return rows
}

// ---- syntax colour ----

const MAX_COLOUR_LINES = 4000 // beyond this a diff is shown plain: colouring must never slow the page
const MAX_COLOUR_LEN = 600 // minified / generated lines stay plain

/** Colours every line, following block comments through the old and the new side separately. */
function colorize(hunks: Hunk[], path: string) {
  const lang = langOf(path)
  if (!lang || hunks.reduce((n, h) => n + h.lines.length, 0) > MAX_COLOUR_LINES) return
  const one = (text: string, inBlock: boolean) => {
    if (lang.markup) return tokenizeMarkup(text, lang, inBlock)
    if (isYaml(lang)) return { toks: tokenizeYaml(text, lang), inBlock: false }
    return tokenize(text, lang, inBlock)
  }
  for (const h of hunks) {
    // a hunk that starts in the middle of a /* ... */ comment: " * text" or " */"
    const first = h.lines[0]?.text ?? ''
    let oldIn = /^\s*\*(?!\/)|^\s*\*\//.test(first) && !isYaml(lang)
    let newIn = oldIn
    for (const l of h.lines) {
      if (l.text.length > MAX_COLOUR_LEN) continue
      if (l.kind === '-') {
        const r = one(l.text, oldIn)
        l.toks = r.toks
        oldIn = r.inBlock
      } else if (l.kind === '+') {
        const r = one(l.text, newIn)
        l.toks = r.toks
        newIn = r.inBlock
      } else {
        const r = one(l.text, newIn)
        l.toks = r.toks
        oldIn = newIn = r.inBlock
      }
    }
  }
}

function Code({ l }: { l: Line }) {
  if (!l.toks) return <>{l.text}</>
  return (
    <>
      {l.toks.map((t, i) => (typeof t === 'string' ? t : <span key={i} className={`tk-${t[0]}`}>{t[1]}</span>))}
    </>
  )
}

// ---- diff pane ----

const MAX_SHOWN = 1500

export type DiffMode = 'split' | 'unified'

export function DiffPane({ git }: { git: GitState }) {
  const [mode, setMode] = useState<DiffMode>(() => (localStorage.getItem('grid.git.mode') === 'unified' ? 'unified' : 'split'))
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [shown, setShown] = useState(MAX_SHOWN) // lines drawn: thousands of table rows are slow on a VDI
  const repo = git.sel?.root ?? null
  const file = git.sel?.path ?? null
  const info = git.projects.find((p) => p.root === repo)?.files.find((f) => f.path === file)
  // refetch when the file's numbers change (it was edited again)
  const stamp = info ? `${info.status}:${info.additions}:${info.deletions}:${info.staged}` : ''

  useEffect(() => localStorage.setItem('grid.git.mode', mode), [mode])
  useEffect(() => {
    if (!repo || !file) {
      setDiff(null)
      return
    }
    // the previous file's diff goes away at once: a slow answer must not look like the new file
    setDiff(null)
    setErr(null)
    setLoadingDiff(true)
    setShown(MAX_SHOWN)
    const ctl = new AbortController()
    gitDiff(repo, file, ctl.signal).then(
      (d) => {
        setDiff(d)
        setLoadingDiff(false)
      },
      (e: Error) => {
        if (ctl.signal.aborted) return
        setErr(e.message)
        setLoadingDiff(false)
      },
    )
    return () => ctl.abort() // also stops the git process on the server
  }, [repo, file, stamp])

  const hunks = useMemo(() => {
    const h = diff ? parseDiff(diff.diff) : []
    if (file) colorize(h, file)
    return h
  }, [diff, file])
  const total = hunks.reduce((n, h) => n + h.lines.length, 0)
  const drawn = useMemo(() => {
    if (total <= shown) return hunks
    let left = shown
    const out: Hunk[] = []
    for (const h of hunks) {
      if (left <= 0) break
      out.push(h.lines.length <= left ? h : { ...h, lines: h.lines.slice(0, left) })
      left -= h.lines.length
    }
    return out
  }, [hunks, total, shown])
  const [dir, name] = split(file ?? '')
  return (
    <div className="detail-pane diff-pane">
      <div className="toolbar">
        {file ? (
          <>
            <span className={`git-status st-${info?.status ?? 'M'}`}>{info?.status ?? 'M'}</span>
            <span className="title">{name}</span>
            <span className="muted">{dir}</span>
            {info && !info.binary && (
              <span className="git-num">
                <b className="add">+{info.additions}</b> <b className="del">−{info.deletions}</b>
              </span>
            )}
          </>
        ) : (
          <span className="muted">No file selected</span>
        )}
        <div className="spacer" />
        <div className="seg" role="group" aria-label="Diff view">
          <button className={mode === 'split' ? 'on' : ''} onClick={() => setMode('split')}>
            Side by side
          </button>
          <button className={mode === 'unified' ? 'on' : ''} onClick={() => setMode('unified')}>
            Unified
          </button>
        </div>
      </div>
      <div className="diff-body">
        {err && <div className="diff-note">{err}</div>}
        {!err && file && loadingDiff && <div className="diff-note">Loading…</div>}
        {!err && !file && <div className="diff-note">{git.error ?? 'Pick a changed file on the left.'}</div>}
        {!err && diff?.binary && <div className="diff-note">Binary file, no text diff.</div>}
        {!err && diff && !diff.binary && hunks.length === 0 && <div className="diff-note">{info?.status === 'U' ? 'Empty file.' : 'No textual changes (mode change only?).'}</div>}
        {!err &&
          drawn.map((h, i) => (
            <div key={i} className="hunk">
              <div className="hunk-head">{h.header || `change ${i + 1}`}</div>
              {mode === 'split' ? (
                <table className="diff split">
                  <colgroup>
                    <col className="num" />
                    <col />
                    <col className="num" />
                    <col />
                  </colgroup>
                  <tbody>
                    {pairs(h.lines).map((p, k) => (
                      <tr key={k}>
                        <td className={`num ${p.l?.kind === '-' ? 'del' : ''}`}>{p.l?.o}</td>
                        <td className={`code ${p.l ? (p.l.kind === '-' ? 'del' : '') : 'empty'}`}>{p.l && <Code l={p.l} />}</td>
                        <td className={`num ${p.r?.kind === '+' ? 'add' : ''}`}>{p.r?.n}</td>
                        <td className={`code ${p.r ? (p.r.kind === '+' ? 'add' : '') : 'empty'}`}>{p.r && <Code l={p.r} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="diff unified">
                  <colgroup>
                    <col className="num" />
                    <col className="num" />
                    <col />
                  </colgroup>
                  <tbody>
                    {h.lines.map((l, k) => (
                      <tr key={k} className={l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : ''}>
                        <td className="num">{l.o}</td>
                        <td className="num">{l.n}</td>
                        <td className="code">
                          <span className="sign">{l.kind === ' ' ? '' : l.kind}</span>
                          <Code l={l} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        {total > shown && (
          <div className="diff-note">
            Showing the first {shown.toLocaleString('en-US')} of {total.toLocaleString('en-US')} lines.{' '}
            <button className="btn text small" onClick={() => setShown(shown + 3000)}>
              Show {Math.min(3000, total - shown).toLocaleString('en-US')} more
            </button>{' '}
            <button className="btn text small" onClick={() => setShown(total)}>
              Show all
            </button>
          </div>
        )}
        {diff?.truncated && <div className="diff-note">Diff truncated (too large).</div>}
        {hunks.length > 0 && (
          <div className={`diff-fill ${mode}`} aria-hidden>
            {mode === 'split' ? (
              <>
                <i className="num" />
                <i />
                <i className="num" />
                <i />
              </>
            ) : (
              <>
                <i className="num" />
                <i className="num" />
                <i />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
