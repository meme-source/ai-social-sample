import { describe, expect, it } from 'vitest'
import { snapshotFromJson } from './snapshot.ts'
import { parseTimestampMs } from './time.ts'

describe('parseTimestampMs', () => {
  it('reads Postgres timestamps with microseconds and short offsets', () => {
    const expected = Date.parse('2026-11-10T12:00:00.123Z')
    expect(parseTimestampMs('2026-11-10 12:00:00.123456+00')).toBe(expected)
    expect(parseTimestampMs('2026-11-10T12:00:00.123456+00:00')).toBe(expected)
    expect(parseTimestampMs('2026-11-10T20:00:00.123+08:00')).toBe(expected)
  })

  it('throws on garbage', () => {
    expect(() => parseTimestampMs('yesterday')).toThrow(/Unreadable/)
  })
})

describe('snapshotFromJson', () => {
  it('maps the SQL function output into the typed snapshot', () => {
    const snap = snapshotFromJson({
      now: '2026-11-10T12:00:00+00:00',
      room: { id: 'r1', name: 'Pop', topic: 'pop', tags: ['pop'], ai_lock_until: null },
      bots: [
        {
          id: 'b1',
          profile_id: 'p1',
          role: 'host',
          language: 'en',
          tags: [],
          activity_level: 3,
          professionalism: 1,
          banned_words: ['x'],
          custom_chat_style: 'kind',
          display_name: 'Lena',
        },
      ],
      recent_chat: [
        {
          id: 7,
          profile_id: 'p2',
          kind: 'chat',
          content: 'hi',
          created_at: '2026-11-10T11:59:00+00:00',
          mentions: ['p1'],
          display_name: 'Ana',
          is_ai: false,
        },
      ],
      latest: { id: 7, kind: 'chat', created_at: '2026-11-10T11:59:00+00:00', is_ai: false },
      trigger_message: null,
      already_replied: false,
      humans_online: 2,
      caller: { is_member: true, joined_at: '2026-11-10T11:00:00+00:00', welcomed_at: null, display_name: 'Ana' },
      llm_calls_last_hour: 5,
    })

    expect(snap.nowMs).toBe(Date.parse('2026-11-10T12:00:00Z'))
    expect(snap.bots[0]).toMatchObject({ profileId: 'p1', role: 'host', activityLevel: 3, bannedWords: ['x'] })
    expect(snap.recentChat[0]).toMatchObject({ id: 7, mentions: ['p1'], isAi: false })
    expect(snap.latest).toMatchObject({ id: 7, isAi: false })
    expect(snap.caller).toMatchObject({ welcomedAtMs: null, displayName: 'Ana' })
    expect(snap.humansOnline).toBe(2)
    expect(snap.llmCallsLastHour).toBe(5)
  })

  it('turns missing or malformed parts into safe defaults', () => {
    const snap = snapshotFromJson({ room: 'nope', bots: [{ id: 1 }], recent_chat: [{ id: 1 }], caller: null })
    expect(snap.room).toBeNull()
    expect(snap.bots).toEqual([])
    expect(snap.recentChat).toEqual([])
    expect(snap.caller).toBeNull()
    expect(snapshotFromJson(null).room).toBeNull()
  })
})
