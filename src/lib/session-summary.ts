/**
 * Turns one test session's raw rows into the numbers on the admin page.
 * Pure: give it rows, get a summary — easy to test and to explain.
 */
import { AI_RULES } from '../../supabase/functions/_shared/ai-rules.ts'
import { parseTimestampMs } from '../../supabase/functions/_shared/time.ts'
import { distribution, median, type Distribution } from './stats.ts'

/** A human reply within this long after the host broke a silence counts as "it worked". */
export const REVIVAL_WINDOW_MS = 60_000

export interface SummaryMessage {
  id: number
  room_id: string
  profile_id: string | null
  kind: 'chat' | 'system'
  created_at: string
}

export interface SummaryAiEvent {
  room_id: string
  trigger: string
  decision: 'spoke' | 'skipped'
  reason: string | null
  message_id: number | null
  llm_attempted: boolean
  fallback_used: boolean
  error_code: string | null
  latency_ms: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
}

export interface SummaryClientEvent {
  profile_id: string
  room_id: string | null
  type: string
  data: Record<string, unknown> | null
  server_ts: string
}

export interface SummaryInput {
  messages: readonly SummaryMessage[]
  botProfileIds: ReadonlySet<string>
  names: ReadonlyMap<string, string>
  aiEvents: readonly SummaryAiEvent[]
  clientEvents: readonly SummaryClientEvent[]
  feedbackProfileIds: readonly string[]
}

export interface ParticipantSummary {
  profileId: string
  name: string
  messages: number
  firstSeenAt: number | null
  firstMessageAt: number | null
  timeToFirstMessageMs: number | null
}

export interface SessionSummary {
  participants: ParticipantSummary[]
  neverSpoke: string[]
  messages: { human: number; ai: number; system: number; aiShare: number | null }
  medianTimeToFirstMessageMs: number | null
  silences: {
    count: number
    longestMs: number
    hostBreaks: number
    hostBreaksAnswered: number
    answeredRate: number | null
  }
  ai: {
    triggers: number
    spoke: number
    skippedByReason: Record<string, number>
    byTrigger: Record<string, { spoke: number; skipped: number }>
    llmCalls: number
    llmErrors: number
    fallbacks: number
    errorCodes: Record<string, number>
    llmLatency: Distribution
    promptTokens: number
    completionTokens: number
  }
  clientErrors: Record<string, number>
  /** Messages realtime missed that a catch-up found, by what triggered the catch-up. */
  recovered: Record<string, number>
  latency: Distribution
}

const ERROR_TYPES = new Set(['js_error', 'unhandled_rejection', 'request_failed', 'render_crash'])
const BAD_CHANNEL_STATES = new Set(['CHANNEL_ERROR', 'TIMED_OUT'])

const increment = (counts: Record<string, number>, key: string): Record<string, number> => ({
  ...counts,
  [key]: (counts[key] ?? 0) + 1,
})

const timeOf = (m: SummaryMessage): number => parseTimestampMs(m.created_at)

function participantsOf(input: SummaryInput): ParticipantSummary[] {
  const humanIds = new Set<string>()
  const isHuman = (id: string | null): id is string => id !== null && !input.botProfileIds.has(id)
  for (const m of input.messages) if (isHuman(m.profile_id)) humanIds.add(m.profile_id)
  for (const e of input.clientEvents) if (isHuman(e.profile_id)) humanIds.add(e.profile_id)
  for (const id of input.feedbackProfileIds) if (isHuman(id)) humanIds.add(id)

  return [...humanIds].map((profileId) => {
    const own = input.messages.filter((m) => m.profile_id === profileId)
    const chats = own.filter((m) => m.kind === 'chat').map(timeOf)
    // "First seen" = proof the app was open: their "joined" notice or any app event.
    // Their own chat messages don't count, or time-to-first-message would always be 0.
    const seen = [
      ...own.filter((m) => m.kind === 'system').map(timeOf),
      ...input.clientEvents.filter((e) => e.profile_id === profileId).map((e) => parseTimestampMs(e.server_ts)),
    ]
    const firstSeenAt = seen.length > 0 ? Math.min(...seen) : null
    const firstMessageAt = chats.length > 0 ? Math.min(...chats) : null
    return {
      profileId,
      name: input.names.get(profileId) ?? `${profileId.slice(0, 8)}…`,
      messages: chats.length,
      firstSeenAt,
      firstMessageAt,
      timeToFirstMessageMs:
        firstSeenAt !== null && firstMessageAt !== null && firstSeenAt <= firstMessageAt
          ? firstMessageAt - firstSeenAt
          : null,
    }
  })
}

function silencesOf(input: SummaryInput): SessionSummary['silences'] {
  const chats = input.messages.filter((m) => m.kind === 'chat')
  const rooms = new Map<string, SummaryMessage[]>()
  for (const m of chats) rooms.set(m.room_id, [...(rooms.get(m.room_id) ?? []), m])

  let count = 0
  let longestMs = 0
  for (const list of rooms.values()) {
    const times = list.map(timeOf).sort((a, b) => a - b)
    for (let i = 1; i < times.length; i++) {
      const gap = (times[i] as number) - (times[i - 1] as number)
      if (gap >= AI_RULES.silenceMs) count += 1
      longestMs = Math.max(longestMs, gap)
    }
  }

  const byId = new Map(chats.map((m) => [m.id, m]))
  const breaks = input.aiEvents
    .filter((e) => e.trigger === 'silence' && e.decision === 'spoke' && e.message_id !== null)
    .map((e) => byId.get(e.message_id as number))
    .filter((m): m is SummaryMessage => m !== undefined)
  const answered = breaks.filter((hostMessage) => {
    const at = timeOf(hostMessage)
    return chats.some(
      (m) =>
        m.room_id === hostMessage.room_id &&
        m.profile_id !== null &&
        !input.botProfileIds.has(m.profile_id) &&
        timeOf(m) > at &&
        timeOf(m) - at <= REVIVAL_WINDOW_MS,
    )
  }).length

  return {
    count,
    longestMs,
    hostBreaks: breaks.length,
    hostBreaksAnswered: answered,
    answeredRate: breaks.length > 0 ? answered / breaks.length : null,
  }
}

function aiOf(events: readonly SummaryAiEvent[]): SessionSummary['ai'] {
  let skippedByReason: Record<string, number> = {}
  let byTrigger: Record<string, { spoke: number; skipped: number }> = {}
  let errorCodes: Record<string, number> = {}
  for (const e of events) {
    const current = byTrigger[e.trigger] ?? { spoke: 0, skipped: 0 }
    byTrigger = {
      ...byTrigger,
      [e.trigger]: e.decision === 'spoke' ? { ...current, spoke: current.spoke + 1 } : { ...current, skipped: current.skipped + 1 },
    }
    if (e.decision === 'skipped') skippedByReason = increment(skippedByReason, e.reason ?? 'unknown')
    if (e.error_code) errorCodes = increment(errorCodes, e.error_code)
  }
  const llm = events.filter((e) => e.llm_attempted)
  return {
    triggers: events.length,
    spoke: events.filter((e) => e.decision === 'spoke').length,
    skippedByReason,
    byTrigger,
    llmCalls: llm.length,
    llmErrors: llm.filter((e) => e.error_code !== null).length,
    fallbacks: events.filter((e) => e.fallback_used).length,
    errorCodes,
    llmLatency: distribution(llm.map((e) => e.latency_ms).filter((v): v is number => typeof v === 'number')),
    promptTokens: llm.reduce((sum, e) => sum + (e.prompt_tokens ?? 0), 0),
    completionTokens: llm.reduce((sum, e) => sum + (e.completion_tokens ?? 0), 0),
  }
}

function clientErrorsOf(events: readonly SummaryClientEvent[]): Record<string, number> {
  let counts: Record<string, number> = {}
  for (const e of events) {
    if (ERROR_TYPES.has(e.type)) counts = increment(counts, e.type)
    if (e.type === 'realtime_status' && BAD_CHANNEL_STATES.has(String(e.data?.status))) {
      counts = increment(counts, `realtime_${String(e.data?.status).toLowerCase()}`)
    }
  }
  return counts
}

function recoveredOf(events: readonly SummaryClientEvent[]): Record<string, number> {
  let counts: Record<string, number> = {}
  for (const e of events) {
    const added = e.type === 'catchup' ? Number(e.data?.added ?? 0) : 0
    if (added > 0) counts = { ...counts, [String(e.data?.reason ?? 'unknown')]: (counts[String(e.data?.reason ?? 'unknown')] ?? 0) + added }
  }
  return counts
}

function latencySamples(events: readonly SummaryClientEvent[]): number[] {
  return events
    .filter((e) => e.type === 'latency_batch')
    .flatMap((e) => {
      const samples: unknown = e.data?.samples_ms
      return Array.isArray(samples) ? samples.filter((v): v is number => typeof v === 'number') : []
    })
}

export function summarizeSession(input: SummaryInput): SessionSummary {
  const participants = participantsOf(input).sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name))
  const chats = input.messages.filter((m) => m.kind === 'chat')
  const ai = chats.filter((m) => m.profile_id !== null && input.botProfileIds.has(m.profile_id)).length
  const human = chats.length - ai
  const firstMessageTimes = participants
    .map((p) => p.timeToFirstMessageMs)
    .filter((v): v is number => v !== null)

  return {
    participants,
    neverSpoke: participants.filter((p) => p.messages === 0).map((p) => p.name),
    messages: {
      human,
      ai,
      system: input.messages.length - chats.length,
      aiShare: chats.length > 0 ? ai / chats.length : null,
    },
    medianTimeToFirstMessageMs: median(firstMessageTimes),
    silences: silencesOf(input),
    ai: aiOf(input.aiEvents),
    clientErrors: clientErrorsOf(input.clientEvents),
    recovered: recoveredOf(input.clientEvents),
    latency: distribution(latencySamples(input.clientEvents)),
  }
}
