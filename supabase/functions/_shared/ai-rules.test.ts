import { describe, expect, it } from 'vitest'
import {
  AI_RULES,
  aiCountInLast,
  blockerUnderLock,
  findMentions,
  parseTriggerInput,
  planTrigger,
  ratioAllows,
  retryAfterMs,
  type BotPersona,
  type RoomSnapshot,
  type SnapshotMessage,
  type SpeakPlan,
} from './ai-rules.ts'

const NOW = Date.parse('2026-11-10T12:00:00Z')
const ROOM_ID = '3f6c2a1e-9b7d-4c58-a0e2-5d1f8b7c4e93'

const host: BotPersona = {
  id: 'bot-host',
  profileId: 'p-lena',
  displayName: 'Lena',
  role: 'host',
  language: 'en',
  tags: ['pop'],
  activityLevel: 2,
  professionalism: 1,
  bannedWords: [],
  customChatStyle: '',
}
const theo: BotPersona = { ...host, id: 'bot-theo', profileId: 'p-theo', displayName: 'Theo', role: 'participant' }

let nextId = 1
function msg(overrides: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    id: nextId++,
    profileId: 'p-human',
    kind: 'chat',
    content: 'hello',
    createdAtMs: NOW - 60_000,
    displayName: 'Ana',
    isAi: false,
    mentions: [],
    ...overrides,
  }
}

function snapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    nowMs: NOW,
    room: { id: ROOM_ID, name: 'Pop Music Bot', topic: 'pop', tags: ['pop'], aiLockUntilMs: null },
    bots: [host, theo],
    recentChat: [],
    latest: null,
    triggerMessage: null,
    alreadyReplied: false,
    humansOnline: 2,
    caller: { joinedAtMs: NOW - 5_000, welcomedAtMs: null, displayName: 'Ana' },
    llmCallsLastHour: 0,
    ...overrides,
  }
}

/** A chat history where `aiPattern` marks which messages (oldest first) are AI. */
function history(aiPattern: boolean[]): SnapshotMessage[] {
  return aiPattern.map((isAi, i) =>
    msg({ isAi, profileId: isAi ? host.profileId : 'p-human', createdAtMs: NOW - (aiPattern.length - i) * 20_000 }),
  )
}

const latestOf = (m: SnapshotMessage): RoomSnapshot['latest'] => ({
  id: m.id,
  kind: m.kind,
  isAi: m.isAi,
  createdAtMs: m.createdAtMs,
})

describe('planTrigger — common rules', () => {
  it('skips when the room does not exist', () => {
    expect(planTrigger('silence', snapshot({ room: null }))).toMatchObject({ action: 'skip', reason: 'room_not_found' })
  })

  it('skips callers who are not members of the room', () => {
    expect(planTrigger('silence', snapshot({ caller: null }))).toMatchObject({ action: 'skip', reason: 'not_member' })
  })
})

describe('planTrigger — @mention', () => {
  it('lets the mentioned AI member reply with the LLM', () => {
    const trigger = msg({ mentions: ['p-theo'], createdAtMs: NOW - 1_000 })
    const plan = planTrigger('mention', snapshot({ triggerMessage: trigger }))
    expect(plan).toEqual({ action: 'speak', bot: theo, mode: 'llm' })
  })

  it('answers with the first AI member mentioned', () => {
    const trigger = msg({ mentions: ['p-other-human', 'p-lena', 'p-theo'], createdAtMs: NOW - 1_000 })
    expect(planTrigger('mention', snapshot({ triggerMessage: trigger }))).toMatchObject({ bot: host })
  })

  it('ignores mentions of humans', () => {
    const trigger = msg({ mentions: ['p-other-human'], createdAtMs: NOW - 1_000 })
    expect(planTrigger('mention', snapshot({ triggerMessage: trigger }))).toMatchObject({ reason: 'not_a_bot' })
  })

  it('ignores missing, system or AI-written trigger messages', () => {
    expect(planTrigger('mention', snapshot())).toMatchObject({ reason: 'bad_trigger_message' })
    const system = msg({ kind: 'system', mentions: ['p-theo'] })
    expect(planTrigger('mention', snapshot({ triggerMessage: system }))).toMatchObject({ reason: 'bad_trigger_message' })
    const fromAi = msg({ isAi: true, mentions: ['p-theo'] })
    expect(planTrigger('mention', snapshot({ triggerMessage: fromAi }))).toMatchObject({ reason: 'bad_trigger_message' })
  })

  it('ignores stale mentions and mentions that were already answered', () => {
    const old = msg({ mentions: ['p-theo'], createdAtMs: NOW - AI_RULES.mentionMaxAgeMs - 1 })
    expect(planTrigger('mention', snapshot({ triggerMessage: old }))).toMatchObject({ reason: 'stale' })
    const fresh = msg({ mentions: ['p-theo'], createdAtMs: NOW - 500 })
    expect(planTrigger('mention', snapshot({ triggerMessage: fresh, alreadyReplied: true }))).toMatchObject({
      reason: 'already_replied',
    })
  })
})

describe('planTrigger — silence', () => {
  it('lets the host break a 45 s silence after a human message', () => {
    const last = msg({ createdAtMs: NOW - AI_RULES.silenceMs })
    const plan = planTrigger('silence', snapshot({ latest: latestOf(last), recentChat: [last] }))
    expect(plan).toEqual({ action: 'speak', bot: host, mode: 'llm' })
  })

  it('tolerates a phone clock that is up to 2 s fast', () => {
    const last = msg({ createdAtMs: NOW - (AI_RULES.silenceMs - AI_RULES.silenceToleranceMs) })
    expect(planTrigger('silence', snapshot({ latest: latestOf(last) }))).toMatchObject({ action: 'speak' })
  })

  it('does not interrupt when someone spoke recently', () => {
    const last = msg({ createdAtMs: NOW - 30_000 })
    expect(planTrigger('silence', snapshot({ latest: latestOf(last) }))).toMatchObject({ reason: 'not_silent' })
  })

  it('does not speak twice in a row: waits for a human after the host spoke', () => {
    const last = msg({ isAi: true, profileId: host.profileId, createdAtMs: NOW - 120_000 })
    expect(planTrigger('silence', snapshot({ latest: latestOf(last) }))).toMatchObject({ reason: 'ai_spoke_last' })
  })

  it('may speak again once someone new joins after the host', () => {
    const joined = msg({ kind: 'system', content: 'Bo joined', createdAtMs: NOW - 50_000 })
    expect(planTrigger('silence', snapshot({ latest: latestOf(joined) }))).toMatchObject({ action: 'speak' })
  })

  it('may open an empty room', () => {
    expect(planTrigger('silence', snapshot({ latest: null }))).toMatchObject({ action: 'speak', bot: host })
  })

  it('stays quiet when no human is online', () => {
    expect(planTrigger('silence', snapshot({ humansOnline: 0 }))).toMatchObject({ reason: 'no_human_online' })
  })

  it('needs a host', () => {
    expect(planTrigger('silence', snapshot({ bots: [theo] }))).toMatchObject({ reason: 'no_host' })
  })
})

describe('planTrigger — join', () => {
  it('welcomes a new member with a template (no LLM)', () => {
    expect(planTrigger('join', snapshot())).toEqual({ action: 'speak', bot: host, mode: 'template' })
  })

  it('welcomes each member only once', () => {
    const caller = { joinedAtMs: NOW - 5_000, welcomedAtMs: NOW - 4_000, displayName: 'Ana' }
    expect(planTrigger('join', snapshot({ caller }))).toMatchObject({ reason: 'already_welcomed' })
  })

  it('does not welcome people who joined long ago', () => {
    const caller = { joinedAtMs: NOW - AI_RULES.joinMaxAgeMs - 1, welcomedAtMs: null, displayName: 'Ana' }
    expect(planTrigger('join', snapshot({ caller }))).toMatchObject({ reason: 'stale' })
  })
})

describe('ratio guard: AI ≤ 1/3 of the last 12 messages', () => {
  it('counts AI messages in the newest n chat messages', () => {
    expect(aiCountInLast(history([true, false, true, true]), 2)).toBe(2)
    expect(aiCountInLast(history([true, false, true, false]), 2)).toBe(1)
    expect(aiCountInLast(history([true, false, true, true]), 11)).toBe(3)
  })

  it('allows a 4th AI message among 12 (3 in the last 11)', () => {
    expect(ratioAllows(history([true, false, false, true, false, false, true, false, false, false, false]))).toBe(true)
  })

  it('blocks a 5th AI message among 12 (4 in the last 11)', () => {
    expect(ratioAllows(history([true, false, true, false, true, false, true, false, false, false, false]))).toBe(false)
  })

  it('only looks at the last 11 messages', () => {
    const old = [true, true, true, true] // pushed out of the window by 11 newer human messages
    expect(ratioAllows(history([...old, ...Array<boolean>(11).fill(false)]))).toBe(true)
  })

  it('allows the very first message in an empty room', () => {
    expect(ratioAllows([])).toBe(true)
  })
})

describe('blockerUnderLock (fresh data, holding the lock)', () => {
  const llmPlan: SpeakPlan = { action: 'speak', bot: host, mode: 'llm' }
  const templatePlan: SpeakPlan = { action: 'speak', bot: host, mode: 'template' }

  it('passes when every guard is clear', () => {
    expect(blockerUnderLock('mention', llmPlan, snapshot())).toBeNull()
  })

  it('re-checks silence: a human may have spoken while we waited for the lock', () => {
    const last = msg({ createdAtMs: NOW - 1_000 })
    expect(blockerUnderLock('silence', llmPlan, snapshot({ latest: latestOf(last) }))).toBe('not_silent')
  })

  it('applies the ratio cap to every trigger', () => {
    const busy = history([true, false, true, false, true, false, true])
    expect(blockerUnderLock('join', templatePlan, snapshot({ recentChat: busy }))).toBe('ratio_cap')
  })

  it('applies the hourly LLM budget only to LLM replies', () => {
    const spent = snapshot({ llmCallsLastHour: AI_RULES.llmCallsPerRoomPerHour })
    expect(blockerUnderLock('mention', llmPlan, spent)).toBe('budget_cap')
    expect(blockerUnderLock('join', templatePlan, spent)).toBeNull()
    expect(blockerUnderLock('mention', llmPlan, snapshot({ llmCallsLastHour: 59 }))).toBeNull()
  })

  it('does not answer the same mention twice', () => {
    expect(blockerUnderLock('mention', llmPlan, snapshot({ alreadyReplied: true }))).toBe('already_replied')
  })
})

describe('retryAfterMs', () => {
  it('waits until the lock frees up, plus a little', () => {
    const room = { id: ROOM_ID, name: 'x', topic: 'x', tags: [], aiLockUntilMs: NOW + 9_000 }
    expect(retryAfterMs(snapshot({ room }))).toBe(9_500)
  })

  it('retries soon when the lock already expired', () => {
    expect(retryAfterMs(snapshot())).toBe(1_000)
  })
})

describe('parseTriggerInput', () => {
  it('accepts a valid mention', () => {
    expect(parseTriggerInput({ room_id: ROOM_ID, trigger: 'mention', message_id: 42 })).toEqual({
      ok: true,
      value: { roomId: ROOM_ID, trigger: 'mention', messageId: 42 },
    })
  })

  it('accepts silence and join without a message id', () => {
    expect(parseTriggerInput({ room_id: ROOM_ID, trigger: 'silence' })).toMatchObject({ ok: true })
    expect(parseTriggerInput({ room_id: ROOM_ID, trigger: 'join', message_id: null })).toMatchObject({ ok: true })
  })

  it.each([
    [null, 'body must be a JSON object'],
    [{ room_id: 'nope', trigger: 'join' }, 'room_id must be a uuid'],
    [{ room_id: ROOM_ID, trigger: 'dance' }, 'trigger must be one of mention, silence, join'],
    [{ room_id: ROOM_ID, trigger: 'mention' }, 'mention needs message_id'],
    [{ room_id: ROOM_ID, trigger: 'mention', message_id: -1 }, 'message_id must be a positive integer'],
    [{ room_id: ROOM_ID, trigger: 'mention', message_id: '7' }, 'message_id must be a positive integer'],
  ])('rejects %j', (body, error) => {
    expect(parseTriggerInput(body)).toEqual({ ok: false, error })
  })
})

describe('findMentions', () => {
  const members = [
    { profileId: 'p-ann', displayName: 'Ann' },
    { profileId: 'p-anna', displayName: 'Anna' },
    { profileId: 'p-theo', displayName: 'Theo' },
    { profileId: 'p-mc', displayName: 'Mary Chen' },
  ]

  it('finds names case-insensitively, in the order they appear', () => {
    expect(findMentions('hey @theo and @ANN, thoughts?', members)).toEqual(['p-theo', 'p-ann'])
  })

  it('prefers the longer name: @Anna is not @Ann', () => {
    expect(findMentions('@Anna hi', members)).toEqual(['p-anna'])
  })

  it('handles names with spaces', () => {
    expect(findMentions('what do you think @Mary Chen?', members)).toEqual(['p-mc'])
  })

  it('needs a word boundary after the name', () => {
    expect(findMentions('@Theodore is not here', members)).toEqual([])
  })

  it('ignores names without @ and de-duplicates', () => {
    expect(findMentions('Theo! @Theo @theo', members)).toEqual(['p-theo'])
  })
})
