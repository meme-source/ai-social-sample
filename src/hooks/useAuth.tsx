/**
 * Who is using the app: consent (kept on the phone until sign-in), the
 * anonymous Supabase account, and the profile (nickname + avatar).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { CONSENT_VERSION } from '../components/onboarding/consent-text.ts'
import { friendlyError } from '../lib/errors.ts'
import { safeStorage } from '../lib/storage.ts'
import { supabase } from '../lib/supabase.ts'
import { logRequestFailure, setTelemetryToken, telemetry } from '../lib/telemetry-browser.ts'

export interface Profile {
  id: string
  display_name: string
  avatar: string
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'signed_out' }
  | { status: 'signed_in'; userId: string; profile: Profile | null }

interface CreateProfileInput {
  displayName: string
  avatar: string
  captchaToken: string | null
}

interface AuthContextValue {
  state: AuthState
  hasConsent: boolean
  acceptConsent: () => void
  createProfile: (input: CreateProfileInput) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

const CONSENT_KEY = 'rooms.consent'
const AuthContext = createContext<AuthContextValue | null>(null)

async function loadProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, avatar')
    .eq('id', userId)
    .maybeSingle()
  if (error) {
    logRequestFailure('load_profile', error)
    return null
  }
  return data
}

async function recordConsent(userId: string): Promise<void> {
  const { error } = await supabase
    .from('consents')
    .upsert({ user_id: userId, consent_version: CONSENT_VERSION, accepted_at: new Date().toISOString() })
  if (error) logRequestFailure('record_consent', error)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' })
  const [hasConsent, setHasConsent] = useState(() => safeStorage.local.get(CONSENT_KEY) === CONSENT_VERSION)

  useEffect(() => {
    let active = true
    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      setTelemetryToken(session?.access_token ?? null)
      if (event === 'SIGNED_OUT') setState({ status: 'signed_out' })
    })
    void supabase.auth.getSession().then(async ({ data }) => {
      const session = data.session
      setTelemetryToken(session?.access_token ?? null)
      if (!session) {
        if (active) setState({ status: 'signed_out' })
        return
      }
      const profile = await loadProfile(session.user.id)
      if (active) setState({ status: 'signed_in', userId: session.user.id, profile })
    })
    return () => {
      active = false
      subscription.subscription.unsubscribe()
    }
  }, [])

  const acceptConsent = useCallback(() => {
    safeStorage.local.set(CONSENT_KEY, CONSENT_VERSION)
    setHasConsent(true)
    if (state.status === 'signed_in') void recordConsent(state.userId)
  }, [state])

  const createProfile = useCallback(
    async ({ displayName, avatar, captchaToken }: CreateProfileInput): Promise<{ error: string | null }> => {
      let userId = state.status === 'signed_in' ? state.userId : null
      if (!userId) {
        const { data, error } = await supabase.auth.signInAnonymously(
          captchaToken ? { options: { captchaToken } } : undefined,
        )
        if (error || !data.user) {
          logRequestFailure('sign_in_anonymously', error)
          return { error: friendlyError(error, 'Could not sign you in. Please try again.') }
        }
        userId = data.user.id
        setTelemetryToken(data.session?.access_token ?? null)
      }

      const profile: Profile = { id: userId, display_name: displayName.trim(), avatar }
      const { error } = await supabase.from('profiles').upsert(profile)
      if (error) {
        logRequestFailure('save_profile', error)
        setState({ status: 'signed_in', userId, profile: null })
        return { error: friendlyError(error, 'Could not save your profile. Please try again.') }
      }
      await recordConsent(userId)
      telemetry.log('signed_in', { method: 'anonymous' })
      setState({ status: 'signed_in', userId, profile })
      return { error: null }
    },
    [state],
  )

  const signOut = useCallback(async () => {
    await telemetry.flush()
    await supabase.auth.signOut()
    safeStorage.local.remove(CONSENT_KEY)
    setHasConsent(false)
    setState({ status: 'signed_out' })
  }, [])

  const value = useMemo(
    () => ({ state, hasConsent, acceptConsent, createProfile, signOut }),
    [state, hasConsent, acceptConsent, createProfile, signOut],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
