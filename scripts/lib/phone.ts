/**
 * A simulated phone: a supabase-js client that signs in, joins a room,
 * listens to new messages and presence, and sends — like the real app.
 * Used by verify-local.ts and simulate.ts.
 */
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import { parseTimestampMs } from '../../supabase/functions/_shared/time.ts'
import { bestSample, sampleOffset, type ClockSample } from '../../src/lib/clock.ts'
import type { SupabaseTarget } from './local-env.ts'
import { signInPoolUser, type ensurePool } from './test-users.ts'

export interface ReceivedMessage {
  id: number
  profileId: string | null
  kind: string
  content: string
  createdAtMs: number
  receivedAtMs: number
  count: number
}

export interface SentMessage {
  id: number
  createdAtMs: number
}

type Pool = Awaited<ReturnType<typeof ensurePool>>

export type AuthMode = { kind: 'pool'; pool: Pool; index: number } | { kind: 'anon' }

const COLUMNS = 'id, room_id, profile_id, kind, content, client_msg_id, mentions, created_at'

export class Phone {
  readonly client: SupabaseClient
  readonly name: string
  userId = ''
  offsetMs = 0
  online = 0
  subscribedAtMs: number | null = null
  received = new Map<number, ReceivedMessage>()
  statuses: string[] = []
  private channel: RealtimeChannel | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null

  constructor(target: SupabaseTarget, name: string) {
    this.name = name
    this.client = createClient(target.url, target.publicKey, {
      auth: { persistSession: false, autoRefreshToken: true },
    })
  }

  async signIn(auth: AuthMode, avatar = 'fox'): Promise<void> {
    if (auth.kind === 'pool') {
      this.userId = await signInPoolUser(this.client, auth.pool, auth.index)
    } else {
      const { data, error } = await this.client.auth.signInAnonymously()
      if (error || !data.user) throw new Error(`${this.name}: anonymous sign-in failed: ${error?.message}`)
      this.userId = data.user.id
    }
    const { error } = await this.client.from('profiles').upsert({ id: this.userId, display_name: this.name, avatar })
    if (error) throw new Error(`${this.name}: profile: ${error.message}`)
    await this.syncClock()
  }

  async syncClock(): Promise<ClockSample | null> {
    const samples: ClockSample[] = []
    for (let i = 0; i < 3; i++) {
      const sentAt = Date.now()
      const { data, error } = await this.client.rpc('server_time')
      const receivedAt = Date.now()
      if (!error && typeof data === 'string') samples.push(sampleOffset(sentAt, parseTimestampMs(data), receivedAt))
    }
    const best = bestSample(samples)
    if (best) this.offsetMs = best.offsetMs
    return best
  }

  /** Phone time converted to server time. */
  serverNow(): number {
    return Date.now() + this.offsetMs
  }

  async join(roomId: string): Promise<boolean> {
    const { data, error } = await this.client.rpc('join_room', { p_room_id: roomId })
    if (error) throw new Error(`${this.name}: join: ${error.message}`)
    return (data as { joined?: boolean } | null)?.joined === true
  }

  /** Resolves once the channel is SUBSCRIBED (or rejects after `timeoutMs`). */
  subscribe(roomId: string, timeoutMs = 20_000): Promise<void> {
    // Like the app: "I still have this room open" every 20 s (the AI's "is a human online?" rule).
    // (await, or the lazy supabase-js query is never sent)
    this.heartbeat ??= setInterval(async () => {
      const { error } = await this.client.rpc('touch_room', { p_room_id: roomId })
      if (error) process.stderr.write(`${this.name}: heartbeat failed: ${error.message}\n`)
    }, 20_000)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: realtime did not subscribe in time`)), timeoutMs)
      const channel = this.client.channel(`room:${roomId}`, { config: { presence: { key: this.userId } } })
      this.channel = channel
      channel
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` }, (payload) => {
          const row = payload.new as { id: number; profile_id: string | null; kind: string; content: string; created_at: string }
          const previous = this.received.get(row.id)
          this.received.set(row.id, {
            id: row.id,
            profileId: row.profile_id,
            kind: row.kind,
            content: row.content,
            createdAtMs: parseTimestampMs(row.created_at),
            receivedAtMs: previous?.receivedAtMs ?? Date.now(),
            count: (previous?.count ?? 0) + 1,
          })
        })
        .on('presence', { event: 'sync' }, () => {
          this.online = Object.keys(channel.presenceState()).length
        })
        .subscribe((status) => {
          this.statuses.push(status)
          if (status === 'SUBSCRIBED') {
            this.subscribedAtMs ??= this.serverNow()
            void channel.track({ online_at: new Date().toISOString() })
            clearTimeout(timer)
            resolve()
          }
        })
    })
  }

  async send(roomId: string, content: string, mentions: string[] = []): Promise<SentMessage> {
    const { data, error } = await this.client
      .from('messages')
      .insert({ room_id: roomId, profile_id: this.userId, content, client_msg_id: crypto.randomUUID(), mentions })
      .select(COLUMNS)
      .single()
    if (error || !data) throw new Error(`${this.name}: send: ${error?.message}`)
    return { id: data.id as number, createdAtMs: parseTimestampMs(data.created_at as string) }
  }

  async callAi(roomId: string, trigger: 'mention' | 'silence' | 'join', messageId?: number): Promise<unknown> {
    const { data, error } = await this.client.functions.invoke('room-ai', {
      body: { room_id: roomId, trigger, message_id: messageId ?? null },
    })
    if (error) throw new Error(`${this.name}: room-ai ${trigger}: ${error.message}`)
    return data
  }

  async accessToken(): Promise<string> {
    const { data } = await this.client.auth.getSession()
    if (!data.session) throw new Error(`${this.name}: not signed in`)
    return data.session.access_token
  }

  /** Delivery latency samples: server write → this phone, offset-corrected. */
  latencies(sinceServerMs = 0): number[] {
    return [...this.received.values()]
      .filter((m) => m.createdAtMs >= sinceServerMs)
      .map((m) => Math.max(0, m.receivedAtMs + this.offsetMs - m.createdAtMs))
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.channel) await this.client.removeChannel(this.channel)
    this.channel = null
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll `check` until it returns a value, or give up after `timeoutMs`. */
export async function waitFor<T>(check: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs: number, everyMs = 250): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(everyMs)
  }
  return null
}
