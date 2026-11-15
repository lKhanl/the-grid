// Theme handling: 'grid' (Grid Neon: electric blue on midnight) or 'basic' (neutral greys).
// Themes change colours and motion only; shapes and fonts are shared.
export type Theme = 'grid' | 'basic'

export function loadTheme(): Theme {
  return localStorage.getItem('grid.theme') === 'basic' ? 'basic' : 'grid'
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
}

/** colour of the runner's own "▸" lines in the log (256-colour index) */
export const sysColor = { grid: 75, basic: 246 }

/** monospace stack for xterm (canvas: needs real family names, not a CSS variable) */
export const MONO = "'JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Mono', Consolas, Menlo, monospace"
