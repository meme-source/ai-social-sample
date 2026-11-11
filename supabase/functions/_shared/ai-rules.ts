/**
 * The AI host's speaking rules, written as plain functions with no database or
 * network access, so they can be unit-tested and read like a rulebook.
 *
 * Used by the room-ai Edge Function (Deno). The web app imports the shared
 * constants and the @mention matcher from here too, so both sides agree.
 */

export const AI_RULES = {
  /** Quiet time before the host breaks a silence. */
  silenceMs: 45_000,
  /** Slack for the difference between a phone's clock and the server's. */
  silenceToleranceMs: 2_000,
  /** One AI turn holds the room's lock this long (also written in SQL: ai_try_lock). */
  lockSeconds: 15,
  /** The AI may write at most ratioMaxAi of any ratioWindow chat messages in a row: 4 of 12 = 1/3. */
  ratioWindow: 12,
  ratioMaxAi: 4,
  /** LLM calls allowed per room in any rolling hour. */
  llmCallsPerRoomPerHour: 60,
  /** A mention older than this is ignored (stops replays of old messages). */
  mentionMaxAgeMs: 120_000,
  /** Someone who joined longer ago than this gets no welcome. */
  joinMaxAgeMs: 10 * 60_000,
  /** How many recent messages the LLM sees. */
  contextMessages: 20,
} as const

export const TRIGGERS = ['mention', 'silence', 'join'] as const
export type Trigger = (typeof TRIGGERS)[number]

export type SkipReason =
  | 'room_not_found'
  | 'not_member' // the caller is not in the room
  | 'no_host' // the room has no active AI host
  | 'bad_trigger_message'
  | 'not_a_bot' // a mention, but of a human
  | 'stale' // an old mention or an old join
  | 'already_replied' // this mention was already answered
  | 'already_welcomed'
  | 'no_human_online'
  | 'ai_spoke_last' // the host already broke this silence; wait for a human
  | 'not_silent' // someone spoke less than 45 s ago
  | 'lock_busy' // another AI turn is in progress (this is the dedupe)
  | 'ratio_cap' // one more AI message would exceed 1/3 of the last 12
  | 'budget_cap' // 60 LLM calls in this room in the last hour
  | 'lock_lost'
  | 'internal_error'

export interface BotPersona {
  id: string
  profileId: string
  displayName: string
  role: 'host' | 'participant'
  language: string
  tags: string[]
  activityLevel: number
  professionalism: number
  bannedWords: string[]
  customChatStyle: string
}

export interface SnapshotMessage {
  id: number
  profileId: string | null
  kind: 'chat' | 'system'
  content: string
  createdAtMs: number
  displayName: string
  isAi: boolean
  mentions: string[]
}

/** Everything the rules need, read from the database in one go. */
export interface RoomSnapshot {
  nowMs: number
  room: { id: string; name: string; topic: string; tags: string[]; aiLockUntilMs: number | null } | null
  bots: BotPersona[]
  /** Chat messages only, oldest first, at most 20. */
  recentChat: SnapshotMessage[]
  /** The newest message of any kind (chat or "X joined"). */
  latest: { id: number; kind: 'chat' | 'system'; isAi: boolean; createdAtMs: number } | null
  triggerMessage: SnapshotMessage | null
  alreadyReplied: boolean
  humansOnline: number
  caller: { joinedAtMs: number; welcomedAtMs: number | null; displayName: string } | null
  llmCallsLastHour: number
}

export type SpeakPlan = { action: 'speak'; bot: BotPersona; mode: 'llm' | 'template' }
export type SkipPlan = { action: 'skip'; reason: SkipReason; bot: BotPersona | null }
export type Plan = SpeakPlan | SkipPlan

const skip = (reason: SkipReason, bot: BotPersona | null = null): SkipPlan => ({ action: 'skip', reason, bot })

export function hostOf(bots: readonly BotPersona[]): BotPersona | null {
  return bots.find((b) => b.role === 'host') ?? null
}

/** The first AI member a message mentions, in the order they were mentioned. */
export function mentionedBot(message: SnapshotMessage, bots: readonly BotPersona[]): BotPersona | null {
  for (const id of message.mentions) {
    const bot = bots.find((b) => b.profileId === id)
    if (bot) return bot
  }
  return null
}

/** How many of the last `n` chat messages were written by AI members. */
export function aiCountInLast(recentChat: readonly SnapshotMessage[], n: number): number {
  return recentChat.slice(-n).filter((m) => m.isAi).length
}

/**
 * May the AI add one more message? Yes if the last 11 chat messages hold
 * fewer than 4 AI messages — then every 12-message window stays at ≤ 4 AI (≤ 1/3).
 */
export function ratioAllows(recentChat: readonly SnapshotMessage[]): boolean {
  return aiCountInLast(recentChat, AI_RULES.ratioWindow - 1) < AI_RULES.ratioMaxAi
}

/** Is the room quiet enough for the host to speak? Returns why not, or null. */
export function silenceBlocker(snap: RoomSnapshot): SkipReason | null {
  const latest = snap.latest
  if (!latest) return null // an empty room: the host may open the conversation
  if (latest.isAi) return 'ai_spoke_last'
  if (snap.nowMs - latest.createdAtMs < AI_RULES.silenceMs - AI_RULES.silenceToleranceMs) return 'not_silent'
  return null
}

/** Step 1 — cheap rules, checked before taking the lock. */
export function planTrigger(trigger: Trigger, snap: RoomSnapshot): Plan {
  if (!snap.room) return skip('room_not_found')
  if (!snap.caller) return skip('not_member')
  if (trigger === 'mention') return planMention(snap)
  if (trigger === 'silence') return planSilence(snap)
  return planJoin(snap)
}

function planMention(snap: RoomSnapshot): Plan {
  const message = snap.triggerMessage
  if (!message || message.kind !== 'chat' || message.isAi) return skip('bad_trigger_message')
  const bot = mentionedBot(message, snap.bots)
  if (!bot) return skip('not_a_bot')
  if (snap.nowMs - message.createdAtMs > AI_RULES.mentionMaxAgeMs) return skip('stale', bot)
  if (snap.alreadyReplied) return skip('already_replied', bot)
  return { action: 'speak', bot, mode: 'llm' }
}

function planSilence(snap: RoomSnapshot): Plan {
  const host = hostOf(snap.bots)
  if (!host) return skip('no_host')
  if (snap.humansOnline < 1) return skip('no_human_online', host)
  const blocker = silenceBlocker(snap)
  if (blocker) return skip(blocker, host)
  return { action: 'speak', bot: host, mode: 'llm' }
}

function planJoin(snap: RoomSnapshot): Plan {
  const host = hostOf(snap.bots)
  if (!host || !snap.caller) return skip('no_host')
  if (snap.caller.welcomedAtMs !== null) return skip('already_welcomed', host)
  if (snap.nowMs - snap.caller.joinedAtMs > AI_RULES.joinMaxAgeMs) return skip('stale', host)
  return { action: 'speak', bot: host, mode: 'template' }
}

/**
 * Step 2 — rules checked while holding the lock, on a fresh snapshot. Only one
 * AI turn per room can be here at a time, so these counts cannot race.
 */
export function blockerUnderLock(trigger: Trigger, plan: SpeakPlan, snap: RoomSnapshot): SkipReason | null {
  if (trigger === 'silence') {
    const blocker = silenceBlocker(snap)
    if (blocker) return blocker
  }
  if (trigger === 'mention' && snap.alreadyReplied) return 'already_replied'
  if (!ratioAllows(snap.recentChat)) return 'ratio_cap'
  if (plan.mode === 'llm' && snap.llmCallsLastHour >= AI_RULES.llmCallsPerRoomPerHour) return 'budget_cap'
  return null
}

/** When a welcome hits a busy lock, tell the joining phone when to try again. */
export function retryAfterMs(snap: RoomSnapshot): number {
  const until = snap.room?.aiLockUntilMs ?? null
  if (until === null || until <= snap.nowMs) return 1_000
  return until - snap.nowMs + 500
}

// ── Input validation ─────────────────────────────────────────────────────────

export interface TriggerInput {
  roomId: string
  trigger: Trigger
  messageId: number | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseTriggerInput(body: unknown): { ok: true; value: TriggerInput } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be a JSON object' }
  const { room_id: roomId, trigger, message_id: messageId } = body as Record<string, unknown>
  if (typeof roomId !== 'string' || !UUID.test(roomId)) return { ok: false, error: 'room_id must be a uuid' }
  if (typeof trigger !== 'string' || !(TRIGGERS as readonly string[]).includes(trigger)) {
    return { ok: false, error: `trigger must be one of ${TRIGGERS.join(', ')}` }
  }
  const hasMessageId = messageId !== undefined && messageId !== null
  if (hasMessageId && !(Number.isSafeInteger(messageId) && (messageId as number) > 0)) {
    return { ok: false, error: 'message_id must be a positive integer' }
  }
  if (trigger === 'mention' && !hasMessageId) return { ok: false, error: 'mention needs message_id' }
  return {
    ok: true,
    value: { roomId, trigger: trigger as Trigger, messageId: hasMessageId ? (messageId as number) : null },
  }
}

// ── @mentions (shared with the web app) ──────────────────────────────────────

export interface MentionCandidate {
  profileId: string
  displayName: string
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

/**
 * Which members does `text` mention with "@Name"? Case-insensitive; longer
 * names win ("@Anna" is not "@Ann"); returned in the order they appear.
 */
export function findMentions(text: string, members: readonly MentionCandidate[], max = 10): string[] {
  let remaining = text.toLowerCase()
  const hits: { index: number; profileId: string }[] = []
  const byLength = [...members]
    .filter((m) => m.displayName.trim().length > 0)
    .sort((a, b) => b.displayName.length - a.displayName.length)

  for (const member of byLength) {
    const needle = `@${member.displayName.toLowerCase()}`
    let index = remaining.indexOf(needle)
    while (index !== -1) {
      const next = remaining[index + needle.length]
      if (next === undefined || !WORD_CHAR.test(next)) {
        hits.push({ index, profileId: member.profileId })
        // blank it out so a shorter name cannot match inside it
        remaining = remaining.slice(0, index) + ' '.repeat(needle.length) + remaining.slice(index + needle.length)
      }
      index = remaining.indexOf(needle, index + 1)
    }
  }

  const ordered = hits.sort((a, b) => a.index - b.index).map((h) => h.profileId)
  return [...new Set(ordered)].slice(0, max)
}
