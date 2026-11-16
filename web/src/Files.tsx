import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fileList, fileRead, fileRoots, fileTree, type FileContent, type FileEntry, type FileRoot } from './api'
import { isYaml, langOf, tokenize, tokenizeMarkup, tokenizeYaml, type Tok } from './highlight'
import { Markdown } from './Markdown'
import { useZoom } from './zoom'
import { ChevronIcon, FileIcon, FolderIcon, RefreshIcon, SearchIcon } from './icons'

// Read-only file browser: a lazy folder tree (and a filename filter) in the sidebar, a numbered, coloured viewer in the detail area.

export interface FileSel {
  root: string
  path: string // relative to root, slash separated
}

type Dir = { entries: FileEntry[]; truncated: boolean }
const dkey = (root: string, dir: string) => root + '\0' + dir
const MAX_HITS = 200

export interface FilesState {
  roots: FileRoot[]
  sel: FileSel | null
  setSel: (s: FileSel | null) => void
  open: Set<string>
  toggle: (root: string, dir: string) => void
  dirs: Map<string, Dir>
  showIgnored: boolean
  setShowIgnored: (v: boolean) => void
  query: string
  setQuery: (q: string) => void
  hits: { root: string; path: string }[] | null // filter results (null = no filter)
  hitsBusy: boolean
  error: string | null
  loading: boolean
  refresh: () => void
  stamp: number // changes after every reload of the folders
}

/** Loads while `active` (the Files panel is open). Folders are read when first opened; Refresh re-reads the open ones. */
export function useFiles(active: boolean): FilesState {
  const [roots, setRoots] = useState<FileRoot[]>([])
  const [sel, setSel] = useState<FileSel | null>(null)
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('grid.files.open') ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const [dirs, setDirs] = useState<Map<string, Dir>>(new Map())
  const [showIgnored, setShowIgnoredState] = useState(() => localStorage.getItem('grid.files.ignored') === '1')
  const [query, setQuery] = useState('')
  const [lists, setLists] = useState<Map<string, string[]>>(new Map())
  const [hitsBusy, setHitsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const openRef = useRef(open) // reload() runs from an effect: it must see the folders open now, not the ones of the first render
  openRef.current = open
  const gen = useRef(0) // bumped by Refresh / the ignored switch: answers of the older generation are dropped
  const asked = useRef(new Set<string>())
  const [listGen, setListGen] = useState(0) // bumped when the filter list must be asked again
  const listFresh = useRef(false) // the next list request skips the server's cache (Refresh)
  const [stamp, setStamp] = useState(0) // bumped after every (re)load: the viewer re-checks its file

  // Listings are cached by the server (checked with a few stat calls, see files.cjs), so asking again is cheap. That is how changes are
  // noticed without watchers: the open folders are asked again when the panel opens, when the window gets focus again and on Refresh.
  const loadDir = useCallback((root: string, dir: string, ignored: boolean, fresh = false) => {
    const g = gen.current
    return fileTree(root, dir, ignored, fresh).then(
      (d) => {
        if (g !== gen.current) return
        setDirs((m) => {
          const old = m.get(dkey(root, dir))
          if (old && JSON.stringify(old) === JSON.stringify(d)) return m // unchanged: no re-render
          return new Map(m).set(dkey(root, dir), d)
        })
      },
      (e: Error) => {
        if (g === gen.current) setError(e.message)
      },
    )
  }, [])

  // hard: forget what is shown first (the ignored switch, Refresh); soft: ask again and replace only what changed
  const load = useCallback(
    (ignored: boolean, mode: 'soft' | 'hard' | 'fresh') => {
      if (mode !== 'soft') {
        gen.current++
        asked.current = new Set()
        setDirs(new Map())
        setListGen((n) => n + 1)
        setLoading(true)
        setError(null)
      }
      const fresh = mode === 'fresh'
      return fileRoots()
        .then(async (rs) => {
          setRoots((cur) => (JSON.stringify(cur) === JSON.stringify(rs) ? cur : rs))
          setSel((cur) => (cur && rs.some((r) => r.root === cur.root) ? cur : null))
          const want = [...openRef.current].map((k) => k.split('\0') as [string, string]).filter(([r]) => rs.some((x) => x.root === r))
          await Promise.all(want.map(([r, d]) => { asked.current.add(dkey(r, d)); return loadDir(r, d, ignored, fresh) }))
        })
        .catch((e: Error) => setError(e.message))
        .then(() => {
          setLoading(false)
          setStamp((n) => n + 1) // the viewer looks at its file again
        })
    },
    [loadDir],
  )

  const firstShow = useRef(true)
  useEffect(() => {
    if (!active) return
    void load(showIgnored, firstShow.current ? 'hard' : 'soft')
    firstShow.current = false
    const onFocus = () => document.visibilityState === 'visible' && void load(showIgnored, 'soft')
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [active, load, showIgnored])

  const toggle = useCallback(
    (root: string, dir: string) => {
      const k = dkey(root, dir)
      setOpen((cur) => {
        const n = new Set(cur)
        if (!n.delete(k)) n.add(k)
        localStorage.setItem('grid.files.open', JSON.stringify([...n]))
        return n
      })
      if (!asked.current.has(k)) {
        asked.current.add(k)
        void loadDir(root, dir, showIgnored)
      }
    },
    [loadDir, showIgnored],
  )

  const setShowIgnored = (v: boolean) => {
    localStorage.setItem('grid.files.ignored', v ? '1' : '0')
    setShowIgnoredState(v)
  }

  // the filter needs every path of every folder: asked when something is typed (and again after Refresh); the server keeps the list
  const q = query.trim().toLowerCase()
  const searching = q !== ''
  useEffect(() => {
    if (!active || !searching) return
    const g = gen.current, fresh = listGen > 0 && listFresh.current
    listFresh.current = false
    setHitsBusy(true)
    Promise.all(roots.map((r) => fileList(r.root, fresh).then((l) => [r.root, l.files] as const, () => [r.root, [] as string[]] as const))).then((got) => {
      if (g !== gen.current) return
      setLists(new Map(got))
      setHitsBusy(false)
    })
  }, [active, searching, roots, listGen])

  const hits = useMemo(() => {
    if (!q) return null
    const words = q.split(/\s+/)
    const out: { root: string; path: string; rank: number }[] = []
    for (const [root, files] of lists) {
      for (const p of files) {
        const low = p.toLowerCase()
        if (!words.every((w) => low.includes(w))) continue
        const base = low.slice(low.lastIndexOf('/') + 1)
        out.push({ root, path: p, rank: (words.every((w) => base.includes(w)) ? 0 : 1000) + p.length })
      }
    }
    out.sort((a, b) => a.rank - b.rank)
    return out.slice(0, MAX_HITS)
  }, [q, lists])

  return { roots, sel, setSel, open, toggle, dirs, showIgnored, setShowIgnored, query, setQuery, hits, hitsBusy, error, loading, refresh: () => { listFresh.current = true; void load(showIgnored, 'fresh') }, stamp }
}

// ---- sidebar ----

export function FilesList({ files, typeIcon }: { files: FilesState; typeIcon: (type: string) => ReactNode }) {
  const { roots, sel, open, dirs } = files
  const row = (root: string, dir: string, e: FileEntry, depth: number): ReactNode => {
    const path = dir ? dir + '/' + e.name : e.name
    if (e.dir) {
      const shut = !open.has(dkey(root, path))
      const kids = dirs.get(dkey(root, path))
      return (
        <div key={path}>
          <div className={`git-row git-dir ${e.ignored ? 'git-ignored' : ''}`} style={{ paddingLeft: 14 + depth * 14 }} onClick={() => files.toggle(root, path)}>
            <span className={`group-chevron ${shut ? '' : 'open'}`}><ChevronIcon size={12} /></span>
            <FolderIcon size={14} />
            <span className="git-name"><span className="fname">{e.name}</span></span>
          </div>
          {!shut && !kids && <div className="git-more" style={{ paddingLeft: 30 + depth * 14 }}>Loading…</div>}
          {!shut && kids && renderDir(root, path, kids, depth + 1)}
        </div>
      )
    }
    const on = sel?.root === root && sel.path === path
    return (
      <div
        key={path}
        className={`git-row git-file ${on ? 'on' : ''} ${e.ignored ? 'git-ignored' : ''}`}
        style={{ paddingLeft: 14 + depth * 14 + 16 }}
        onClick={() => files.setSel({ root, path })}
        title={path}
      >
        <FileIcon size={14} />
        <span className="git-name"><span className="fname">{e.name}</span></span>
      </div>
    )
  }
  const renderDir = (root: string, dir: string, d: Dir, depth: number): ReactNode => (
    <>
      {d.entries.map((e) => row(root, dir, e, depth))}
      {d.entries.length === 0 && <div className="git-more" style={{ paddingLeft: 30 + depth * 14 }}>Empty folder</div>}
      {d.truncated && <div className="git-more" style={{ paddingLeft: 30 + depth * 14 }}>Only the first entries of this folder are listed.</div>}
    </>
  )

  const rootName = (r: string) => roots.find((x) => x.root === r)?.name ?? r
  return (
    <>
      <div className="sidebar-head divided">
        <span>Files</span>
        <span className="head-actions">
          <button
            className={`btn text small git-hidden-btn ${files.showIgnored ? 'on' : ''}`}
            title={files.showIgnored ? 'Hide git-ignored files again' : 'Also show git-ignored files and folders (node_modules, target…), dimmed'}
            onClick={() => files.setShowIgnored(!files.showIgnored)}
          >
            ignored
          </button>
          <button className={`icon-btn ${files.loading ? 'spin' : ''}`} title="Refresh" onClick={files.refresh}>
            <RefreshIcon size={14} />
          </button>
        </span>
      </div>
      <label className="filter-wrap files-filter">
        <SearchIcon size={14} />
        <input className="filter" placeholder="Find a file by name…" value={files.query} onChange={(e) => files.setQuery(e.target.value)} spellCheck={false} />
      </label>
      {files.error && <div className="empty">{files.error}</div>}
      {!files.error && roots.length === 0 && !files.loading && <div className="empty">No service folders yet.</div>}
      {files.hits ? (
        <>
          {files.hits.map((h) => {
            const i = h.path.lastIndexOf('/')
            const on = sel?.root === h.root && sel.path === h.path
            return (
              <div key={h.root + '\0' + h.path} className={`git-row git-file ${on ? 'on' : ''}`} style={{ paddingLeft: 14 }} onClick={() => files.setSel({ root: h.root, path: h.path })} title={h.path}>
                <FileIcon size={14} />
                <span className="git-name">
                  <span className="fname">{h.path.slice(i + 1)}</span>
                  <span className="fdir">{roots.length > 1 ? rootName(h.root) + '/' : ''}{i >= 0 ? h.path.slice(0, i) : ''}</span>
                </span>
              </div>
            )
          })}
          {files.hits.length === 0 && <div className="empty">{files.hitsBusy ? 'Searching…' : 'No file matches.'}</div>}
          {files.hits.length >= MAX_HITS && <div className="git-more">Showing the first {MAX_HITS}; type more to narrow it down.</div>}
        </>
      ) : (
        roots.map((r) => {
          const shut = !open.has(dkey(r.root, ''))
          const top = dirs.get(dkey(r.root, ''))
          return (
            <div key={r.root} className="git-project">
              <div className="git-row git-proj" onClick={() => files.toggle(r.root, '')} title={`${r.services.join(', ')}\n${r.root}`}>
                <span className={`group-chevron ${shut ? '' : 'open'}`}><ChevronIcon size={12} /></span>
                {r.types[0] && <span className="git-type">{typeIcon(r.types[0])}</span>}
                <span className="git-name">
                  <span className="fname">{r.name}</span>
                  {r.services.length > 1 && <span className="fdir">{r.services.length} services</span>}
                </span>
              </div>
              {!shut && !top && <div className="git-more">Loading…</div>}
              {!shut && top && renderDir(r.root, '', top, 1)}
            </div>
          )
        })
      )}
    </>
  )
}

// ---- viewer ----

const MAX_COLOUR_LINES = 4000 // beyond this a file is shown plain: colouring must never slow the page
const MAX_COLOUR_LEN = 600 // minified / generated lines stay plain
const MAX_SHOWN = 1500

function colourLines(text: string, path: string): { lines: string[]; toks: (Tok[] | null)[] } {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop() // the newline that ends the file
  const lang = langOf(path)
  if (!lang || lines.length > MAX_COLOUR_LINES) return { lines, toks: [] }
  let inBlock = false
  const toks = lines.map((l) => {
    if (l.length > MAX_COLOUR_LEN) return null
    if (lang.markup) {
      const r = tokenizeMarkup(l, lang, inBlock)
      inBlock = r.inBlock
      return r.toks
    }
    if (isYaml(lang)) return tokenizeYaml(l, lang)
    const r = tokenize(l, lang, inBlock)
    inBlock = r.inBlock
    return r.toks
  })
  return { lines, toks }
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`)

export function FileViewer({ files }: { files: FilesState }) {
  const sel = files.sel
  const [data, setData] = useState<FileContent | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [shown, setShown] = useState(MAX_SHOWN)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [mdMode, setMdMode] = useState<'preview' | 'source'>(() => (localStorage.getItem('grid.files.md') === 'source' ? 'source' : 'preview'))
  useEffect(() => localStorage.setItem('grid.files.md', mdMode), [mdMode])

  const zoom = useZoom(bodyRef)

  useEffect(() => {
    setData(null)
    setErr(null)
    setShown(MAX_SHOWN)
    bodyRef.current?.scrollTo(0, 0)
    if (!sel) return
    setLoading(true)
    const ctl = new AbortController()
    fileRead(sel.root, sel.path, ctl.signal).then(
      (d) => {
        setData(d)
        setLoading(false)
      },
      (e: Error) => {
        if (ctl.signal.aborted) return
        setErr(e.message)
        setLoading(false)
      },
    )
    return () => ctl.abort()
  }, [sel?.root, sel?.path]) // eslint-disable-line react-hooks/exhaustive-deps

  // the folders were reloaded (panel shown, window focused, Refresh): if the open file changed on disk, show the new text in place
  useEffect(() => {
    if (!sel || !files.stamp) return
    const ctl = new AbortController()
    fileRead(sel.root, sel.path, ctl.signal).then(
      (d) => setData((cur) => (cur && cur.mtime === d.mtime && cur.size === d.size ? cur : d)),
      () => {},
    )
    return () => ctl.abort()
  }, [files.stamp]) // eslint-disable-line react-hooks/exhaustive-deps

  const colored = useMemo(() => (data && !data.binary ? colourLines(data.content, sel?.path ?? '') : null), [data, sel?.path])
  const i = (sel?.path ?? '').lastIndexOf('/')
  const name = sel ? sel.path.slice(i + 1) : ''
  const dir = sel && i >= 0 ? sel.path.slice(0, i + 1) : ''
  const isMd = /\.(md|markdown|mdx)$/i.test(sel?.path ?? '')
  const preview = isMd && mdMode === 'preview' && !!data && !data.binary
  const total = colored?.lines.length ?? 0
  // a relative link in a Markdown file: resolved against the file's folder, kept inside the project folder
  const resolveRel = (href: string): string | null => {
    let rel: string
    try { rel = decodeURIComponent(href.split(/[#?]/)[0]) } catch { return null }
    const out: string[] = []
    for (const p of (href.startsWith('/') ? '' : dir).concat(rel).split('/')) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p) }
    return out.length ? out.join('/') : null
  }
  const openLink = (href: string) => {
    const p = resolveRel(href)
    if (sel && p) files.setSel({ root: sel.root, path: p })
  }
  const imageUrl = (src: string) => {
    const p = sel && resolveRel(src)
    return sel && p ? `/api/files/raw?${new URLSearchParams({ root: sel.root, path: p })}` : null
  }
  const rootName = files.roots.find((r) => r.root === sel?.root)?.name

  return (
    <div className="detail-pane diff-pane">
      <div className="toolbar">
        {sel ? (
          <>
            <span className="title">{name}</span>
            <span className="muted">{rootName ? rootName + '/' : ''}{dir}</span>
            {data && <span className="muted">{fmtSize(data.size)}{colored ? ` · ${total.toLocaleString('en-US')} lines` : ''}</span>}
          </>
        ) : (
          <span className="muted">No file selected</span>
        )}
        <div className="spacer" />
        {zoom.controls}
        {isMd && (
          <div className="seg" role="group" aria-label="Markdown view">
            <button className={mdMode === 'preview' ? 'on' : ''} onClick={() => setMdMode('preview')}>Preview</button>
            <button className={mdMode === 'source' ? 'on' : ''} onClick={() => setMdMode('source')}>Source</button>
          </div>
        )}
      </div>
      <div className="diff-body files-body" ref={bodyRef} style={zoom.style}>
        {err && <div className="diff-note">{err}</div>}
        {!err && !sel && <div className="diff-note">Pick a file on the left. This view is read-only.</div>}
        {!err && sel && loading && <div className="diff-note">Loading…</div>}
        {data?.binary && <div className="diff-note">Binary file ({fmtSize(data.size)}), nothing to show.</div>}
        {data && !data.binary && total === 0 && !preview && <div className="diff-note">Empty file.</div>}
        {preview && data && <Markdown text={data.content} onOpen={openLink} imageUrl={imageUrl} />}
        {!preview && colored && total > 0 && (
          <table className="file">
            <tbody>
              {colored.lines.slice(0, shown).map((l, n) => {
                const t = colored.toks[n]
                return (
                  <tr key={n}>
                    <td className="num">{n + 1}</td>
                    <td className="code">
                      {t ? t.map((x, k) => (typeof x === 'string' ? x : <span key={k} className={`tk-${x[0]}`}>{x[1]}</span>)) : l}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {!preview && total > shown && (
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
        {data?.truncated && <div className="diff-note">Only the first {fmtSize(1 << 20)} of this file are shown.</div>}
        {!preview && colored && total > 0 && (
          <div className="file-fill" aria-hidden>
            <i className="num" />
            <i />
          </div>
        )}
      </div>
    </div>
  )
}
