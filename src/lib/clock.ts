/**
 * Phones' clocks are often a few seconds off. To measure delivery latency
 * (server write → phone receives) and to time the 45 s silence, each phone
 * estimates its offset from the server's clock.
 */
export interface ClockSample {
  /** serverTime − phoneTime, in ms */
  offsetMs: number
  /** how long the round trip took; shorter = more trustworthy */
  rttMs: number
}

/** Assumes the server read its clock halfway through the round trip. */
export function sampleOffset(sentAtMs: number, serverMs: number, receivedAtMs: number): ClockSample {
  return {
    offsetMs: Math.round(serverMs - (sentAtMs + receivedAtMs) / 2),
    rttMs: Math.max(0, receivedAtMs - sentAtMs),
  }
}

export function bestSample(samples: readonly ClockSample[]): ClockSample | null {
  return samples.reduce<ClockSample | null>((best, s) => (best === null || s.rttMs < best.rttMs ? s : best), null)
}

/** Server write → received on this phone, corrected for clock offset. Never negative. */
export function deliveryLatencyMs(createdAtMs: number, receivedAtLocalMs: number, offsetMs: number): number {
  return Math.max(0, Math.round(receivedAtLocalMs + offsetMs - createdAtMs))
}
