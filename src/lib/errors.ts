/** Turn Supabase/network errors into a sentence a tester can act on. */
export function friendlyError(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (!error || typeof error !== 'object') return fallback
  const { message, code } = error as { message?: unknown; code?: unknown }
  const text = typeof message === 'string' ? message : ''

  if (/failed to fetch|networkerror|load failed|network request failed/i.test(text)) {
    return 'No connection. Check your internet and try again.'
  }
  if (/rate limit|too many requests/i.test(text)) {
    return 'Too many sign-ins from this network right now. Wait a minute and try again.'
  }
  if (/captcha/i.test(text)) return 'Please finish the quick human check first.'
  if (/anonymous sign-ins are disabled/i.test(text)) {
    return 'Guest sign-in is switched off for this project (Supabase → Authentication → Sign In / Providers).'
  }
  // Our own database functions raise readable messages with these codes.
  if (code === 'P0001' || code === 'P0002' || code === '42501') return text || fallback
  return fallback
}
