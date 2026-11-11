import { describe, expect, it } from 'vitest'
import { Telemetry, sanitizeData, type TelemetryEvent } from './telemetry.ts'

function setup(options: { accept?: boolean; maxPerMinute?: number } = {}) {
  let clock = Date.parse('2026-11-10T12:00:00Z')
  const sent: { events: readonly TelemetryEvent[]; keepalive: boolean }[] = []
  const telemetry = new Telemetry({
    appVersion: '0.1.0+test',
    now: () => clock,
    maxPerMinute: options.maxPerMinute ?? 60,
    transport: async (events, { keepalive }) => {
      sent.push({ events, keepalive })
      return options.accept ?? true
    },
  })
  return {
    telemetry,
    sent,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('sanitizeData', () => {
  it('never keeps message text', () => {
    expect(sanitizeData({ content: 'secret', text: 'x', body: 'y', note: 'z', count: 2 })).toEqual({ count: 2 })
  })

  it('keeps small flat values and drops nested objects', () => {
    const long = 'a'.repeat(1000)
    const clean = sanitizeData({ ok: true, status: 'SUBSCRIBED', long, nested: { a: 1 }, samples_ms: [1, 'x', 3] })
    expect(clean).toMatchObject({ ok: true, status: 'SUBSCRIBED', samples_ms: [1, 3] })
    expect(clean).not.toHaveProperty('nested')
    expect((clean.long as string).length).toBe(300)
  })
})

describe('Telemetry batching', () => {
  it('uploads queued events in one batch with version and time', async () => {
    const { telemetry, sent } = setup()
    telemetry.log('realtime_status', { status: 'SUBSCRIBED' }, 'room-1')
    telemetry.log('catchup', { added: 2 }, 'room-1')
    await telemetry.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.events.map((e) => e.type)).toEqual(['realtime_status', 'catchup'])
    expect(sent[0]?.events[0]).toMatchObject({
      room_id: 'room-1',
      app_version: '0.1.0+test',
      client_ts: '2026-11-10T12:00:00.000Z',
    })
    expect(telemetry.pending).toBe(0)
  })

  it('does nothing when there is nothing to send', async () => {
    const { telemetry, sent } = setup()
    await telemetry.flush()
    expect(sent).toHaveLength(0)
  })

  it('folds latency samples into one latency_batch event per room', async () => {
    const { telemetry, sent } = setup()
    telemetry.addLatencySample(120, 'room-1')
    telemetry.addLatencySample(340.4, 'room-1')
    telemetry.addLatencySample(-5, 'room-1') // ignored
    await telemetry.flush()
    expect(sent[0]?.events).toHaveLength(1)
    expect(sent[0]?.events[0]).toMatchObject({ type: 'latency_batch', data: { samples_ms: [120, 340] } })
  })

  it('keeps events for the next try when the upload fails', async () => {
    const { telemetry, sent } = setup({ accept: false })
    telemetry.log('js_error', { error: 'boom' })
    await telemetry.flush()
    expect(sent).toHaveLength(1)
    expect(telemetry.pending).toBe(1)
  })

  it('marks page-hide uploads as keepalive', async () => {
    const { telemetry, sent } = setup()
    telemetry.log('room_leave')
    await telemetry.flush({ keepalive: true })
    expect(sent[0]?.keepalive).toBe(true)
  })
})

describe('Telemetry rate cap', () => {
  it('caps events per minute and reports how many were dropped', async () => {
    const { telemetry, sent, advance } = setup({ maxPerMinute: 3 })
    const accepted = [1, 2, 3, 4, 5].map((i) => telemetry.log('js_error', { i }))
    expect(accepted).toEqual([true, true, true, false, false])

    await telemetry.flush()
    const types = sent[0]?.events.map((e) => e.type)
    expect(types).toEqual(['js_error', 'js_error', 'js_error', 'events_dropped'])
    expect(sent[0]?.events[3]?.data).toEqual({ count: 2 })

    advance(60_000) // a new minute: logging works again
    expect(telemetry.log('js_error', { i: 6 })).toBe(true)
  })
})
