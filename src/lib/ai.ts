import type { Trigger } from '../../supabase/functions/_shared/ai-rules.ts'
import { supabase } from './supabase.ts'
import { logRequestFailure } from './telemetry-browser.ts'

export interface AiTriggerInput {
  roomId: string
  trigger: Trigger
  messageId?: number
}

/**
 * Ask the AI host to consider speaking. The server decides (and logs why);
 * the answer is deliberately the same either way. Only a join may be told to
 * retry, when another AI turn was holding the room's lock.
 */
export async function callRoomAi(input: AiTriggerInput): Promise<{ retryAfterMs: number | null }> {
  const { data, error } = await supabase.functions.invoke('room-ai', {
    body: { room_id: input.roomId, trigger: input.trigger, message_id: input.messageId ?? null },
  })
  if (error) {
    const status = (error as { context?: { status?: unknown } }).context?.status
    logRequestFailure(`room_ai_${input.trigger}`, { ...error, status }, input.roomId)
    return { retryAfterMs: null }
  }
  const retry = (data as { retry_after_ms?: unknown } | null)?.retry_after_ms
  return { retryAfterMs: typeof retry === 'number' && retry > 0 ? retry : null }
}
