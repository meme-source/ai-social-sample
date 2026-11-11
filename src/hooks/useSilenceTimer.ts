import { useEffect } from 'react'
import { AI_RULES } from '../../supabase/functions/_shared/ai-rules.ts'
import { callRoomAi } from '../lib/ai.ts'

/**
 * Never fire sooner than this after (re)arming. When a hidden tab comes back
 * or the connection returns, the newest message we know may be minutes old
 * while the catch-up is still fetching newer ones; firing at once would ask
 * the host to "break a silence" that isn't one (the server would refuse with
 * not_silent, but it wastes a call). 3 s lets the catch-up and heartbeat land.
 */
const MIN_DELAY_MS = 3_000

interface SilenceTimerInput {
  roomId: string
  /** Server time of the newest message (or of entering an empty room). */
  anchorServerMs: number | null
  clockOffsetMs: number
  /** Only while the room is loaded, connected and on screen. */
  enabled: boolean
}

/**
 * 45 s after the last message, this phone asks the AI host to break the
 * silence. Every phone in the room does the same at about the same moment;
 * the server's room lock lets exactly one of those requests speak.
 * A new message moves the anchor, which cancels and restarts the timer.
 */
export function useSilenceTimer({ roomId, anchorServerMs, clockOffsetMs, enabled }: SilenceTimerInput): void {
  useEffect(() => {
    if (!enabled || anchorServerMs === null) return
    const fireAtLocalMs = anchorServerMs + AI_RULES.silenceMs - clockOffsetMs
    const timer = window.setTimeout(
      () => void callRoomAi({ roomId, trigger: 'silence' }),
      Math.max(MIN_DELAY_MS, fireAtLocalMs - Date.now()),
    )
    return () => window.clearTimeout(timer)
  }, [roomId, anchorServerMs, clockOffsetMs, enabled])
}
