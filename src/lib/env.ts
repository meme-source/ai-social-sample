/** Settings that come from .env.local (locally) or Vercel's environment variables. */
export interface AppEnv {
  supabaseUrl: string
  supabaseKey: string
  turnstileSiteKey: string | null
  appVersion: string
}

export type EnvResult = { ok: true; env: AppEnv } | { ok: false; missing: string[] }

export function readEnv(source: ImportMetaEnv = import.meta.env): EnvResult {
  const supabaseUrl = source.VITE_SUPABASE_URL?.trim() ?? ''
  const supabaseKey = (source.VITE_SUPABASE_PUBLISHABLE_KEY ?? source.VITE_SUPABASE_ANON_KEY ?? '').trim()
  const missing = [
    supabaseUrl ? null : 'VITE_SUPABASE_URL',
    supabaseKey ? null : 'VITE_SUPABASE_PUBLISHABLE_KEY',
  ].filter((name): name is string => name !== null)
  if (missing.length > 0) return { ok: false, missing }
  return {
    ok: true,
    env: {
      supabaseUrl,
      supabaseKey,
      turnstileSiteKey: source.VITE_TURNSTILE_SITE_KEY?.trim() || null,
      appVersion: source.VITE_APP_VERSION || 'dev',
    },
  }
}

const result = readEnv()

/** Only import this after main.tsx has checked readEnv().ok. */
export const env: AppEnv = result.ok
  ? result.env
  : { supabaseUrl: '', supabaseKey: '', turnstileSiteKey: null, appVersion: 'dev' }

export const APP_VERSION = env.appVersion
