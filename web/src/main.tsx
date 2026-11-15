import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { applyTheme, loadTheme } from './theme'

// set the theme before the first paint (no flash of the other theme)
applyTheme(loadTheme())

// xterm measures its cell size once, on a canvas: load the mono font first (never wait more than a moment)
const mono = document.fonts.load("13px 'JetBrains Mono Variable'").catch(() => {})
Promise.race([mono, new Promise((r) => setTimeout(r, 400))]).then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
)
