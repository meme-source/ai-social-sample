import { describe, expect, it } from 'vitest'
import { bestSample, deliveryLatencyMs, sampleOffset } from './clock.ts'
import { distribution, percentile } from './stats.ts'

describe('clock offset', () => {
  it('assumes the server read its clock halfway through the round trip', () => {
    // phone sends at 1000, server says 6100, phone receives at 1200 → phone is ~5 s behind
    expect(sampleOffset(1_000, 6_100, 1_200)).toEqual({ offsetMs: 5_000, rttMs: 200 })
  })

  it('trusts the sample with the shortest round trip', () => {
    expect(bestSample([{ offsetMs: 10, rttMs: 300 }, { offsetMs: 12, rttMs: 40 }, { offsetMs: 9, rttMs: 90 }])).toEqual({
      offsetMs: 12,
      rttMs: 40,
    })
    expect(bestSample([])).toBeNull()
  })

  it('corrects delivery latency for the offset and never goes negative', () => {
    // created at server 10_000; phone receives at its local 5_300, phone is 5_000 behind → 300 ms
    expect(deliveryLatencyMs(10_000, 5_300, 5_000)).toBe(300)
    expect(deliveryLatencyMs(10_000, 4_000, 5_000)).toBe(0)
  })
})

describe('percentile', () => {
  it('matches Postgres percentile_cont', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.95)).toBeCloseTo(95.5)
    expect(percentile([7], 0.95)).toBe(7)
    expect(percentile([], 0.5)).toBeNull()
  })

  it('summarises a distribution', () => {
    expect(distribution([100, 200, 300])).toMatchObject({ n: 3, p50: 200, max: 300, mean: 200 })
    expect(distribution([])).toEqual({ n: 0, p50: null, p95: null, max: null, mean: null })
  })
})
