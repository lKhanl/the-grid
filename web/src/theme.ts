// Theme handling: 'grid' (Tron cyan, neon) or 'basic' (neutral greys).
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
  grid: { background: '#0f1215', foreground: '#c3d0d6', selectionBackground: '#0e4a57', cursor: '#0f1215' },
  basic: { background: '#1e1f22', foreground: '#bcbec4', selectionBackground: '#3a4252', cursor: '#1e1f22' },
}

/** colour of the runner's own "▸" lines in the log (256-colour index) */
export const sysColor = { grid: 45, basic: 246 }
