// Theme handling: 'grid' (Grid Neon: electric blue on midnight) or 'basic' (neutral greys).
// Themes change colours and motion only; shapes and fonts are shared.
export type Theme = 'grid' | 'basic' | 'basic-light'

export function loadTheme(): Theme {
  const t = localStorage.getItem('grid.theme')
  return t === 'basic' || t === 'basic-light' ? t : 'grid'
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t
  localStorage.setItem('grid.theme', t)
}

/** xterm colours per theme (xterm draws on a canvas, CSS cannot reach it). */
export const termTheme = {
  grid: { background: '#000000', foreground: '#d6def5', selectionBackground: '#0a2a7a', cursor: '#000000',
    // no purple in the Grid Neon palette: ANSI magenta (the pid in Spring logs, etc.) becomes the blues
    magenta: '#6ea4ff', brightMagenta: '#9cc2ff' },
  basic: { background: '#1e1f22', foreground: '#bcbec4', selectionBackground: '#3a4252', cursor: '#1e1f22' },
  // light ground: the ANSI colours must be darker than xterm's defaults or yellow/cyan/white vanish
  'basic-light': { background: '#ffffff', foreground: '#1f2328', selectionBackground: '#cfdcf3', cursor: '#ffffff',
    black: '#1f2328', red: '#c62828', green: '#1a7f45', yellow: '#8a6100', blue: '#1c4fb0', magenta: '#8b3f86', cyan: '#0f6f7a', white: '#6e7681',
    brightBlack: '#57606a', brightRed: '#d13438', brightGreen: '#1a8f55', brightYellow: '#9a6a00', brightBlue: '#2f5bb0', brightMagenta: '#a24c9b', brightCyan: '#16808c', brightWhite: '#8c959f' },
}

/** colour of the runner's own "▸" lines in the log (256-colour index) */
export const sysColor = { grid: 75, basic: 246, 'basic-light': 242 }

/** monospace stack for xterm (canvas: needs real family names, not a CSS variable) */
export const MONO = "'JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Mono', Consolas, Menlo, monospace"

// Text size of the whole app: "standard" (the default) or "large". Every font-size in styles.css is multiplied by --ui-scale;
// xterm (canvas) and CodeMirror read the same factor.
export type FontSize = 'standard' | 'large'
export const FONT_SCALE: Record<FontSize, number> = { standard: 1, large: 1.15 }
export const FONT_EVENT = 'grid:fontsize'

export function loadFontSize(): FontSize {
  return localStorage.getItem('grid.fontSize') === 'large' ? 'large' : 'standard'
}

export function applyFontSize(f: FontSize) {
  document.documentElement.style.setProperty('--ui-scale', String(FONT_SCALE[f]))
  localStorage.setItem('grid.fontSize', f)
  window.dispatchEvent(new Event(FONT_EVENT))
}

/** the current factor, for the terminals (their font size is a number, not CSS) */
export const fontScale = () => FONT_SCALE[loadFontSize()]
