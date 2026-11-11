/**
 * Load simulation: N phones join one room and chat for M minutes; then, per
 * phone, how many messages arrived, were missed or duplicated, and how fast.
 *
 *   npm run simulate                                   # 20 phones, 3 minutes, local stack
 *   npm run simulate -- --clients 30 --minutes 5
 *   npm run simulate -- --with-ai                      # also @mention the AI and run silence timers (LLM calls!)
 *   npm run simulate -- --room pop-music               # use an existing room instead of a throwaway one
 *
 * Sign-in: locally, phones use a pool of email/password test users created
 * with the service role key (anonymous sign-ins are rate-limited per IP).
 * Hosted project without a service key:
 *   SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… npm run simulate -- --auth anon --room pop-music
 *   (raise "Anonymous sign-ins" under Authentication → Rate Limits first; default 30/hour per IP)
 *
 * No LLM is called unless you pass --with-ai.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { AI_RULES } from '../supabase/functions/_shared/ai-rules.ts'
import { distribution } from '../src/lib/stats.ts'
import { Telemetry } from '../src/lib/telemetry.ts'
import { resolveTarget, type SupabaseTarget } from './lib/local-env.ts'
import { Phone, sleep, type AuthMode } from './lib/phone.ts'
import { createScratchRoom, deleteScratchRoom, type ScratchRoom } from './lib/scratch-room.ts'
import { ensurePool } from './lib/test-users.ts'

const AVATARS = ['fox', 'owl', 'cat', 'panda', 'frog', 'octopus', 'bear', 'koala', 'tiger', 'penguin', 'unicorn', 'alien']
const GRACE_MS = 8_000
const MENTION_SHARE = 0.1

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}
const has = (name: string): boolean => process.argv.includes(`--${name}`)

const settings = {
  clients: Math.max(1, Number(option('clients', '20'))),
  minutes: Math.max(0.25, Number(option('minutes', '3'))),
  minGapS: Number(option('min-gap', '5')),
  maxGapS: Number(option('max-gap', '20')),
  roomSlug: option('room', ''),
  auth: option('auth', ''),
  withAi: has('with-ai'),
  logEvents: !has('no-events'),
  keep: has('keep'),
}

const log = (text: string): void => {
  process.stdout.write(`${text}\n`)
}
const pad = (value: string | number, width: number): string => String(value).padStart(width)

/** Run `task` over `items`, at most `limit` at a time. */
async function inBatches<T>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map((item, j) => task(item, i + j)))
  }
}

interface RoomTarget {
  id: string
  scratch: ScratchRoom | null
  botProfileIds: string[]
}

async function resolveRoom(target: SupabaseTarget, admin: SupabaseClient | null, probe: Phone): Promise<RoomTarget> {
  if (settings.roomSlug) {
    const { data, error } = await probe.client.from('rooms').select('id').eq('slug', settings.roomSlug).maybeSingle()
    if (error || !data) throw new Error(`Room "${settings.roomSlug}" not found`)
    const bots = admin ? ((await admin.from('bots').select('profile_id').eq('room_id', data.id)).data ?? []) : []
    return { id: data.id, scratch: null, botProfileIds: bots.map((b) => b.profile_id as string) }
  }
  if (!admin) throw new Error('A throwaway room needs the service role key. Pass --room <slug> to use an existing room.')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
  const scratch = await createScratchRoom(admin, `load-${stamp}`, `Load test ${stamp}`)
  log(`created throwaway room ${scratch.slug} on ${target.url}`)
  return { id: scratch.id, scratch, botProfileIds: [scratch.hostProfileId, scratch.participantProfileId] }
}

async function chatLoop(phone: Phone, room: RoomTarget, endsAtMs: number, stats: { sent: number; failed: number }): Promise<void> {
  const gap = (): number => (settings.minGapS + Math.random() * (settings.maxGapS - settings.minGapS)) * 1000
  await sleep(Math.random() * settings.maxGapS * 1000) // don't all start at once
  let n = 0
  while (Date.now() + 500 < endsAtMs) {
    n += 1
    const mention = settings.withAi && room.botProfileIds.length > 0 && Math.random() < MENTION_SHARE
    try {
      if (mention) {
        const bot = room.botProfileIds[0] as string
        const sent = await phone.send(room.id, `@AI quick question #${n} from ${phone.name}?`, [bot])
        await phone.callAi(room.id, 'mention', sent.id).catch(() => undefined)
      } else {
        await phone.send(room.id, `sim message #${n} from ${phone.name}`)
      }
      stats.sent += 1
    } catch {
      stats.failed += 1
    }
    await sleep(Math.min(gap(), Math.max(0, endsAtMs - Date.now())))
  }
}

/** With --with-ai: like the app, ask for a silence break 45 s after the newest message. */
async function silenceLoop(phone: Phone, roomId: string, endsAtMs: number): Promise<void> {
  let askedFor = 0
  while (Date.now() < endsAtMs) {
    const newest = Math.max(0, ...[...phone.received.values()].map((m) => m.createdAtMs))
    if (newest > 0 && newest !== askedFor && phone.serverNow() - newest >= AI_RULES.silenceMs) {
      askedFor = newest
      await phone.callAi(roomId, 'silence').catch(() => undefined)
    }
    await sleep(1_000)
  }
}

async function uploadLatency(target: SupabaseTarget, phone: Phone, roomId: string, sinceMs: number): Promise<boolean> {
  const token = await phone.accessToken()
  const telemetry = new Telemetry({
    appVersion: 'simulate',
    maxLatencySamples: 10_000,
    transport: async (events) => {
      const res = await fetch(`${target.url}/rest/v1/client_events`, {
        method: 'POST',
        headers: { apikey: target.publicKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(events),
      })
      return res.ok
    },
  })
  // One event holds at most 300 samples (the server's size cap), so split long runs.
  const samples = phone.latencies(sinceMs)
  for (let i = 0; i < samples.length; i += 300) {
    for (const ms of samples.slice(i, i + 300)) telemetry.addLatencySample(ms, roomId)
    await telemetry.flush()
  }
  return telemetry.pending === 0
}

async function main(): Promise<void> {
  const target = resolveTarget()
  const admin = target.serviceKey
    ? createClient(target.url, target.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null
  const authKind = settings.auth || (target.serviceKey ? 'pool' : 'anon')
  log(`${settings.clients} phones · ${settings.minutes} min · gaps ${settings.minGapS}–${settings.maxGapS} s · auth ${authKind} · AI ${settings.withAi ? 'ON (LLM calls)' : 'off'}`)
  if (authKind === 'anon' && settings.clients > 25) {
    log('note: anonymous sign-ins are limited per IP (hosted default 30/hour). Raise it or use a smaller --clients.')
  }

  const pool = authKind === 'pool' ? await ensurePool(target, settings.clients) : null
  const phones = Array.from({ length: settings.clients }, (_, i) => new Phone(target, `Sim ${String(i + 1).padStart(2, '0')}`))
  const authFor = (index: number): AuthMode => (pool ? { kind: 'pool', pool, index: index + 1 } : { kind: 'anon' })

  log('signing in…')
  await inBatches(phones, 5, async (phone, i) => {
    await phone.signIn(authFor(i), AVATARS[i % AVATARS.length])
    await sleep(100)
  })
  const room = await resolveRoom(target, admin, phones[0] as Phone)
  if (settings.withAi && room.botProfileIds.length === 0) throw new Error('--with-ai needs the service role key to find the AI members.')

  log('joining and subscribing…')
  await inBatches(phones, 10, async (phone) => {
    await phone.join(room.id)
  })
  const subscribeResults = await Promise.allSettled(phones.map((p) => p.subscribe(room.id, 30_000)))
  const notSubscribed = subscribeResults.filter((r) => r.status === 'rejected').length
  if (notSubscribed > 0) log(`warning: ${notSubscribed} phone(s) never subscribed`)
  await sleep(2_000) // let presence settle

  const first = phones[0] as Phone
  const { data: lastBefore } = await first.client.from('messages').select('id').eq('room_id', room.id).order('id', { ascending: false }).limit(1)
  const startId = (lastBefore?.[0]?.id as number | undefined) ?? 0
  const startServerMs = first.serverNow()
  const endsAtMs = Date.now() + settings.minutes * 60_000
  const counters = phones.map(() => ({ sent: 0, failed: 0 }))
  log(`chatting until ${new Date(endsAtMs).toLocaleTimeString()} — online as seen by phone 1: ${first.online}`)

  const progress = setInterval(() => {
    const sent = counters.reduce((sum, c) => sum + c.sent, 0)
    log(`  …${sent} messages sent, ${Math.round((endsAtMs - Date.now()) / 1000)} s left`)
  }, 30_000)
  await Promise.all([
    ...phones.map((p, i) => chatLoop(p, room, endsAtMs, counters[i] as { sent: number; failed: number })),
    ...(settings.withAi ? phones.map((p) => silenceLoop(p, room.id, endsAtMs)) : []),
  ])
  clearInterval(progress)
  log(`stopped sending; waiting ${GRACE_MS / 1000} s for deliveries in flight…`)
  await sleep(GRACE_MS)

  // Ground truth: every message the database holds for this run.
  let truth: { id: number; created_at: string }[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await first.client
      .from('messages')
      .select('id, created_at')
      .eq('room_id', room.id)
      .gt('id', startId)
      .order('id')
      .range(from, from + 999)
    if (error) throw error
    truth = [...truth, ...(data ?? [])]
    if (!data || data.length < 1000) break
  }
  const truthIds = truth.map((m) => m.id)

  const rows = phones.map((phone, i) => {
    const missed = truthIds.filter((id) => !phone.received.has(id)).length
    const duplicates = [...phone.received.values()].reduce((sum, m) => sum + Math.max(0, m.count - 1), 0)
    const latency = distribution(phone.latencies(startServerMs))
    return {
      phone: phone.name,
      sent: counters[i]?.sent ?? 0,
      sendFailed: counters[i]?.failed ?? 0,
      received: truthIds.length - missed,
      missed,
      duplicates,
      p50: latency.p50,
      p95: latency.p95,
      max: latency.max,
    }
  })

  log('')
  log(`${'phone'.padEnd(8)} ${pad('sent', 5)} ${pad('recv', 6)} ${pad('missed', 7)} ${pad('dup', 4)} ${pad('p50 ms', 7)} ${pad('p95 ms', 7)} ${pad('max ms', 7)}`)
  for (const r of rows) {
    log(`${r.phone.padEnd(8)} ${pad(r.sent, 5)} ${pad(r.received, 6)} ${pad(r.missed, 7)} ${pad(r.duplicates, 4)} ${pad(Math.round(r.p50 ?? 0), 7)} ${pad(Math.round(r.p95 ?? 0), 7)} ${pad(Math.round(r.max ?? 0), 7)}`)
  }
  const all = distribution(phones.flatMap((p) => p.latencies(startServerMs)))
  const expectedDeliveries = truthIds.length * phones.length
  const missedTotal = rows.reduce((sum, r) => sum + r.missed, 0)
  const summary = {
    phones: phones.length,
    minutes: settings.minutes,
    messagesInDb: truthIds.length,
    sendFailures: rows.reduce((sum, r) => sum + r.sendFailed, 0),
    expectedDeliveries,
    missed: missedTotal,
    missedRate: expectedDeliveries > 0 ? missedTotal / expectedDeliveries : 0,
    duplicates: rows.reduce((sum, r) => sum + r.duplicates, 0),
    latencyMs: { p50: all.p50, p95: all.p95, max: all.max, samples: all.n },
  }
  log('')
  log(`messages: ${summary.messagesInDb} · deliveries expected: ${expectedDeliveries} · missed: ${missedTotal} (${(summary.missedRate * 100).toFixed(2)} %) · duplicates: ${summary.duplicates} · send failures: ${summary.sendFailures}`)
  log(`delivery latency: p50 ${Math.round(all.p50 ?? 0)} ms · p95 ${Math.round(all.p95 ?? 0)} ms · max ${Math.round(all.max ?? 0)} ms (${all.n} samples)`)

  if (settings.logEvents) {
    const uploaded = await Promise.all(phones.map((p) => uploadLatency(target, p, room.id, startServerMs).catch(() => false)))
    log(`latency samples uploaded as client events for ${uploaded.filter(Boolean).length}/${phones.length} phones (run_checks can use them)`)
  }

  mkdirSync('.sim', { recursive: true })
  const file = `.sim/report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(file, JSON.stringify({ settings, summary, phones: rows }, null, 2))
  log(`report written to ${file}`)

  await Promise.all(phones.map((p) => p.close()))
  if (room.scratch && admin) {
    const session = await admin.from('test_sessions').select('id').is('ended_at', null).maybeSingle()
    if (settings.keep || session.data) {
      log(`kept room ${room.scratch.slug}${session.data ? ' (a test session is running, so its data stays for /admin)' : ''}`)
    } else {
      await deleteScratchRoom(admin, room.scratch)
      log('deleted the throwaway room')
    }
  }
  process.exitCode = missedTotal === 0 && summary.duplicates === 0 ? 0 : 2
}

main().catch((error: unknown) => {
  process.stderr.write(`simulate stopped: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
