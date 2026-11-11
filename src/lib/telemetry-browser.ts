/**
 * Plugs the Telemetry queue into the page: catches JS errors, uploads every
 * 10 s, and uploads with `keepalive` when the page is hidden (so the last
 * batch survives the tab closing or the iPhone locking).
 */
import { APP_VERSION, env } from './env.ts'
import { Telemetry, type Transport } from './telemetry.ts'

const FLUSH_EVERY_MS = 10_000

let accessToken: string | null = null

/** Called whenever Supabase signs in or refreshes the token. */
export function setTelemetryToken(token: string | null): void {
  accessToken = token
}

/**
 * A plain fetch (not supabase-js) because only fetch supports `keepalive`,
 * which lets the request finish after the page is gone.
 */
const restTransport: Transport = async (events, { keepalive }) => {
  if (!accessToken) return false // not signed in yet: keep them queued
  const response = await fetch(`${env.supabaseUrl}/rest/v1/client_events`, {
    method: 'POST',
    keepalive,
    headers: {
      apikey: env.supabaseKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(events),
  })
  return response.ok
}

export const telemetry = new Telemetry({ appVersion: APP_VERSION, transport: restTransport })

/** Log a failed request without its payload. */
export function logRequestFailure(op: string, error: unknown, roomId: string | null = null): void {
  const e = (error ?? {}) as { code?: unknown; status?: unknown; message?: unknown }
  telemetry.log(
    'request_failed',
    {
      op,
      code: typeof e.code === 'string' ? e.code : null,
      status: typeof e.status === 'number' ? e.status : null,
      error: typeof e.message === 'string' ? e.message.slice(0, 120) : null,
    },
    roomId,
  )
}

function stripQuery(url: string): string {
  return url.split('?')[0] ?? url
}

/** Start collecting. Returns a cleanup function. */
export function installTelemetry(): () => void {
  const onError = (event: ErrorEvent): void => {
    if (!event.message) return // resource load errors have no message
    telemetry.log('js_error', {
      error: event.message.slice(0, 200),
      source: stripQuery(event.filename ?? ''),
      line: event.lineno ?? null,
      col: event.colno ?? null,
    })
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason)
    telemetry.log('unhandled_rejection', { error: reason.slice(0, 200) })
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') void telemetry.flush({ keepalive: true })
  }
  const onPageHide = (): void => {
    void telemetry.flush({ keepalive: true })
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  const timer = window.setInterval(() => void telemetry.flush(), FLUSH_EVERY_MS)

  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    window.clearInterval(timer)
  }
}
