import { type ReactNode } from 'react'
import { isYaml, langOf, tokenize, tokenizeMarkup, tokenizeYaml, type Tok } from './highlight'

// A small Markdown renderer for the Files viewer. It builds React elements only (no innerHTML), so file content can never
// inject markup. Supported: headings, paragraphs, lists (nested, ordered, task), fenced / indented code (coloured), quotes,
// rules, tables, reference links, inline code / bold / italic / strike / links, images, and the small subset of HTML that READMEs
// use (<p align>, <a>, <img>, <br>, <b>, <kbd>, <details>…). Comments are dropped; any other tag is shown as text.

type Open = (href: string) => void
// how an image source is turned into a URL (set by Markdown() for the file being shown): http(s) as it is, a relative path via the files API
let imgSrc: (src: string) => string | null = () => null
const attr = (tag: string, name: string) => new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(tag)?.slice(1).find((x) => x !== undefined)
function image(key: string, src: string | undefined, alt: string, w?: string, h?: string): ReactNode {
  const url = src ? imgSrc(src) : null
  if (!url) return <span key={key} className="md-img">[image{alt ? ': ' + alt : ''}]</span>
  const num = (v?: string) => (v && /^\d{1,4}$/.test(v) ? Number(v) : undefined)
  return <img key={key} src={url} alt={alt} width={num(w)} height={num(h)} loading="lazy" referrerPolicy="no-referrer" />
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/

function colourCode(code: string, lang: string): ReactNode {
  const l = langOf('x.' + (lang === 'sh' || lang === 'shell' ? 'sh' : lang === 'yml' ? 'yaml' : lang))
  if (!l || code.length > 20000) return code
  let inBlock = false
  return code.split('\n').map((line, i) => {
    let toks: Tok[]
    if (l.markup) { const r = tokenizeMarkup(line, l, inBlock); toks = r.toks; inBlock = r.inBlock }
    else if (isYaml(l)) toks = tokenizeYaml(line, l)
    else { const r = tokenize(line, l, inBlock); toks = r.toks; inBlock = r.inBlock }
    return (
      <span key={i}>
        {i > 0 && '\n'}
        {toks.map((t, k) => (typeof t === 'string' ? t : <span key={k} className={`tk-${t[0]}`}>{t[1]}</span>))}
      </span>
    )
  })
}

// ---- inline ----
const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|!?\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|(?<![\w*])\*([^\s*][\s\S]*?)\*(?![\w*])|(?<![\w_])_([^\s_][\s\S]*?)_(?![\w_])|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<)]+[^\s<).,;:!?])|<img\b([^>]*)>|(<br\s*\/?>)|<a\b([^>]*)>([\s\S]*?)<\/a>|<(b|strong|i|em|code|kbd|sub|sup|del|s|u|mark)>([\s\S]*?)<\/\16>/gi

function inline(text: string, open: Open, key = ''): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0, n = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const k = key + n++
    if (m[1]) out.push(<code key={k}>{m[2].trim()}</code>)
    else if (m[12] !== undefined) out.push(image(k, attr(m[12], 'src'), attr(m[12], 'alt') ?? '', attr(m[12], 'width'), attr(m[12], 'height')))
    else if (m[13]) out.push(<br key={k} />)
    else if (m[14] !== undefined) out.push(link(k, attr(m[14], 'href') ?? '', inline(m[15], open, k + '.'), open))
    else if (m[16]) {
      const T = ({ b: 'strong', strong: 'strong', i: 'em', em: 'em', code: 'code', kbd: 'kbd', sub: 'sub', sup: 'sup', del: 'del', s: 'del', u: 'u', mark: 'mark' } as unknown as Record<string, 'em'>)[m[16].toLowerCase()]
      out.push(<T key={k}>{inline(m[17], open, k + '.')}</T>)
    }
    else if (m[4] !== undefined) {
      const label = m[3], href = m[4]
      if (m[0].startsWith('!')) out.push(image(k, href, label))
      else out.push(link(k, href, inline(label, open, k + '.'), open))
    }
    else if (m[5] ?? m[6]) out.push(<strong key={k}>{inline(m[5] ?? m[6], open, k + '.')}</strong>)
    else if (m[7]) out.push(<del key={k}>{inline(m[7], open, k + '.')}</del>)
    else if (m[8] ?? m[9]) out.push(<em key={k}>{inline(m[8] ?? m[9], open, k + '.')}</em>)
    else { const u = m[10] ?? m[11]; out.push(link(k, u, u, open)) }
    last = at + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function link(key: string, href: string, label: ReactNode, open: Open): ReactNode {
  if (/^https?:\/\//i.test(href)) return <a key={key} href={href} target="_blank" rel="noopener noreferrer">{label}</a>
  if (/^(#|[a-z][a-z0-9+.-]*:)/i.test(href)) return <span key={key} className="md-dead" title={href}>{label}</span> // anchors, mailto:, javascript:… are never followed
  return <a key={key} href="#" title={href} onClick={(e) => { e.preventDefault(); open(href) }}>{label}</a>
}

// ---- blocks ----
const HTML_BLOCK = /^\s{0,3}<\/?(p|div|center|h[1-6]|details|summary|picture|source|section|article|figure|table|a|img|br|span|b|i|strong|em|kbd)(\s|>|\/>|$)/i
const isRule = (s: string) => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(s)
const heading = (s: string) => /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(s)
const listItem = (s: string) => /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(s)
const cells = (s: string) => s.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
const isTableSep = (s: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s) && s.includes('-') && (s.includes('|') || false)

function parse(lines: string[], open: Open, base: string): ReactNode[] {
  const out: ReactNode[] = []
  let i = 0, k = 0
  const key = () => base + k++
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const f = FENCE.exec(line)
    if (f) {
      const body: string[] = []
      for (i++; i < lines.length && !new RegExp('^\\s{0,3}' + f[1][0] + '{' + f[1].length + ',}\\s*$').test(lines[i]); i++) body.push(lines[i])
      i++
      out.push(<pre key={key()} className="md-code"><code>{colourCode(body.join('\n'), f[2].toLowerCase())}</code></pre>)
      continue
    }
    if (HTML_BLOCK.test(line)) {
      const chunk: string[] = []
      for (; i < lines.length && lines[i].trim(); i++) chunk.push(lines[i])
      const raw = chunk.join('\n')
      const hm = /^\s*<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>\s*$/i.exec(raw)
      const center = /\balign\s*=\s*["']?center/i.test(raw) || /^\s*<center\b/i.test(raw)
      if (hm) { const T = `h${hm[1]}` as 'h1'; out.push(<T key={key()} className={/center/i.test(hm[2]) ? 'md-center' : undefined}>{inline(hm[3].replace(/\s+/g, ' ').trim(), open)}</T>); continue }
      const text = raw
        .replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, '**$1** ')
        .replace(/<\/?(p|div|center|details|summary|picture|source|span|table|thead|tbody|tr|td|th|section|article|figure|figcaption|ul|ol|li|h[1-6])\b[^>]*>/gi, ' ')
        .replace(/\s+/g, ' ').trim()
      if (text) out.push(<p key={key()} className={center ? 'md-center' : undefined}>{inline(text, open)}</p>)
      continue
    }
    const h = heading(line)
    if (h) { const T = `h${h[1].length}` as 'h1'; out.push(<T key={key()}>{inline(h[2], open)}</T>); i++; continue }
    if (isRule(line)) { out.push(<hr key={key()} />); i++; continue }
    if (/^\s{0,3}>/.test(line)) {
      const q: string[] = []
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s{0,3}>\s?/, ''))
      out.push(<blockquote key={key()}>{parse(q, open, base + k + '.')}</blockquote>)
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line), al = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : undefined))
      const rows: string[][] = []
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(cells(lines[i]))
      out.push(
        <div key={key()} className="md-table">
          <table>
            <thead><tr>{head.map((c, j) => <th key={j} style={{ textAlign: al[j] }}>{inline(c, open)}</th>)}</tr></thead>
            <tbody>{rows.map((r, a) => <tr key={a}>{head.map((_, j) => <td key={j} style={{ textAlign: al[j] }}>{inline(r[j] ?? '', open)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      )
      continue
    }
    if (listItem(line)) {
      const first = listItem(line)!, ordered = /\d/.test(first[2]), baseIndent = first[1].length
      const items: { text: string[]; sub: string[] }[] = []
      while (i < lines.length) {
        const m = listItem(lines[i])
        if (m && m[1].length <= baseIndent + 1 && /\d/.test(m[2]) === ordered) { items.push({ text: [m[3]], sub: [] }); i++; continue }
        if (!lines[i].trim()) { // a blank line stays in the list only when an indented line follows
          const nx = lines.slice(i + 1).find((l) => l.trim())
          if (nx && /^\s{2,}\S/.test(nx) && items.length) { items[items.length - 1].sub.push(''); i++; continue }
          break
        }
        if (/^\s+\S/.test(lines[i]) && items.length) {
          const it = items[items.length - 1]
          if (listItem(lines[i])) it.sub.push(lines[i].slice(Math.min(baseIndent + 2, lines[i].length - lines[i].trimStart().length)))
          else if (it.sub.length) it.sub.push(lines[i].replace(/^\s{1,4}/, ''))
          else it.text.push(lines[i].trim())
          i++; continue
        }
        break
      }
      const L = ordered ? 'ol' : 'ul'
      out.push(
        <L key={key()} start={ordered ? parseInt(first[2], 10) || 1 : undefined}>
          {items.map((it, a) => {
            const t = it.text.join(' '), task = /^\[([ xX])\]\s+(.*)$/.exec(t)
            return (
              <li key={a} className={task ? 'md-task' : undefined}>
                {task && <input type="checkbox" checked={task[1] !== ' '} readOnly disabled />}
                {inline(task ? task[2] : t, open)}
                {it.sub.length > 0 && parse(it.sub, open, base + k + '.' + a + '.')}
              </li>
            )
          })}
        </L>,
      )
      continue
    }
    if (/^( {4}|\t)/.test(line)) {
      const body: string[] = []
      for (; i < lines.length && (/^( {4}|\t)/.test(lines[i]) || !lines[i].trim()); i++) body.push(lines[i].replace(/^( {4}|\t)/, ''))
      while (body.length && !body[body.length - 1].trim()) body.pop()
      out.push(<pre key={key()} className="md-code"><code>{body.join('\n')}</code></pre>)
      continue
    }
    // paragraph: up to a blank line or the start of another block
    const para: string[] = []
    for (; i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !heading(lines[i]) && !isRule(lines[i]) && !/^\s{0,3}>/.test(lines[i]) && !(para.length && HTML_BLOCK.test(lines[i])) && !(para.length && listItem(lines[i])); i++) para.push(lines[i].trim())
    out.push(<p key={key()}>{inline(para.join(' '), open)}</p>)
  }
  return out
}

export function Markdown({ text, onOpen, imageUrl }: { text: string; onOpen: Open; imageUrl: (src: string) => string | null }) {
  imgSrc = (src) => (/^https?:\/\//i.test(src) ? src : /^[a-z][a-z0-9+.-]*:|^\/\//i.test(src) ? null : imageUrl(src))
  const refs = new Map<string, string>() // [id]: url
  const lines = text
    .replace(/\r/g, '')
    .replace(/^---\n[\s\S]*?\n---\n/, '') // YAML front matter is not shown
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((l) => {
      const d = /^\s{0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(].*)?\s*$/.exec(l)
      if (d) refs.set(d[1].toLowerCase(), d[2])
      return !d
    })
    .map((l) => (refs.size ? l.replace(/(!?\[([^\]]*)\])\[([^\]]*)\]/g, (all, head: string, label: string, id: string) => { const u = refs.get((id || label).toLowerCase()); return u ? `${head}(${u})` : all }) : l))
  return <div className="md">{parse(lines, onOpen, '')}</div>
}
