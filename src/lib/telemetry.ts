/**
 * Automatic client events, batched. This file has no browser code so it can
 * be unit-tested; telemetry-browser.ts plugs it into the page.
 *
 * Rules: upload in batches (every 10 s, and when the page is hidden), at most
 * 60 events per minute per phone, and never any message text.
 */
export interface TelemetryEvent {
  type: string
  room_id: string | null
  data: Record<string, unknown>
  client_ts: string
  app_version: string
}

/** Sends one batch; resolves true when the server accepted it. */
export type Transport = (events: readonly TelemetryEvent[], options: { keepalive: boolean }) => Promise<boolean>

export interface TelemetryOptions {
  appVersion: string
  transport: Transport
  now?: () => number
  maxPerMinute?: number
  maxBatch?: number
  maxQueue?: number
  maxLatencySamples?: number
}

/** Keys that could carry what people wrote. They are always removed. */
const TEXT_KEYS = new Set(['content', 'text', 'body', 'note', 'message_text'])
const MAX_STRING = 300

/** Keep only small, flat, non-text values: numbers, booleans, short strings, number lists. */
export function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (TEXT_KEYS.has(key)) continue
    if (typeof value === 'string') clean[key] = value.slice(0, MAX_STRING)
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) clean[key] = value
    else if (Array.isArray(value)) clean[key] = value.filter((v) => typeof v === 'number').slice(0, MAX_STRING)
  }
  return clean
}

export class Telemetry {
  private readonly appVersion: string
  private readonly transport: Transport
  private readonly now: () => number
  private readonly maxPerMinute: number
  private readonly maxBatch: number
  private readonly maxQueue: number
  private readonly maxLatencySamples: number

  private queue: TelemetryEvent[] = []
  private latency = new Map<string | null, number[]>()
  private windowStart = Number.NEGATIVE_INFINITY
  private windowCount = 0
  private dropped = 0
  private flushing = false

  constructor(options: TelemetryOptions) {
    this.appVersion = options.appVersion
    this.transport = options.transport
    this.now = options.now ?? (() => Date.now())
    this.maxPerMinute = options.maxPerMinute ?? 60
    this.maxBatch = options.maxBatch ?? 50
    this.maxQueue = options.maxQueue ?? 500
    this.maxLatencySamples = options.maxLatencySamples ?? 200
  }

  /** Record one event. Returns false if the per-minute cap dropped it. */
  log(type: string, data: Record<string, unknown> = {}, roomId: string | null = null): boolean {
    if (!this.takeSlot()) {
      this.dropped += 1
      return false
    }
    this.enqueue(type, data, roomId)
    return true
  }

  /** Delivery latency is sampled per message but uploaded as one event per flush. */
  addLatencySample(ms: number, roomId: string | null): void {
    if (!Number.isFinite(ms) || ms < 0) return
    const samples = this.latency.get(roomId) ?? []
    if (samples.length < this.maxLatencySamples) this.latency.set(roomId, [...samples, Math.round(ms)])
  }

  /** Events waiting to be uploaded. */
  get pending(): number {
    return this.queue.length
  }

  async flush(options: { keepalive?: boolean } = {}): Promise<void> {
    const keepalive = options.keepalive ?? false
    this.drainLatency()
    if (this.dropped > 0) {
      // Bypasses the cap on purpose: knowing that events were dropped matters.
      this.enqueue('events_dropped', { count: this.dropped }, null)
      this.dropped = 0
    }
    if (this.queue.length === 0) return
    if (this.flushing && !keepalive) return

    const batch = this.queue.slice(0, this.maxBatch)
    this.queue = this.queue.slice(this.maxBatch)
    this.flushing = true
    try {
      const accepted = await this.transport(batch, { keepalive })
      if (!accepted) this.requeue(batch)
    } catch {
      this.requeue(batch)
    } finally {
      this.flushing = false
    }
  }

  private takeSlot(): boolean {
    const now = this.now()
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now
      this.windowCount = 0
    }
    if (this.windowCount >= this.maxPerMinute) return false
    this.windowCount += 1
    return true
  }

  private enqueue(type: string, data: Record<string, unknown>, roomId: string | null): void {
    const event: TelemetryEvent = {
      type,
      room_id: roomId,
      data: sanitizeData(data),
      client_ts: new Date(this.now()).toISOString(),
      app_version: this.appVersion,
    }
    this.queue = [...this.queue, event].slice(-this.maxQueue)
  }

  private drainLatency(): void {
    const batches = [...this.latency.entries()]
    this.latency = new Map()
    for (const [roomId, samples] of batches) {
      if (samples.length > 0) this.log('latency_batch', { samples_ms: samples }, roomId)
    }
  }

  private requeue(batch: readonly TelemetryEvent[]): void {
    const combined = [...batch, ...this.queue]
    const overflow = combined.length - this.maxQueue
    if (overflow > 0) this.dropped += overflow
    this.queue = combined.slice(0, this.maxQueue)
  }
}
