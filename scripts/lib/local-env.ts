/**
 * Finds Supabase URL + keys for the scripts without anyone copying keys around:
 *   1. environment variables (SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY / SUPABASE_ANON_KEY,
 *      SUPABASE_SERVICE_ROLE_KEY) — for a hosted project
 *   2. otherwise `supabase status` of the local stack (only works on this machine).
 * Never prints a key.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface SupabaseTarget {
  url: string
  publicKey: string
  /** Service role / secret key. Only available locally or when explicitly provided. */
  serviceKey: string | null
  isLocal: boolean
}

function loadDotEnv(): void {
  for (const file of ['.env.local', '.env']) {
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file)
      } catch {
        // unreadable file: ignore, the checks below report what is missing
      }
    }
  }
}

function localStatus(): Record<string, string> | null {
  try {
    const out = execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const start = out.indexOf('{')
    return start >= 0 ? (JSON.parse(out.slice(start)) as Record<string, string>) : null
  } catch {
    return null
  }
}

export function resolveTarget(options: { needServiceKey?: boolean } = {}): SupabaseTarget {
  loadDotEnv()
  const envUrl = process.env.SUPABASE_URL
  const envKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY
  if (envUrl && envKey) {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? null
    if (options.needServiceKey && !serviceKey) {
      throw new Error('This needs SUPABASE_SERVICE_ROLE_KEY in your shell (never in a VITE_ variable).')
    }
    return { url: envUrl, publicKey: envKey, serviceKey, isLocal: /127\.0\.0\.1|localhost/.test(envUrl) }
  }

  const status = localStatus()
  if (!status?.API_URL) {
    throw new Error('No Supabase found. Start the local stack (npm run db:start) or set SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY.')
  }
  const publicKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY
  if (!publicKey) throw new Error('`supabase status` did not report a public key.')
  return {
    url: status.API_URL,
    publicKey,
    serviceKey: status.SERVICE_ROLE_KEY ?? status.SECRET_KEY ?? null,
    isLocal: true,
  }
}
