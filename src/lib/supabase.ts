import { createClient } from '@supabase/supabase-js'
import { env } from './env.ts'
import { safeStorage } from './storage.ts'

/**
 * "Slots" let one browser hold several test identities, one per tab:
 * open /?slot=2 in a second tab to rehearse a chat with yourself.
 * The slot sticks to the tab (sessionStorage), so links inside it keep working.
 */
function resolveSlot(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('slot')
  if (fromUrl && /^[1-9]$/.test(fromUrl)) {
    safeStorage.session.set('rooms.slot', fromUrl)
    return fromUrl
  }
  return safeStorage.session.get('rooms.slot')
}

export const identitySlot = resolveSlot()

export const supabase = createClient(env.supabaseUrl, env.supabaseKey, {
  auth: {
    storageKey: identitySlot ? `rooms-auth-slot-${identitySlot}` : 'rooms-auth',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
})
