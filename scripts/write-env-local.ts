/**
 * Writes .env.local for the LOCAL Supabase stack.
 *   npm run env:local   → http://127.0.0.1:54321 (this Mac only). Won't overwrite an existing file
 *                          unless you add --force.
 *   npm run env:lan     → http://<this Mac's Wi-Fi address>:54321, so iPhones on the same
 *                          Wi-Fi can use the app too. Always rewrites .env.local.
 * Only the URL and the public (publishable) key — never the service key.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { resolveTarget } from './lib/local-env.ts'

const lan = process.argv.includes('--lan')
const force = lan || process.argv.includes('--force')

/** This Mac's address on the local network (prefers Wi-Fi, en0). */
function lanAddress(): string | null {
  const isPrivate = (ip: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).filter((a) => a.family === 'IPv4' && !a.internal && isPrivate(a.address)).map((a) => ({ name, address: a.address })),
  )
  return (candidates.find((c) => c.name === 'en0') ?? candidates[0])?.address ?? null
}

if (existsSync('.env.local') && !force) {
  process.stdout.write('.env.local already exists — left unchanged (use --force to replace it).\n')
  process.exit(0)
}

// Ignore any hosted values in the shell: this helper is for the local stack only.
delete process.env.SUPABASE_URL
const target = resolveTarget()
if (!target.isLocal) throw new Error('Refusing to write .env.local for a non-local project.')

let url = target.url
if (lan) {
  const address = lanAddress()
  if (!address) throw new Error('No Wi-Fi/LAN address found. Is this Mac connected to a network?')
  url = target.url.replace(/127\.0\.0\.1|localhost/, address)
}

writeFileSync(
  '.env.local',
  [
    `# Written by \`npm run ${lan ? 'env:lan' : 'env:local'}\` for the LOCAL Supabase stack. Git-ignored.`,
    `VITE_SUPABASE_URL=${url}`,
    `VITE_SUPABASE_PUBLISHABLE_KEY=${target.publicKey}`,
    '',
  ].join('\n'),
)
process.stdout.write(`Wrote .env.local for ${url} (key not shown).\n`)
if (lan) {
  process.stdout.write(`Phones on the same Wi-Fi: open http://${new URL(url).hostname}:5173 after \`npm run dev\`.\n`)
  process.stdout.write('If the Wi-Fi address changes (another network, a restart), run this again.\n')
}
