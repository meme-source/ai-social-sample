import { readFileSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

/**
 * Which build is a tester running? On Vercel: the short git commit. Locally:
 * package version + build time, e.g. "0.1.0+20261110.1503". Every feedback row
 * and client event stores this, so findings can be tied to a build.
 */
function appVersion(): string {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION
  const sha = process.env.VERCEL_GIT_COMMIT_SHA
  if (sha) return sha.slice(0, 7)
  const stamp = new Date().toISOString().slice(0, 16).replace(/-/g, '').replace('T', '.').replace(':', '')
  return `${pkg.version}+${stamp}`
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion()),
  },
  server: { port: 5173 },
})
