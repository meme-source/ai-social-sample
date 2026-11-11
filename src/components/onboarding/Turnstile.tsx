import { useEffect, useRef } from 'react'

/**
 * Cloudflare Turnstile — the "are you human?" check Supabase can require
 * before anonymous sign-in (README step 3). Only shown when
 * VITE_TURNSTILE_SITE_KEY is set.
 */
interface TurnstileApi {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string
      theme: 'dark' | 'light' | 'auto'
      callback: (token: string) => void
      'expired-callback': () => void
      'error-callback': () => void
    },
  ) => string
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let scriptPromise: Promise<void> | null = null

function loadScript(): Promise<void> {
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_URL
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      scriptPromise = null
      reject(new Error('Could not load the human check'))
    }
    document.head.append(script)
  })
  return scriptPromise
}

interface TurnstileProps {
  siteKey: string
  onToken: (token: string | null) => void
  onError: (message: string) => void
}

export function Turnstile({ siteKey, onToken, onError }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let widgetId: string | null = null
    let cancelled = false
    loadScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return
        widgetId = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme: 'dark',
          callback: (token) => onToken(token),
          'expired-callback': () => onToken(null),
          'error-callback': () => onError('The human check failed. Reload the page and try again.'),
        })
      })
      .catch((error: unknown) => onError(error instanceof Error ? error.message : 'Human check unavailable'))
    return () => {
      cancelled = true
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId)
    }
  }, [siteKey, onToken, onError])

  return <div ref={containerRef} className="min-h-[65px]" />
}
