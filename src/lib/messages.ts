/**
 * The message list as pure functions: merge new messages in, drop duplicates,
 * keep server-time order, and reconcile "sending…" bubbles with the saved row.
 * The chat hook calls these; the tests in messages.test.ts pin the behaviour.
 */
import { parseTimestampMs } from '../../supabase/functions/_shared/time.ts'

export type MessageKind = 'chat' | 'system'
export type DeliveryStatus = 'sending' | 'sent' | 'failed'
/** Where a batch of messages came from. */
export type MergeSource = 'initial' | 'realtime' | 'catchup' | 'send'

/** A row as Supabase returns it. */
export interface MessageRow {
  id: number
  room_id: string
  profile_id: string | null
  kind: MessageKind
  content: string
  client_msg_id: string
  mentions: string[] | null
  created_at: string
}

export const MESSAGE_COLUMNS = 'id, room_id, profile_id, kind, content, client_msg_id, mentions, created_at'

export interface ChatMessage {
  /** null while the message is still being sent */
  id: number | null
  roomId: string
  profileId: string | null
  kind: MessageKind
  content: string
  clientMsgId: string
  mentions: string[]
  /** Server time for saved messages; phone time for ones still sending. */
  createdAtMs: number
  status: DeliveryStatus
  /** Has the realtime channel delivered this message to us yet? */
  viaRealtime: boolean
}

export function isMessageRow(value: unknown): value is MessageRow {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'number' &&
    typeof v.room_id === 'string' &&
    (v.profile_id === null || typeof v.profile_id === 'string') &&
    (v.kind === 'chat' || v.kind === 'system') &&
    typeof v.content === 'string' &&
    typeof v.client_msg_id === 'string' &&
    typeof v.created_at === 'string'
  )
}

export function fromRow(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    roomId: row.room_id,
    profileId: row.profile_id,
    kind: row.kind,
    content: row.content,
    clientMsgId: row.client_msg_id,
    mentions: row.mentions ?? [],
    createdAtMs: parseTimestampMs(row.created_at),
    status: 'sent',
    viaRealtime: false,
  }
}

export interface PendingInput {
  roomId: string
  profileId: string
  content: string
  clientMsgId: string
  mentions: string[]
  nowMs: number
}

export function createPending(input: PendingInput): ChatMessage {
  return {
    id: null,
    roomId: input.roomId,
    profileId: input.profileId,
    kind: 'chat',
    content: input.content,
    clientMsgId: input.clientMsgId,
    mentions: input.mentions,
    createdAtMs: input.nowMs,
    status: 'sending',
    viaRealtime: false,
  }
}

/** Display order: saved messages by server time, then id; messages still sending go last. */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  const aPending = a.id === null
  const bPending = b.id === null
  if (aPending !== bPending) return aPending ? 1 : -1
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs
  return (a.id ?? 0) - (b.id ?? 0)
}

export function newestConfirmed(messages: readonly ChatMessage[]): ChatMessage | null {
  let newest: ChatMessage | null = null
  for (const m of messages) {
    if (m.id !== null && (newest === null || compareMessages(m, newest) > 0)) newest = m
  }
  return newest
}

export function maxConfirmedId(messages: readonly ChatMessage[]): number {
  return messages.reduce((max, m) => (m.id !== null && m.id > max ? m.id : max), 0)
}

export interface MergeResult {
  messages: ChatMessage[]
  /** genuinely new messages */
  added: number
  /** "sending…" bubbles replaced by their saved row */
  reconciled: number
  /** realtime delivered a message it had already delivered (dropped) */
  duplicates: number
  /** catch-up/initial fetch returned messages we already had (expected: we overlap on purpose) */
  overlap: number
  /** realtime messages that arrived after a newer one */
  outOfOrder: number
  maxOutOfOrderMs: number
  /** messages delivered by realtime for the first time (used for latency) */
  firstDeliveries: ChatMessage[]
}

export function mergeMessages(
  current: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
  source: MergeSource,
): MergeResult {
  const list = [...current]
  const indexById = new Map<number, number>()
  list.forEach((m, i) => {
    if (m.id !== null) indexById.set(m.id, i)
  })
  let newest = newestConfirmed(list)
  const result: Omit<MergeResult, 'messages'> = {
    added: 0,
    reconciled: 0,
    duplicates: 0,
    overlap: 0,
    outOfOrder: 0,
    maxOutOfOrderMs: 0,
    firstDeliveries: [],
  }

  for (const raw of incoming) {
    if (raw.id === null) continue // only saved messages can be merged
    const existingIndex = indexById.get(raw.id)
    const existing = existingIndex === undefined ? undefined : list[existingIndex]

    if (existingIndex !== undefined && existing) {
      if (source === 'realtime') {
        if (existing.viaRealtime) {
          result.duplicates += 1
        } else {
          const delivered = { ...existing, viaRealtime: true }
          list[existingIndex] = delivered
          result.firstDeliveries.push(delivered)
        }
      } else if (source === 'catchup' || source === 'initial') {
        result.overlap += 1
      }
      continue
    }

    const message: ChatMessage = { ...raw, status: 'sent', viaRealtime: source === 'realtime' }
    if (source === 'realtime') {
      result.firstDeliveries.push(message)
      if (newest && compareMessages(message, newest) < 0) {
        result.outOfOrder += 1
        result.maxOutOfOrderMs = Math.max(result.maxOutOfOrderMs, newest.createdAtMs - message.createdAtMs)
      }
    }

    const pendingIndex = list.findIndex((m) => m.id === null && m.clientMsgId === message.clientMsgId)
    if (pendingIndex >= 0) {
      list[pendingIndex] = message
      indexById.set(raw.id, pendingIndex)
      result.reconciled += 1
    } else {
      list.push(message)
      indexById.set(raw.id, list.length - 1)
      result.added += 1
    }
    if (!newest || compareMessages(message, newest) > 0) newest = message
  }

  return { messages: list.sort(compareMessages), ...result }
}

export function withStatus(
  messages: readonly ChatMessage[],
  clientMsgId: string,
  status: DeliveryStatus,
): ChatMessage[] {
  return messages.map((m) => (m.id === null && m.clientMsgId === clientMsgId ? { ...m, status } : m))
}

/** Keep memory bounded on long sessions: the newest `max` saved messages plus anything still sending. */
export function trimHistory(messages: readonly ChatMessage[], max = 400): ChatMessage[] {
  const saved = messages.filter((m) => m.id !== null)
  if (saved.length <= max) return [...messages]
  const keepFrom = saved[saved.length - max]
  return messages.filter((m) => m.id === null || (keepFrom !== undefined && compareMessages(m, keepFrom) >= 0))
}
