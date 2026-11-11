import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SetupNeeded } from './components/SetupNeeded.tsx'
import './index.css'
import { readEnv } from './lib/env.ts'

const container = document.getElementById('root')
if (!container) throw new Error('index.html is missing <div id="root">')
const root = createRoot(container)

// Check the settings before loading anything that talks to Supabase.
const env = readEnv()
if (!env.ok) {
  root.render(<SetupNeeded missing={env.missing} />)
} else {
  void import('./App.tsx').then(({ App }) =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  )
}
