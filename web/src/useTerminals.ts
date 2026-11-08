import { useCallback, useEffect, useRef, useState } from 'react'
import { closeTerm, openTerm, type TermInfo } from './api'
import { loadPrefs, type NewTermPrefs } from './Terminals'

/**
 * State of the terminal panel: the open terminals, which one is shown, and
 * whether the panel is open / maximized. Ctrl+` toggles the panel,
 * Ctrl+Shift+` opens a new terminal.
 *
 * cwd is the folder of the selected service (where a new terminal starts).
 */
export function useTerminals(cwd: string, setError: (e: string | null) => void) {
  const [terms, setTerms] = useState<TermInfo[]>([])
  const [selectedTerm, setSelectedTerm] = useState<string | null>(() => localStorage.getItem('grid.term'))
  const [termOpen, setTermOpen] = useState(() => localStorage.getItem('grid.term.open') === 'on')
  const [termMax, setTermMax] = useState(false)
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const termsLoaded = useRef(false)

  useEffect(() => localStorage.setItem('grid.term.open', termOpen ? 'on' : 'off'), [termOpen])
  useEffect(() => {
    if (selectedTerm) localStorage.setItem('grid.term', selectedTerm)
  }, [selectedTerm])
  // keep a valid terminal selected when the list changes
  useEffect(() => {
    if (selectedTerm && terms.some((t) => t.id === selectedTerm)) return
    const next = terms[terms.length - 1]?.id ?? null
    if (next !== selectedTerm) setSelectedTerm(next)
  }, [terms, selectedTerm])

  /** The terminal list from the server: the first snapshot (loaded = true) or a 'terms' event. */
  const onServerList = useCallback((list: TermInfo[], snapshot: boolean) => {
    if (snapshot) termsLoaded.current = true
    setTerms(list)
  }, [])

  const opening = useRef(false) // an open request is in flight (keeps the auto-open and a click from both spawning)
  const newTerm = useCallback(
    (o: { service?: string } & Partial<NewTermPrefs>) => {
      if (opening.current) return
      opening.current = true
      setError(null)
      // A new terminal starts in the folder of the service whose log is open (unless it is opened for a specific service).
      const dir = o.cwd || (o.service ? '' : cwdRef.current)
      openTerm({ shell: o.shell || undefined, runtimes: o.runtimes, cwd: dir || undefined, service: o.service })
        .then(
          (t) => {
            setTerms((list) => (list.some((x) => x.id === t.id) ? list : [...list, t]))
            setSelectedTerm(t.id)
            setTermOpen(true)
          },
          (e) => setError(`terminal: ${e.message}`),
        )
        .finally(() => {
          opening.current = false
        })
    },
    [setError],
  )
  const killTerm = useCallback((id: string) => {
    setTerms((list) => {
      const i = list.findIndex((t) => t.id === id)
      const next = list.filter((t) => t.id !== id)
      // select the neighbour tab, like an editor does
      setSelectedTerm((cur) => (cur === id ? (next[Math.min(i, next.length - 1)]?.id ?? null) : cur))
      if (!next.length) setTermOpen(false) // no terminals left: nothing to show
      return next
    })
    closeTerm(id).catch(() => {}) // already gone is fine
  }, [])

  // The panel is never empty: shown with no terminal at all (also after a restart with the panel left open), it opens one.
  useEffect(() => {
    if (termOpen && termsLoaded.current && terms.length === 0) newTerm(loadPrefs())
  }, [termOpen, terms, newTerm])

  // Ctrl+` shows / hides the terminals (opening one if none is running), Ctrl+Shift+` opens a new one.
  const termsRef = useRef(terms)
  termsRef.current = terms
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || (e.key !== '`' && e.code !== 'Backquote')) return
      e.preventDefault()
      if (e.shiftKey) return newTerm(loadPrefs())
      setTermOpen((open) => {
        if (!open && !termsRef.current.some((t) => !t.exited)) newTerm(loadPrefs())
        return !open
      })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [newTerm])

  /** The activity bar button: like Ctrl+`. */
  const toggle = () => {
    if (!termOpen && !terms.some((t) => !t.exited)) newTerm(loadPrefs())
    setTermOpen((v) => !v)
  }

  return { terms, onServerList, selectedTerm, setSelectedTerm, termOpen, setTermOpen, termMax, setTermMax, newTerm, killTerm, toggle }
}
