// A tiny line-based syntax colouring for the diff view. It is not a parser: strings, comments,
// numbers, keywords and capitalised names are enough to read code, and it costs a few KB and
// one regex-free pass per line (a real highlighter would be 100 KB+ and a lot slower on a VDI).

type Cls = 'k' | 's' | 'n' | 'c' | 't' | 'f' | 'p' | 'g' // keyword string number comment annotation function property tag
export type Tok = [cls: Cls, text: string] | string

interface Lang {
  keywords: Set<string>
  line?: string[] // line comment starts
  block?: [string, string]
  quotes: string // string delimiters
  nocase?: boolean // keywords match in any case (SQL)
  fn?: boolean // name( is a function
  keys?: boolean // name: is a property key (object literals)
  strKeys?: boolean // "name": is a property key (JSON)
  doubled?: boolean // '' inside a string is a quote (SQL)
  at?: boolean // @Annotation
  markup?: 'xml' | 'jsx' // <tags> and attributes
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean))
const C_LIKE = ['//']

const JAVA: Lang = {
  keywords: words('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield true false null'),
  line: C_LIKE, block: ['/*', '*/'], quotes: '"\'', fn: true, at: true,
}
const JS: Lang = {
  keywords: words('abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface is keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof undefined var void while with yield true false null'),
  line: C_LIKE, block: ['/*', '*/'], quotes: '"\'`', fn: true, keys: true,
}
const JSX: Lang = { ...JS, markup: 'jsx' }
const GO: Lang = {
  keywords: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota'),
  line: C_LIKE, block: ['/*', '*/'], quotes: '"\'`', fn: true,
}
const PY: Lang = {
  keywords: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self'),
  line: ['#'], quotes: '"\'', fn: true,
}
const SQL: Lang = {
  keywords: words('select from where and or not in is null as join left right inner outer full cross on group by order having union all distinct insert into values update set delete create alter drop table view index sequence trigger procedure function package body begin end declare if then else elsif loop while for exit return case when between like exists with fetch first next rows only offset limit commit rollback grant revoke primary key foreign references unique default constraint check number varchar varchar2 char date timestamp clob blob integer int boolean true false replace is asc desc connect prior start minus intersect over partition rownum'),
  line: ['--'], block: ['/*', '*/'], quotes: '\'"', nocase: true, doubled: true, fn: true,
}
const CSS: Lang = { keywords: words('important'), block: ['/*', '*/'], quotes: '"\'' }
const YAML: Lang = { keywords: words('true false null yes no on off'), line: ['#'], quotes: '"\'' }
const JSON_: Lang = { keywords: words('true false null'), quotes: '"', strKeys: true }
const SH: Lang = { keywords: words('if then else elif fi for while do done case esac function in return exit export local echo set unset source cd'), line: ['#'], quotes: '"\'`' }
const XML: Lang = { keywords: new Set(), block: ['<!--', '-->'], quotes: '"\'', markup: 'xml' }
const PROPS: Lang = { keywords: new Set(), line: ['#', '!'], quotes: '' }

const BY_EXT: Record<string, Lang> = {
  java: JAVA, kt: JAVA, kts: JAVA, groovy: JAVA, gradle: JAVA, scala: JAVA, cs: JAVA,
  ts: JS, mts: JS, tsx: JSX, js: JSX, jsx: JSX, mjs: JSX, cjs: JSX,
  go: GO, py: PY, sql: SQL, pls: SQL, pks: SQL, pkb: SQL, plsql: SQL,
  css: CSS, scss: CSS, less: CSS, yml: YAML, yaml: YAML, json: JSON_,
  sh: SH, bash: SH, zsh: SH, xml: XML, html: XML, htm: XML, xhtml: XML, svg: XML, pom: XML, fxml: XML,
  properties: PROPS, ini: PROPS, conf: PROPS, env: PROPS,
}

export function langOf(path: string): Lang | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'pom.xml') return XML
  const dot = name.lastIndexOf('.')
  return BY_EXT[dot >= 0 ? name.slice(dot + 1) : name] ?? null
}

const isWord = (c: string) => /[\w$]/.test(c)

/** Colours one line. `inBlock` is whether the line starts inside a block comment; the new value is returned. */
export function tokenize(line: string, lang: Lang, inBlock: boolean): { toks: Tok[]; inBlock: boolean } {
  const out: Tok[] = []
  let plain = ''
  const flush = () => {
    if (plain) out.push(plain)
    plain = ''
  }
  const put = (cls: Cls, text: string) => {
    flush()
    out.push([cls, text])
  }
  const n = line.length
  let i = 0
  const [bo, bc] = lang.block ?? ['', '']
  while (i < n) {
    if (inBlock) {
      const j = line.indexOf(bc, i)
      const end = j < 0 ? n : j + bc.length
      put('c', line.slice(i, end))
      i = end
      if (j >= 0) inBlock = false
      continue
    }
    const c = line[i]
    if (lang.line?.some((l) => line.startsWith(l, i))) {
      put('c', line.slice(i))
      break
    }
    if (bo && line.startsWith(bo, i)) {
      const j = line.indexOf(bc, i + bo.length)
      const end = j < 0 ? n : j + bc.length
      put('c', line.slice(i, end))
      i = end
      inBlock = j < 0
      continue
    }
    if (lang.quotes.includes(c)) {
      let j = i + 1
      while (j < n) {
        if (line[j] === '\\' && !lang.doubled) j += 2
        else if (line[j] === c) {
          if (lang.doubled && line[j + 1] === c) j += 2
          else break
        } else j++
      }
      const end = Math.min(n, j + 1)
      const isKey = lang.strKeys && /^\s*:/.test(line.slice(end))
      put(isKey ? 'p' : 's', line.slice(i, end))
      i = end
      continue
    }
    if (/\d/.test(c) && (i === 0 || !isWord(line[i - 1]))) {
      let j = i + 1
      while (j < n && /[\w.]/.test(line[j])) j++
      put('n', line.slice(i, j))
      i = j
      continue
    }
    if (/[A-Za-z_$]/.test(c) || (lang.at && c === '@' && /[A-Za-z]/.test(line[i + 1] ?? ''))) {
      let j = i + 1
      while (j < n && isWord(line[j])) j++
      const w = line.slice(i, j)
      const key = lang.nocase ? w.toLowerCase() : w
      if (c === '@') put('t', w)
      else if (lang.keywords.has(key)) put('k', w)
      else if (lang.fn && line[j] === '(') put('f', w)
      else if (lang.keys && line[j] === ':' && line[j + 1] !== ':') put('p', w)
      else plain += w
      i = j
      continue
    }
    plain += c
    i++
  }
  flush()
  return { toks: out, inBlock }
}

/** XML / HTML / JSX: tag names, `>` and attribute names, on top of the generic strings and comments. */
export function tokenizeMarkup(line: string, lang: Lang, inBlock: boolean): { toks: Tok[]; inBlock: boolean } {
  const base = tokenize(line, lang, inBlock)
  const jsx = lang.markup === 'jsx'
  // JSX: `Array<string>` and `a => b` are not tags: a tag must not follow a word / `)` / `]` and `>` needs a tag before it
  const re = jsx
    ? /(?<![\w$)\]])(<\/?[A-Za-z][\w.:-]*)(?=[\s/>]|$)|(?<![=\-])(\/?>)|([A-Za-z_:][\w:.-]*)(?==["{])/g
    : /(<\/?[A-Za-z_][\w:.-]*)|(\/?>)|([A-Za-z_:][\w:.-]*)(?==)/g
  let tagSeen = !jsx
  const toks: Tok[] = []
  // `<Code` was cut in two by the generic pass (`<` and a type-coloured name): glue it back together
  const parts: Tok[] = []
  for (const t of base.toks) {
    const prev = parts[parts.length - 1]
    if (typeof t !== 'string' && (t[0] === 't' || t[0] === 'k' || t[0] === 'p') && typeof prev === 'string' && /(^|[^\w$)\]])<\/?$/.test(prev)) {
      const m = /<\/?$/.exec(prev)!
      if (m.index > 0) parts[parts.length - 1] = prev.slice(0, m.index)
      else parts.pop()
      parts.push(m[0] + t[1])
    } else parts.push(t)
  }
  for (let pi = 0; pi < parts.length; pi++) {
    let t = parts[pi]
    const next = parts[pi + 1]
    // an attribute called `type` / `class` / `for` is not a keyword
    if (typeof t !== 'string' && (t[0] === 'k' || t[0] === 'f' || t[0] === 'p') && typeof next === 'string' && /^=($|["'{])/.test(next)) t = t[1]
    if (typeof t !== 'string') {
      toks.push(t)
      continue
    }
    let last = 0
    for (let m; (m = re.exec(t)); ) {
      if (m[2] && !tagSeen) continue
      if (m[3]) continue // an attribute name keeps the text colour
      if (m.index > last) toks.push(t.slice(last, m.index))
      if (m[1]) tagSeen = true
      toks.push(['g', m[0]])
      last = m.index + m[0].length
    }
    if (last < t.length) toks.push(t.slice(last))
  }
  return { toks, inBlock: base.inBlock }
}



/** YAML keys (`name:`) in the keyword colour. */
export function tokenizeYaml(line: string, lang: Lang): Tok[] {
  const m = /^(\s*-?\s*)([\w.\-/"']+)(\s*:)(\s|$)/.exec(line)
  if (!m || line.trimStart().startsWith('#')) return tokenize(line, lang, false).toks
  const rest = tokenize(line.slice(m[0].length - m[4].length), lang, false).toks
  return [m[1], ['k', m[2]], m[3], ...rest]
}
export const isYaml = (l: Lang) => l === YAML

export type { Lang }
