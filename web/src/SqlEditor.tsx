import { useEffect, useRef } from 'react'
import { Annotation, EditorState, Transaction } from '@codemirror/state'
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { PLSQL, sql } from '@codemirror/lang-sql'
import { autocompletion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete'
import { createCompletion } from './sqlComplete'
import { statementAt } from './sqlSplit'
import { tags as t } from '@lezer/highlight'

/** What the toolbar needs from the editor. */
export interface SqlEditorHandle {
  /** the selected text, or everything when nothing is selected */
  runText: () => string
}

interface Props {
  /** The text to start with, and the text to switch to whenever `rev` changes. Typing does not
   *  come back through this prop (that would race with fast typing); it only goes up via onChange. */
  value: string
  rev: number
  onChange: (text: string) => void
  /** Ctrl+Enter / Cmd+Enter: gets the selection, or the whole text */
  onRun: (text: string) => void
  handle: { current: SqlEditorHandle | null }
  placeholderText: string
  /** the connection, for table and column suggestions */
  connection: string
}

// Colours come from CSS variables (--sql-*), so both Grid themes style the editor.
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--sql-keyword)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: 'var(--sql-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--sql-number)' },
  { tag: [t.lineComment, t.blockComment, t.comment], color: 'var(--sql-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.standard(t.name)], color: 'var(--sql-type)' },
  { tag: [t.operator, t.punctuation, t.separator, t.paren, t.squareBracket, t.brace], color: 'var(--sql-op)' },
])

const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--text)', fontSize: '13px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: "'JetBrains Mono', Consolas, Menlo, monospace", lineHeight: '1.55', overflow: 'auto' },
    '.cm-content': { caretColor: 'var(--text)', padding: '10px 0' },
    '.cm-line': { padding: '0 14px 0 6px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--muted)', border: 'none', paddingLeft: '4px' },
    '.cm-lineNumbers .cm-gutterElement': { minWidth: '28px', opacity: '.65' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,.035)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)', opacity: '1' },
    '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--sel)' },
    '.cm-matchingBracket': { backgroundColor: 'var(--on)', outline: '1px solid var(--accent)' },
    '.cm-placeholder': { color: 'var(--muted)' },
    '.cm-tooltip': { backgroundColor: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '6px', overflow: 'hidden' },
    '.cm-tooltip-autocomplete > ul': { fontFamily: "'JetBrains Mono', Consolas, Menlo, monospace", fontSize: '12.5px', maxHeight: '260px' },
    '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--sel)', color: 'var(--text)' },
    '.cm-completionDetail': { color: 'var(--muted)', marginLeft: '12px', fontStyle: 'normal' },
    '.cm-completionMatchedText': { color: 'var(--accent)', textDecoration: 'none', fontWeight: '600' },
    '.cm-completionInfo': { padding: '4px 8px', maxWidth: '320px', whiteSpace: 'normal' },
  },
  { dark: true },
)

// text that is put into the editor from outside (a SELECT from the tree) is marked, and is no undo step
const external = Annotation.define<boolean>()

export function SqlEditor({ value, rev, onChange, onRun, handle, placeholderText, connection }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const cb = useRef({ onChange, onRun })
  cb.current = { onChange, onRun }
  const complete = useRef(createCompletion(connection))
  // database names first; keywords (the language's own source) are added unless only names make sense
  const names: CompletionSource = async (ctx: CompletionContext) => {
    const mine = await complete.current(ctx)
    if (mine?.exclusive) return mine
    const others = ctx.state.languageDataAt<CompletionSource>('autocomplete', ctx.pos)
    const found = (await Promise.all(others.map((f) => f(ctx)))).filter((r): r is CompletionResult => !!r)
    if (!mine) return found[0] ?? null
    return { ...mine, from: found[0]?.from ?? mine.from, options: [...mine.options, ...found.flatMap((r) => r.options)] }
  }

  useEffect(() => {
    const runText = () => {
      const s = view.current!.state
      const sel = s.sliceDoc(s.selection.main.from, s.selection.main.to)
      return sel.trim() ? sel : s.doc.toString()
    }
    // the selection, else the statement the cursor is in
    const statementText = () => {
      const s = view.current!.state
      const sel = s.sliceDoc(s.selection.main.from, s.selection.main.to)
      if (sel.trim()) return sel
      return statementAt(s.doc.toString(), s.selection.main.head)?.sql ?? ''
    }
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          bracketMatching(),
          indentUnit.of('  '),
          sql({ dialect: PLSQL, upperCaseKeywords: true }),
          autocompletion({ override: [names] }),
          syntaxHighlighting(highlight),
          placeholder(placeholderText),
          theme,
          keymap.of([
            {
              key: 'Mod-Enter', // Cmd on a Mac, Ctrl elsewhere
              run: () => {
                cb.current.onRun(runText())
                return true
              },
            },
            {
              key: 'Ctrl-Enter', // Ctrl also on a Mac
              run: () => {
                cb.current.onRun(runText())
                return true
              },
            },
            {
              key: 'Mod-Shift-Enter', // only the statement under the cursor
              run: () => {
                cb.current.onRun(statementText())
                return true
              },
            },
            {
              key: 'Ctrl-Shift-Enter',
              run: () => {
                cb.current.onRun(statementText())
                return true
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = v
    handle.current = { runText }
    return () => {
      handle.current = null
      v.destroy()
      view.current = null
    }
    // the editor is created once; value and callbacks reach it through the effects below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const lastRev = useRef(rev)
  useEffect(() => {
    if (lastRev.current === rev) return
    lastRev.current = rev
    const v = view.current
    if (!v || v.state.doc.toString() === value) return
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: value },
      selection: { anchor: value.length },
      scrollIntoView: true,
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    })
  }, [rev, value])

  return <div className="sql-editor" ref={host} />
}
