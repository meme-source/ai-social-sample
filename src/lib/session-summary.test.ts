import { describe, expect, it } from 'vitest'
import {
  summarizeSession,
  type SummaryAiEvent,
  type SummaryClientEvent,
  type SummaryInput,
  type SummaryMessage,
} from './session-summary.ts'

const T0 = Date.parse('2026-11-10T12:00:00Z')
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString()
const ROOM = 'room-1'
const HOST = 'p-lena'

let nextId = 1
const message = (profileId: string | null, seconds: number, kind: 'chat' | 'system' = 'chat'): SummaryMessage => ({
  id: nextId++,
  room_id: ROOM,
  profile_id: profileId,
  kind,
  created_at: at(seconds),
})

const aiEvent = (overrides: Partial<SummaryAiEvent>): SummaryAiEvent => ({
  room_id: ROOM,
  trigger: 'mention',
  decision: 'spoke',
  reason: null,
  message_id: null,
  llm_attempted: true,
  fallback_used: false,
  error_code: null,
  latency_ms: 800,
  prompt_tokens: 100,
  completion_tokens: 20,
  ...overrides,
})

const clientEvent = (profileId: string, type: string, seconds: number, data: Record<string, unknown> = {}): SummaryClientEvent => ({
  profile_id: profileId,
  room_id: ROOM,
  type,
  data,
  server_ts: at(seconds),
})

function input(overrides: Partial<SummaryInput>): SummaryInput {
  return {
    messages: [],
    botProfileIds: new Set([HOST]),
    names: new Map([
      ['p-ana', 'Ana'],
      ['p-bo', 'Bo'],
      ['p-cy', 'Cy'],
    ]),
    aiEvents: [],
    clientEvents: [],
    feedbackProfileIds: [],
    ...overrides,
  }
}

describe('summarizeSession', () => {
  it('counts messages per person, AI share and who never spoke', () => {
    const summary = summarizeSession(
      input({
        messages: [
          message('p-ana', 0, 'system'), // "Ana joined"
          message('p-ana', 10),
          message('p-ana', 20),
          message(HOST, 25),
          message('p-bo', 30),
        ],
        clientEvents: [clientEvent('p-cy', 'room_enter', 5)], // Cy opened the room but never wrote
      }),
    )
    expect(summary.participants.map((p) => [p.name, p.messages])).toEqual([
      ['Ana', 2],
      ['Bo', 1],
      ['Cy', 0],
    ])
    expect(summary.neverSpoke).toEqual(['Cy'])
    expect(summary.messages).toEqual({ human: 3, ai: 1, system: 1, aiShare: 0.25 })
  })

  it('measures time from first seen to first message', () => {
    const summary = summarizeSession(
      input({
        messages: [message('p-ana', 40)],
        clientEvents: [clientEvent('p-ana', 'room_enter', 10)],
      }),
    )
    expect(summary.participants[0]?.timeToFirstMessageMs).toBe(30_000)
    expect(summary.medianTimeToFirstMessageMs).toBe(30_000)
  })

  it('leaves time-to-first-message unknown when nothing shows the app was open first', () => {
    const summary = summarizeSession(
      input({
        messages: [message('p-bo', 40)], // only a message, no "joined" notice or app event before it
        clientEvents: [clientEvent('p-bo', 'latency_batch', 90)], // app activity, but after the message
      }),
    )
    expect(summary.participants[0]?.timeToFirstMessageMs).toBeNull()
    expect(summary.medianTimeToFirstMessageMs).toBeNull()
  })

  it('finds silences and whether a human answered the host within 60 s', () => {
    const hostAnswered = message(HOST, 100) // after a 100 s silence
    const humanReply = message('p-bo', 130)
    const hostIgnored = message(HOST, 300) // after a 170 s silence, nobody replies in time
    const lateReply = message('p-ana', 400)
    const summary = summarizeSession(
      input({
        messages: [message('p-ana', 0), hostAnswered, humanReply, hostIgnored, lateReply],
        aiEvents: [
          aiEvent({ trigger: 'silence', message_id: hostAnswered.id }),
          aiEvent({ trigger: 'silence', message_id: hostIgnored.id }),
        ],
      }),
    )
    expect(summary.silences).toEqual({
      count: 3, // 0→100, 130→300, 300→400
      longestMs: 170_000,
      hostBreaks: 2,
      hostBreaksAnswered: 1,
      answeredRate: 0.5,
    })
  })

  it('summarises AI decisions, fallbacks and LLM errors', () => {
    const summary = summarizeSession(
      input({
        aiEvents: [
          aiEvent({}),
          aiEvent({ decision: 'skipped', reason: 'lock_busy', llm_attempted: false, latency_ms: null }),
          aiEvent({ trigger: 'silence', decision: 'skipped', reason: 'ratio_cap', llm_attempted: false }),
          aiEvent({ fallback_used: true, error_code: 'auth', latency_ms: 200 }),
          aiEvent({ trigger: 'join', llm_attempted: false, latency_ms: null, prompt_tokens: null }),
        ],
      }),
    )
    expect(summary.ai).toMatchObject({
      triggers: 5,
      spoke: 3,
      skippedByReason: { lock_busy: 1, ratio_cap: 1 },
      byTrigger: { mention: { spoke: 2, skipped: 1 }, silence: { spoke: 0, skipped: 1 }, join: { spoke: 1, skipped: 0 } },
      llmCalls: 2,
      llmErrors: 1,
      fallbacks: 1,
      errorCodes: { auth: 1 },
      promptTokens: 200,
      completionTokens: 40,
    })
    expect(summary.ai.llmLatency).toMatchObject({ n: 2, p50: 500 })
  })

  it('collects client errors and delivery latency', () => {
    const summary = summarizeSession(
      input({
        clientEvents: [
          clientEvent('p-ana', 'js_error', 1),
          clientEvent('p-ana', 'request_failed', 2),
          clientEvent('p-bo', 'realtime_status', 3, { status: 'CHANNEL_ERROR' }),
          clientEvent('p-bo', 'realtime_status', 4, { status: 'SUBSCRIBED' }),
          clientEvent('p-ana', 'latency_batch', 5, { samples_ms: [100, 200, 300] }),
          clientEvent('p-bo', 'latency_batch', 6, { samples_ms: [400, 'x'] }),
        ],
      }),
    )
    expect(summary.clientErrors).toEqual({ js_error: 1, request_failed: 1, realtime_channel_error: 1 })
    expect(summary.recovered).toEqual({})
    expect(summary.latency).toMatchObject({ n: 4, p50: 250, max: 400 })
  })

  it('counts messages that catch-ups recovered after realtime missed them', () => {
    const summary = summarizeSession(
      input({
        clientEvents: [
          clientEvent('p-ana', 'catchup', 1, { reason: 'visible', added: 3, overlap: 20 }),
          clientEvent('p-bo', 'catchup', 2, { reason: 'poll', added: 1 }),
          clientEvent('p-bo', 'catchup', 3, { reason: 'visible', added: 0 }),
        ],
      }),
    )
    expect(summary.recovered).toEqual({ visible: 3, poll: 1 })
  })

  it('handles an empty session', () => {
    const summary = summarizeSession(input({}))
    expect(summary.participants).toEqual([])
    expect(summary.messages.aiShare).toBeNull()
    expect(summary.silences.answeredRate).toBeNull()
    expect(summary.latency.n).toBe(0)
  })
})
