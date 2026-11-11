import { describe, expect, it } from 'vitest'
import {
  compareMessages,
  createPending,
  fromRow,
  isMessageRow,
  maxConfirmedId,
  mergeMessages,
  newestConfirmed,
  trimHistory,
  withStatus,
  type ChatMessage,
  type MessageRow,
} from './messages.ts'

const ROOM = 'room-1'
const T0 = Date.parse('2026-11-10T12:00:00Z')

function row(id: number, secondsAfterT0: number, extra: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    room_id: ROOM,
    profile_id: 'p-ana',
    kind: 'chat',
    content: `message ${id}`,
    client_msg_id: `cm-${id}`,
    mentions: [],
    created_at: new Date(T0 + secondsAfterT0 * 1000).toISOString(),
    ...extra,
  }
}

const saved = (id: number, s: number, extra: Partial<MessageRow> = {}): ChatMessage => fromRow(row(id, s, extra))
const ids = (list: readonly ChatMessage[]): (number | null)[] => list.map((m) => m.id)

describe('fromRow / isMessageRow', () => {
  it('converts Supabase rows and reads microsecond timestamps', () => {
    const m = fromRow(row(1, 0, { created_at: '2026-11-10 12:00:00.123456+00', mentions: null }))
    expect(m).toMatchObject({ id: 1, status: 'sent', mentions: [], createdAtMs: T0 + 123 })
  })

  it('rejects malformed realtime payloads', () => {
    expect(isMessageRow(row(1, 0))).toBe(true)
    expect(isMessageRow({ ...row(1, 0), id: '1' })).toBe(false)
    expect(isMessageRow(null)).toBe(false)
  })
})

describe('ordering', () => {
  it('sorts by server time, then id, with messages still sending last', () => {
    const pending = createPending({ roomId: ROOM, profileId: 'me', content: 'hi', clientMsgId: 'x', mentions: [], nowMs: 0 })
    const list = [saved(3, 5), pending, saved(2, 5), saved(1, 9)].sort(compareMessages)
    expect(ids(list)).toEqual([2, 3, 1, null])
  })

  it('finds the newest saved message and the largest id', () => {
    const list = [saved(10, 1), saved(4, 7)]
    expect(newestConfirmed(list)?.id).toBe(4)
    expect(maxConfirmedId(list)).toBe(10)
    expect(newestConfirmed([])).toBeNull()
    expect(maxConfirmedId([])).toBe(0)
  })
})

describe('mergeMessages', () => {
  it('adds new realtime messages in order', () => {
    const result = mergeMessages([saved(1, 0)], [saved(2, 1)], 'realtime')
    expect(ids(result.messages)).toEqual([1, 2])
    expect(result).toMatchObject({ added: 1, duplicates: 0, outOfOrder: 0 })
    expect(result.firstDeliveries.map((m) => m.id)).toEqual([2])
  })

  it('drops a message realtime delivers twice and counts it', () => {
    const once = mergeMessages([], [saved(5, 0)], 'realtime')
    const twice = mergeMessages(once.messages, [saved(5, 0)], 'realtime')
    expect(ids(twice.messages)).toEqual([5])
    expect(twice.duplicates).toBe(1)
    expect(twice.firstDeliveries).toEqual([])
  })

  it('treats the catch-up overlap as expected, not as duplicates', () => {
    const current = [saved(1, 0), saved(2, 1)]
    const result = mergeMessages(current, [saved(1, 0), saved(2, 1), saved(3, 2)], 'catchup')
    expect(ids(result.messages)).toEqual([1, 2, 3])
    expect(result).toMatchObject({ added: 1, overlap: 2, duplicates: 0 })
  })

  it('places a late message where it belongs and counts it as out of order', () => {
    const current = [saved(1, 0), saved(3, 10)]
    const result = mergeMessages(current, [saved(2, 4)], 'realtime')
    expect(ids(result.messages)).toEqual([1, 2, 3])
    expect(result.outOfOrder).toBe(1)
    expect(result.maxOutOfOrderMs).toBe(6_000)
  })

  it('does not call older catch-up messages out of order', () => {
    const result = mergeMessages([saved(9, 30)], [saved(8, 20)], 'catchup')
    expect(result.outOfOrder).toBe(0)
  })

  it('replaces my "sending…" bubble when the saved row arrives (send response first)', () => {
    const pending = createPending({ roomId: ROOM, profileId: 'me', content: 'hey', clientMsgId: 'cm-7', mentions: [], nowMs: 1 })
    const afterSend = mergeMessages([pending], [saved(7, 3)], 'send')
    expect(afterSend.messages).toHaveLength(1)
    expect(afterSend.messages[0]).toMatchObject({ id: 7, status: 'sent', viaRealtime: false })
    expect(afterSend.reconciled).toBe(1)

    // Realtime echo of my own message: first delivery, not a duplicate.
    const afterEcho = mergeMessages(afterSend.messages, [saved(7, 3)], 'realtime')
    expect(afterEcho.messages).toHaveLength(1)
    expect(afterEcho.duplicates).toBe(0)
    expect(afterEcho.firstDeliveries.map((m) => m.id)).toEqual([7])
  })

  it('handles the realtime echo arriving before the send response', () => {
    const pending = createPending({ roomId: ROOM, profileId: 'me', content: 'hey', clientMsgId: 'cm-7', mentions: [], nowMs: 1 })
    const afterEcho = mergeMessages([pending], [saved(7, 3)], 'realtime')
    expect(afterEcho.reconciled).toBe(1)
    const afterSend = mergeMessages(afterEcho.messages, [saved(7, 3)], 'send')
    expect(afterSend.messages).toHaveLength(1)
    expect(afterSend).toMatchObject({ added: 0, duplicates: 0, overlap: 0 })
  })

  it('never changes the arrays it was given', () => {
    const current = Object.freeze([saved(1, 0)]) as readonly ChatMessage[]
    const incoming = Object.freeze([saved(2, 1)]) as readonly ChatMessage[]
    expect(() => mergeMessages(current, incoming, 'realtime')).not.toThrow()
    expect(current).toHaveLength(1)
  })
})

describe('withStatus / trimHistory', () => {
  it('marks a pending message as failed so the user can retry', () => {
    const pending = createPending({ roomId: ROOM, profileId: 'me', content: 'x', clientMsgId: 'c1', mentions: [], nowMs: 0 })
    expect(withStatus([pending], 'c1', 'failed')[0]?.status).toBe('failed')
    expect(pending.status).toBe('sending')
  })

  it('keeps the newest saved messages and every pending one', () => {
    const pending = createPending({ roomId: ROOM, profileId: 'me', content: 'x', clientMsgId: 'c1', mentions: [], nowMs: 0 })
    const list = [saved(1, 0), saved(2, 1), saved(3, 2), pending]
    expect(ids(trimHistory(list, 2))).toEqual([2, 3, null])
    expect(trimHistory(list, 10)).toHaveLength(4)
  })
})
