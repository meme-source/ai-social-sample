import { APP_VERSION } from './env.ts'
import { supabase } from './supabase.ts'

export type GeneralCategory = 'bug' | 'hard_to_use' | 'idea'
export type MessageCategory = 'duplicated' | 'out_of_order' | 'missed' | 'weird_reply' | 'other'

export const GENERAL_CATEGORIES: { value: GeneralCategory; label: string; hint: string }[] = [
  { value: 'bug', label: 'Bug', hint: 'Something broke or looked wrong' },
  { value: 'hard_to_use', label: 'Hard to use', hint: 'Confusing, slow or fiddly' },
  { value: 'idea', label: 'Idea', hint: 'Something you wish it did' },
]

export const MESSAGE_CATEGORIES: { value: MessageCategory; label: string }[] = [
  { value: 'duplicated', label: 'I see it twice' },
  { value: 'out_of_order', label: 'It’s in the wrong order' },
  { value: 'missed', label: 'I missed messages around here' },
  { value: 'weird_reply', label: 'This reply feels weird' },
  { value: 'other', label: 'Something else' },
]

export const NOTE_MAX = 280

export interface ContextInput {
  roomId: string | null
  onlineCount: number | null
  channelStatus: string | null
  path: string
  userAgent: string
  viewport: { width: number; height: number; dpr: number }
  standalone: boolean
  nowIso: string
}

/** The "auto context" stored with every report. No message text. */
export function buildFeedbackContext(input: ContextInput): Record<string, unknown> {
  return {
    user_agent: input.userAgent.slice(0, 300),
    viewport: `${input.viewport.width}x${input.viewport.height}@${input.viewport.dpr}`,
    online_count: input.onlineCount,
    channel_status: input.channelStatus,
    path: input.path.slice(0, 120),
    standalone: input.standalone,
    client_ts: input.nowIso,
    room_id: input.roomId,
  }
}

export function browserContext(status: { roomId: string | null; onlineCount: number | null; channelStatus: string | null }) {
  const nav = navigator as Navigator & { standalone?: boolean }
  return buildFeedbackContext({
    ...status,
    path: window.location.pathname,
    userAgent: nav.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    standalone: nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches,
    nowIso: new Date().toISOString(),
  })
}

export interface FeedbackInput {
  kind: 'general' | 'message'
  category: GeneralCategory | MessageCategory
  note: string
  roomId: string | null
  messageId: number | null
  context: Record<string, unknown>
}

/** The session id and the sender are added by the database, not by the app. */
export async function sendFeedback(input: FeedbackInput): Promise<{ error: unknown }> {
  const note = input.note.trim().slice(0, NOTE_MAX)
  const { error } = await supabase.from('feedback').insert({
    kind: input.kind,
    category: input.category,
    note: note || null,
    room_id: input.roomId,
    message_id: input.messageId,
    app_version: APP_VERSION,
    context: input.context,
  })
  return { error }
}
