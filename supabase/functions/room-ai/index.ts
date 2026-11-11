/**
 * room-ai — the AI host.
 *
 * The app calls this function in three situations:
 *   • mention — someone wrote "@Theo …"     body: { room_id, trigger: 'mention', message_id }
 *   • silence — a phone's 45 s quiet timer fired (every phone calls; the lock picks one)
 *   • join    — someone joined for the first time (template welcome, no LLM call)
 *
 * Steps: who is calling → read a snapshot of the room → cheap rules → take the
 * room lock → re-check the rules on fresh data → write the reply (LLM, or the
 * question bank if the LLM fails) → post it → log one row in ai_events.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import {
  AI_RULES,
  blockerUnderLock,
  parseTriggerInput,
  planTrigger,
  retryAfterMs,
  type RoomSnapshot,
  type SkipReason,
  type SpeakPlan,
  type Trigger,
  type TriggerInput,
} from '../_shared/ai-rules.ts'
import { callChatCompletion, resolveLlmConfig } from '../_shared/llm.ts'
import {
  buildLlmMessages,
  cleanReply,
  fallbackMessage,
  pickQuestion,
  welcomeMessage,
  type Question,
} from '../_shared/reply.ts'
import { snapshotFromJson } from '../_shared/snapshot.ts'

const FUNCTION_VERSION = 'room-ai@0.1.0'
const QUESTION_CACHE_MS = 5 * 60_000

function requireEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`Missing environment variable ${name}`)
  return value
}

// Supabase provides these two automatically, locally and when deployed.
// The service role bypasses RLS: it can read personas and the question bank.
const db = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

interface ReplyMeta {
  llmAttempted: boolean
  provider: string | null
  model: string | null
  latencyMs: number | null
  promptTokens: number | null
  completionTokens: number | null
  fallbackUsed: boolean
  errorCode: string | null
}

interface Outcome extends ReplyMeta {
  input: TriggerInput
  callerId: string
  decision: 'spoke' | 'skipped'
  reason: SkipReason | null
  botId: string | null
  messageId: number | null
  retryAfterMs: number | null
}

const NO_LLM: ReplyMeta = {
  llmAttempted: false,
  provider: null,
  model: null,
  latencyMs: null,
  promptTokens: null,
  completionTokens: null,
  fallbackUsed: false,
  errorCode: null,
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const callerId = await authenticate(req)
  if (!callerId) return json({ error: 'unauthorized' }, 401)

  const parsed = parseTriggerInput(await req.json().catch(() => null))
  if (!parsed.ok) return json({ error: parsed.error }, 400)

  const outcome = await runTrigger(parsed.value, callerId)
  await logAiEvent(outcome)

  // Same answer whatever happened, so a curious tester's network tab cannot
  // reveal which members are AI. The details live in ai_events (admins only).
  return json(outcome.retryAfterMs ? { ok: true, retry_after_ms: outcome.retryAfterMs } : { ok: true })
})

/** Checks the caller's access token with Supabase Auth (works with any JWT signing key type). */
async function authenticate(req: Request): Promise<string | null> {
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const { data, error } = await db.auth.getUser(token)
  if (error || !data.user) return null
  return data.user.id
}

async function runTrigger(input: TriggerInput, callerId: string): Promise<Outcome> {
  const outcome: Outcome = {
    ...NO_LLM,
    input,
    callerId,
    decision: 'skipped',
    reason: null,
    botId: null,
    messageId: null,
    retryAfterMs: null,
  }
  try {
    const before = await loadSnapshot(input, callerId)
    const plan = planTrigger(input.trigger, before)
    if (plan.action === 'skip') return { ...outcome, reason: plan.reason, botId: plan.bot?.id ?? null }

    const token = await tryLock(input.roomId)
    if (!token) {
      return {
        ...outcome,
        reason: 'lock_busy',
        botId: plan.bot.id,
        retryAfterMs: input.trigger === 'join' ? retryAfterMs(before) : null,
      }
    }
    return await speakHoldingLock({ ...outcome, botId: plan.bot.id }, plan, token)
  } catch (error) {
    console.error('room-ai failed', error)
    return { ...outcome, reason: 'internal_error', errorCode: 'exception' }
  }
}

async function speakHoldingLock(outcome: Outcome, plan: SpeakPlan, token: string): Promise<Outcome> {
  const { input, callerId } = outcome
  let posted = false
  try {
    const snap = await loadSnapshot(input, callerId) // fresh data, read under the lock
    const blocker = blockerUnderLock(input.trigger, plan, snap)
    if (blocker) return { ...outcome, reason: blocker }

    if (input.trigger === 'join' && !(await claimWelcome(input.roomId, callerId))) {
      return { ...outcome, reason: 'already_welcomed' }
    }

    const reply = await composeReply(input.trigger, plan, snap)
    const message = await postMessage(input.roomId, plan.bot.profileId, reply.text, token)
    if (!message) return { ...outcome, ...reply.meta, reason: 'lock_lost' }
    posted = true
    return { ...outcome, ...reply.meta, decision: 'spoke', reason: null, messageId: message.id }
  } finally {
    // Stayed quiet after all? Hand the lock back so the next trigger is not blocked.
    if (!posted) await releaseLock(input.roomId, token)
  }
}

async function composeReply(
  trigger: Trigger,
  plan: SpeakPlan,
  snap: RoomSnapshot,
): Promise<{ text: string; meta: ReplyMeta }> {
  const room = snap.room ?? { name: 'this room', topic: 'anything', tags: [] }
  const question = async (): Promise<Question | null> =>
    pickQuestion(await loadQuestions(), {
      roomTags: room.tags,
      language: plan.bot.language,
      recentTexts: snap.recentChat.map((m) => m.content),
    })

  if (plan.mode === 'template') {
    return { text: welcomeMessage(snap.caller?.displayName ?? 'there', await question()), meta: NO_LLM }
  }

  const config = resolveLlmConfig((name) => Deno.env.get(name))
  if (config.warning) console.warn(config.warning)
  const context = snap.recentChat.slice(-AI_RULES.contextMessages)
  const result = await callChatCompletion(
    config,
    buildLlmMessages(trigger, room, plan.bot, context, snap.triggerMessage),
  )
  const meta: ReplyMeta = {
    llmAttempted: true,
    provider: config.provider,
    model: config.model,
    latencyMs: result.latencyMs,
    promptTokens: result.ok ? result.promptTokens : null,
    completionTokens: result.ok ? result.completionTokens : null,
    fallbackUsed: false,
    errorCode: result.ok ? null : result.errorCode,
  }

  if (result.ok) {
    const text = cleanReply(result.text, { botName: plan.bot.displayName, bannedWords: plan.bot.bannedWords })
    if (text) return { text, meta }
  }
  // Never show an error in the chat: ask a question from the bank instead.
  return {
    text: fallbackMessage(trigger, await question()),
    meta: { ...meta, fallbackUsed: true, errorCode: meta.errorCode ?? 'unusable_reply' },
  }
}

// ── Database calls ───────────────────────────────────────────────────────────

async function loadSnapshot(input: TriggerInput, callerId: string): Promise<RoomSnapshot> {
  const { data, error } = await db.rpc('ai_room_context', {
    p_room_id: input.roomId,
    p_caller_id: callerId,
    p_message_id: input.messageId,
  })
  if (error) throw new Error(`ai_room_context: ${error.message}`)
  return snapshotFromJson(data)
}

async function tryLock(roomId: string): Promise<string | null> {
  const { data, error } = await db.rpc('ai_try_lock', { p_room_id: roomId })
  if (error) throw new Error(`ai_try_lock: ${error.message}`)
  return typeof data === 'string' ? data : null
}

async function releaseLock(roomId: string, token: string): Promise<void> {
  const { error } = await db.rpc('ai_release_lock', { p_room_id: roomId, p_token: token })
  if (error) console.error('ai_release_lock failed', error.message)
}

async function claimWelcome(roomId: string, profileId: string): Promise<boolean> {
  const { data, error } = await db.rpc('ai_claim_welcome', { p_room_id: roomId, p_profile_id: profileId })
  if (error) throw new Error(`ai_claim_welcome: ${error.message}`)
  return data === true
}

async function postMessage(
  roomId: string,
  profileId: string,
  content: string,
  token: string,
): Promise<{ id: number } | null> {
  const { data, error } = await db.rpc('ai_post_message', {
    p_room_id: roomId,
    p_profile_id: profileId,
    p_content: content,
    p_token: token,
  })
  if (error) throw new Error(`ai_post_message: ${error.message}`)
  const id = (data as { id?: unknown } | null)?.id
  return typeof id === 'number' ? { id } : null
}

let questionCache: { loadedAt: number; list: Question[] } | null = null

async function loadQuestions(): Promise<Question[]> {
  if (questionCache && Date.now() - questionCache.loadedAt < QUESTION_CACHE_MS) return questionCache.list
  const { data, error } = await db
    .from('question_bank')
    .select('id, text, tags, language')
    .eq('is_active', true)
    .limit(1000)
  if (error) {
    console.error('question_bank read failed', error.message)
    return questionCache?.list ?? []
  }
  questionCache = { loadedAt: Date.now(), list: (data ?? []) as Question[] }
  return questionCache.list
}

async function logAiEvent(o: Outcome): Promise<void> {
  if (o.reason === 'room_not_found') return // nothing to attach the row to
  const { error } = await db.from('ai_events').insert({
    room_id: o.input.roomId,
    trigger: o.input.trigger,
    caller_id: o.callerId,
    trigger_message_id: o.reason === 'bad_trigger_message' ? null : o.input.messageId,
    bot_id: o.botId,
    decision: o.decision,
    reason: o.reason,
    message_id: o.messageId,
    llm_attempted: o.llmAttempted,
    provider: o.provider,
    model: o.model,
    latency_ms: o.latencyMs,
    prompt_tokens: o.promptTokens,
    completion_tokens: o.completionTokens,
    fallback_used: o.fallbackUsed,
    error_code: o.errorCode,
    function_version: FUNCTION_VERSION,
  })
  if (error) console.error('ai_events insert failed', error.message)
}
