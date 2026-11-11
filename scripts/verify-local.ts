/**
 * End-to-end checks against the LOCAL stack — the "done when" list, automated.
 *
 *   Terminal 1: npm run db:start          (Docker; once)
 *   Terminal 2: npm run mock-llm
 *   Terminal 3: npm run functions:serve
 *   Terminal 4: npm run verify:local      (about 2 minutes; add --keep to inspect the run in /admin)
 *
 * Uses three simulated phones in a throwaway room with its own AI members,
 * inside its own test session, and prints PASS/FAIL for each check.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { parseTimestampMs } from '../supabase/functions/_shared/time.ts'
import { loadSessionData } from '../src/components/admin/load-session-data.ts'
import { toCsv } from '../src/lib/csv.ts'
import { summarizeSession } from '../src/lib/session-summary.ts'
import { Telemetry } from '../src/lib/telemetry.ts'
import { resolveTarget } from './lib/local-env.ts'
import { Phone, sleep, waitFor } from './lib/phone.ts'
import { createScratchRoom, deleteScratchRoom, type ScratchRoom } from './lib/scratch-room.ts'
import { ensurePool } from './lib/test-users.ts'

const MOCK_URL = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:8787'
const KEEP = process.argv.includes('--keep')
const VERSION = 'verify-local'

interface Check {
  name: string
  ok: boolean
  detail: string
}
const checks: Check[] = []

function record(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail })
  process.stdout.write(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? `\n         ${detail}` : ''}\n`)
}

function step(text: string): void {
  process.stdout.write(`\n— ${text}\n`)
}

async function mock(config: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${MOCK_URL}/__mock/config`, { method: 'POST', body: JSON.stringify(config) })
  if (!res.ok) throw new Error(`mock LLM config failed: HTTP ${res.status}`)
}

interface MessageLite {
  id: number
  profile_id: string | null
  kind: string
  content: string
  created_at: string
}

async function messagesAfter(admin: SupabaseClient, roomId: string, afterId: number): Promise<MessageLite[]> {
  const { data, error } = await admin
    .from('messages')
    .select('id, profile_id, kind, content, created_at')
    .eq('room_id', roomId)
    .gt('id', afterId)
    .order('id')
  if (error) throw error
  return data
}

async function maxMessageId(admin: SupabaseClient, roomId: string): Promise<number> {
  const { data } = await admin.from('messages').select('id').eq('room_id', roomId).order('id', { ascending: false }).limit(1)
  return data?.[0]?.id ?? 0
}

async function waitLockFree(admin: SupabaseClient, room: ScratchRoom, clock: Phone): Promise<void> {
  const free = await waitFor(async () => {
    const { data } = await admin.from('rooms').select('ai_lock_until').eq('id', room.id).single()
    const until = data?.ai_lock_until as string | null
    return until === null || parseTimestampMs(until) < clock.serverNow()
  }, 20_000, 500)
  if (!free) throw new Error('The AI lock never freed up')
}

async function main(): Promise<void> {
  const target = resolveTarget({ needServiceKey: true })
  if (!target.isLocal || !target.serviceKey) throw new Error('verify-local only runs against the local Supabase stack.')
  const admin = createClient(target.url, target.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

  step('Preflight')
  const health = await fetch(`${MOCK_URL}/health`).catch(() => null)
  if (!health?.ok) throw new Error(`Mock LLM not reachable at ${MOCK_URL}. Start it with: npm run mock-llm`)
  await mock({ reset: true })
  const running = await admin.from('test_sessions').select('label').is('ended_at', null).maybeSingle()
  if (running.data) throw new Error(`Test session "${running.data.label}" is running. End it in /admin first.`)

  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
  const room = await createScratchRoom(admin, `verify-${stamp}`, `Verify ${stamp}`)
  const started = await admin.rpc('start_test_session', { p_label: `verify-local ${stamp}`, p_app_version: VERSION })
  if (started.error) throw started.error
  const sessionId = (started.data as { id: string }).id
  process.stdout.write(`room ${room.slug}, session ${sessionId.slice(0, 8)}…\n`)

  const pool = await ensurePool(target, 3)
  const [ana, bo, cy] = [new Phone(target, 'Ana'), new Phone(target, 'Bo'), new Phone(target, 'Cy')]
  const phones = [ana, bo, cy]
  await Promise.all(phones.map((p, i) => p.signIn({ kind: 'pool', pool, index: i + 1 }, ['fox', 'owl', 'frog'][i])))

  try {
    step('Join, presence and live chat')
    const beforeJoin = await maxMessageId(admin, room.id)
    for (const p of phones) await p.join(room.id)
    await Promise.all(phones.map((p) => p.subscribe(room.id)))
    const presence = await waitFor(() => phones.every((p) => p.online === 3), 10_000)
    record('Presence: every phone shows 3 online', presence !== null, `online counts: ${phones.map((p) => p.online).join(', ')}`)

    await ana.callAi(room.id, 'join')
    const welcome = await waitFor(
      async () => (await messagesAfter(admin, room.id, beforeJoin)).find((m) => m.profile_id === room.hostProfileId),
      10_000,
    )
    const joinEvent = await admin.from('ai_events').select('decision, llm_attempted').eq('room_id', room.id).eq('trigger', 'join').maybeSingle()
    record(
      'Join: the host welcomes a new member with a template + question (no LLM call)',
      Boolean(welcome) && joinEvent.data?.decision === 'spoke' && joinEvent.data.llm_attempted === false,
      welcome ? `"${welcome.content}"` : 'no welcome',
    )

    // Realtime may be cold (just started or idle): it can take a few seconds after
    // SUBSCRIBED before changes stream. Wait for that, then test live delivery.
    const warmStart = Date.now()
    let warm = false
    for (let n = 1; !warm && Date.now() - warmStart < 15_000; n++) {
      const probe = await bo.send(room.id, `(warm-up ${n})`) // unique text: not a "double-send"
      warm = (await waitFor(() => phones.every((p) => p.received.has(probe.id)), 1_000)) !== null
    }
    process.stdout.write(`         realtime streaming after ${Date.now() - warmStart} ms${warm ? '' : ' (never, continuing)'}\n`)

    const hello = await ana.send(room.id, 'hello from Ana')
    const delivered = await waitFor(() => phones.every((p) => p.received.has(hello.id)), 5_000)
    const helloLatency = phones.map((p) => {
      const got = p.received.get(hello.id)
      return got ? Math.max(0, got.receivedAtMs + p.offsetMs - got.createdAtMs) : null
    })
    record('Live chat: a message reaches all 3 phones', delivered !== null, `delivery ms per phone: ${helloLatency.join(', ')}`)

    step('@mention from two phones at the same moment')
    await waitLockFree(admin, room, ana)
    const beforeMention = await maxMessageId(admin, room.id)
    const [m1, m2] = await Promise.all([
      ana.send(room.id, '@Jun what do you think of the new single?', [room.participantProfileId]),
      bo.send(room.id, '@Jun same question from me!', [room.participantProfileId]),
    ])
    await Promise.all([ana.callAi(room.id, 'mention', m1.id), bo.callAi(room.id, 'mention', m2.id)])
    await sleep(3_000)
    const aiAfterMention = (await messagesAfter(admin, room.id, beforeMention)).filter(
      (m) => m.profile_id === room.participantProfileId || m.profile_id === room.hostProfileId,
    )
    const mentionEvents = await admin.from('ai_events').select('decision, reason').in('trigger_message_id', [m1.id, m2.id])
    const decisions = (mentionEvents.data ?? []).map((e) => `${e.decision}${e.reason ? `:${e.reason}` : ''}`).sort()
    record(
      '@mention: two triggers at once → exactly one AI reply',
      aiAfterMention.length === 1 && decisions.join() === 'skipped:lock_busy,spoke',
      `AI replies: ${aiAfterMention.length} ("${aiAfterMention[0]?.content ?? ''}") · decisions: ${decisions.join(', ')}`,
    )
    const replyId = aiAfterMention[0]?.id
    const allGotReply = replyId !== undefined && (await waitFor(() => phones.every((p) => p.received.has(replyId)), 5_000)) !== null
    record('Every phone received the AI reply live', allGotReply)

    step('45 s of silence (3 phones each ask; ~50 s wait)')
    await waitLockFree(admin, room, ana)
    const anchor = await cy.send(room.id, 'ok, going quiet now')
    await sleep(Math.max(0, anchor.createdAtMs + 20_000 - ana.serverNow()))
    await ana.callAi(room.id, 'silence') // too early: should be ignored
    await Promise.all(
      phones.map(async (p) => {
        await sleep(Math.max(0, anchor.createdAtMs + 45_000 + 200 - p.serverNow()))
        await p.callAi(room.id, 'silence')
      }),
    )
    await sleep(3_000)
    const afterSilence = (await messagesAfter(admin, room.id, anchor.id)).filter((m) => m.profile_id === room.hostProfileId)
    const silenceEvents = await admin
      .from('ai_events')
      .select('decision, reason')
      .eq('room_id', room.id)
      .eq('trigger', 'silence')
    const silenceDecisions = (silenceEvents.data ?? []).map((e) => `${e.decision}${e.reason ? `:${e.reason}` : ''}`)
    const hostGapMs = afterSilence[0] ? parseTimestampMs(afterSilence[0].created_at) - anchor.createdAtMs : null
    record(
      '45 s silence: the host speaks exactly once',
      afterSilence.length === 1 && silenceDecisions.filter((d) => d === 'spoke').length === 1 && (hostGapMs ?? 0) >= 43_000,
      `host messages: ${afterSilence.length} after ${hostGapMs === null ? '—' : `${(hostGapMs / 1000).toFixed(1)} s`} · decisions: ${silenceDecisions.join(', ')}`,
    )
    record('A silence call at 20 s is ignored (not_silent)', silenceDecisions.includes('skipped:not_silent'))

    step('Wrong LLM key → question-bank fallback')
    await mock({ acceptKey: 'a-rotated-key-the-function-does-not-have' })
    await waitLockFree(admin, room, ana)
    const beforeFallback = await maxMessageId(admin, room.id)
    const ask = await bo.send(room.id, '@Mira are you still there?', [room.hostProfileId])
    await bo.callAi(room.id, 'mention', ask.id)
    const fallback = await waitFor(
      async () => (await messagesAfter(admin, room.id, beforeFallback)).find((m) => m.profile_id === room.hostProfileId),
      10_000,
    )
    const fallbackEvent = await admin
      .from('ai_events')
      .select('decision, fallback_used, error_code, llm_attempted')
      .eq('trigger_message_id', ask.id)
      .maybeSingle()
    const bank = await admin.from('question_bank').select('text')
    const fromBank = Boolean(fallback && (bank.data ?? []).some((q) => fallback.content.includes(q.text as string)))
    record(
      'Wrong LLM key: the host still answers with a question-bank prompt, logged as a fallback',
      fromBank && fallbackEvent.data?.fallback_used === true && fallbackEvent.data.error_code === 'auth',
      `"${fallback?.content ?? '—'}" · ai_events: ${JSON.stringify(fallbackEvent.data)}`,
    )
    await mock({ reset: true })

    step('Feedback and "Something\'s off"')
    const context = { user_agent: 'verify-local', viewport: '390x844@3', online_count: 3, client_ts: new Date().toISOString() }
    const general = await bo.client.from('feedback').insert({
      kind: 'general', category: 'bug', note: 'verify: the send button hid behind the keyboard', room_id: room.id, app_version: VERSION, context,
    })
    const report = await bo.client.from('feedback').insert({
      kind: 'message', category: 'duplicated', note: 'saw it twice', message_id: hello.id, room_id: room.id, app_version: VERSION, context,
    })
    const stored = await admin.from('feedback').select('kind, session_id, app_version, message_id').eq('room_id', room.id)
    record(
      'Feedback and per-message reports are stored with session + version',
      !general.error && !report.error && stored.data?.length === 2 &&
        stored.data.every((f) => f.session_id === sessionId && f.app_version === VERSION),
      JSON.stringify(stored.data ?? general.error ?? report.error),
    )

    step('Client events upload in batches')
    const token = await bo.accessToken()
    let uploads = 0
    const telemetry = new Telemetry({
      appVersion: VERSION,
      transport: async (events, { keepalive }) => {
        uploads += 1
        const res = await fetch(`${target.url}/rest/v1/client_events`, {
          method: 'POST',
          keepalive,
          headers: { apikey: target.publicKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify(events),
        })
        return res.ok
      },
    })
    telemetry.log('realtime_status', { status: 'SUBSCRIBED' }, room.id)
    telemetry.log('catchup', { reason: 'visible', fetched: 3, added: 1, overlap: 2 }, room.id)
    telemetry.log('dup_dropped', { count: 1, source: 'realtime' }, room.id)
    telemetry.log('js_error', { error: 'verify: pretend error', content: 'hello from Ana' }, room.id) // content must be dropped
    for (const ms of bo.latencies()) telemetry.addLatencySample(ms, room.id)
    await telemetry.flush()
    const events = await admin.from('client_events').select('type, session_id, app_version, data').eq('room_id', room.id)
    const rows = events.data ?? []
    record(
      'Client events: one upload carried the whole batch, stamped with session + version, no message text',
      uploads === 1 && rows.length === 5 && rows.every((e) => e.session_id === sessionId && e.app_version === VERSION) &&
        !JSON.stringify(rows).includes('hello from Ana'),
      `${uploads} upload(s), ${rows.length} rows: ${rows.map((e) => e.type).join(', ')}`,
    )

    step('Anomaly checks with injected problems')
    for (const [phone, text] of [[ana, 'anyone seen the new video?'], [bo, 'not yet'], [cy, 'link?'], [ana, 'later!']] as const) {
      await phone.send(room.id, text)
    }
    await cy.send(room.id, 'double tap!')
    await cy.send(room.id, 'double tap!') // a double-send: same text, new client_msg_id
    // A broken lock: two AI messages 3 s apart, written straight into the table
    // (bypassing the function), placed after the last real AI message.
    const lastAi = await admin
      .from('messages')
      .select('created_at')
      .eq('room_id', room.id)
      .in('profile_id', [room.hostProfileId, room.participantProfileId])
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    const lastAiMs = parseTimestampMs(lastAi.data?.created_at as string)
    const injected = await admin.from('messages').insert([
      { room_id: room.id, profile_id: room.hostProfileId, content: '(injected) AI line 1', created_at: new Date(lastAiMs + 16_000).toISOString() },
      { room_id: room.id, profile_id: room.hostProfileId, content: '(injected) AI line 2', created_at: new Date(lastAiMs + 19_000).toISOString() },
    ])
    if (injected.error) throw injected.error
    const checked = await admin.rpc('run_checks', { p_session_id: sessionId })
    const anomalies = await admin.from('anomalies').select('type, severity, details').eq('session_id', sessionId)
    const found = anomalies.data ?? []
    record(
      'run_checks flags the injected duplicate',
      found.some((a) => a.type === 'duplicate_message' && (a.details as { kind?: string }).kind === 'same_text_within_10s'),
    )
    record(
      'run_checks flags the injected lock violation (two AI messages 3 s apart)',
      found.some((a) => a.type === 'ai_lock_violation' && (a.details as { gap_ms?: number }).gap_ms === 3000),
      `${String(checked.data)} anomalies: ${found.map((a) => `${a.type}(${a.severity})`).join(', ')}`,
    )

    step('Admin page data: summary, CSV, admin-only access')
    await admin.from('admins').insert({ user_id: ana.userId, note: 'verify-local' })
    const asAdmin = await ana.client.from('feedback').select('id').eq('session_id', sessionId)
    const asTester = await cy.client.from('feedback').select('id').eq('session_id', sessionId)
    record(
      'Only allow-listed admins can read session data',
      (asAdmin.data?.length ?? 0) === 2 && (asTester.data?.length ?? 0) === 0,
      `admin sees ${asAdmin.data?.length ?? 0} feedback rows, tester sees ${asTester.data?.length ?? 0}`,
    )
    const data = await loadSessionData(ana.client, sessionId)
    const summary = summarizeSession({
      messages: data.messages,
      botProfileIds: data.botProfileIds,
      names: data.names,
      aiEvents: data.aiEvents,
      clientEvents: data.clientEvents,
      feedbackProfileIds: data.feedback.map((f) => f.profile_id),
    })
    const csv = toCsv(data.messages.map((m) => ({ ...m })))
    record(
      'Admin summary computes and the messages CSV exports',
      summary.participants.length === 3 && csv.split('\r\n').length - 2 === data.messages.length,
      `people ${summary.participants.length} · human ${summary.messages.human} / AI ${summary.messages.ai} msgs · AI share ${Math.round((summary.messages.aiShare ?? 0) * 100)}% · host revivals ${summary.silences.hostBreaksAnswered}/${summary.silences.hostBreaks} · fallbacks ${summary.ai.fallbacks} · p95 ${Math.round(summary.latency.p95 ?? 0)} ms · CSV ${data.messages.length} rows`,
    )
    if (!KEEP) await admin.from('admins').delete().eq('user_id', ana.userId)
  } finally {
    await Promise.all(phones.map((p) => p.close()))
    await admin.rpc('end_test_session', { p_session_id: sessionId })
    if (KEEP) {
      process.stdout.write(`\nKept room "${room.slug}" and session "verify-local ${stamp}" — open /admin to look (Ana is an admin).\n`)
    } else {
      await admin.from('feedback').delete().eq('session_id', sessionId)
      await admin.from('client_events').delete().eq('session_id', sessionId)
      await deleteScratchRoom(admin, room)
      await admin.from('test_sessions').delete().eq('id', sessionId)
    }
  }

  const failed = checks.filter((c) => !c.ok)
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed.\n`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((error: unknown) => {
  process.stderr.write(`\nverify-local stopped: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
