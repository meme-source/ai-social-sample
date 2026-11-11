/** Everything recorded during one test session, fetched page by page (1000 rows per request). */
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'

export interface TestSession {
  id: string
  label: string
  app_version: string | null
  started_at: string
  ended_at: string | null
  last_checked_at: string | null
}

export interface MessageRecord {
  id: number
  room_id: string
  profile_id: string | null
  kind: 'chat' | 'system'
  content: string
  client_msg_id: string
  created_at: string
}

export interface AiEventRecord {
  id: number
  created_at: string
  room_id: string
  trigger: string
  caller_id: string | null
  trigger_message_id: number | null
  bot_id: string | null
  decision: 'spoke' | 'skipped'
  reason: string | null
  message_id: number | null
  llm_attempted: boolean
  provider: string | null
  model: string | null
  latency_ms: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  fallback_used: boolean
  error_code: string | null
  function_version: string | null
}

export interface ClientEventRecord {
  id: number
  server_ts: string
  client_ts: string
  type: string
  profile_id: string
  room_id: string | null
  app_version: string | null
  data: Record<string, unknown> | null
}

export interface FeedbackRecord {
  id: number
  created_at: string
  kind: 'general' | 'message'
  category: string
  note: string | null
  message_id: number | null
  room_id: string | null
  profile_id: string
  app_version: string | null
  context: Record<string, unknown> | null
}

export interface AnomalyRecord {
  id: number
  detected_at: string
  type: string
  severity: 'low' | 'medium' | 'high'
  room_id: string | null
  related_ids: string[]
  details: Record<string, unknown>
}

export interface SessionData {
  messages: MessageRecord[]
  aiEvents: AiEventRecord[]
  clientEvents: ClientEventRecord[]
  feedback: FeedbackRecord[]
  anomalies: AnomalyRecord[]
  botProfileIds: Set<string>
  names: Map<string, string>
}

const PAGE = 1000
const MAX_ROWS = 50_000

type PageResult<T> = PromiseLike<{ data: T[] | null; error: PostgrestError | null }>

async function fetchAll<T>(page: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  let rows: T[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw error
    rows = [...rows, ...(data ?? [])]
    if (!data || data.length < PAGE) break
  }
  return rows
}

async function fetchNames(supabase: SupabaseClient, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', ids.slice(i, i + 100))
    if (error) throw error
    for (const p of data ?? []) names.set(p.id, p.display_name)
  }
  return names
}

/** The client is passed in so the admin page (browser) and scripts (Node) share these queries. */
export async function loadSessions(supabase: SupabaseClient): Promise<TestSession[]> {
  const { data, error } = await supabase
    .from('test_sessions')
    .select('id, label, app_version, started_at, ended_at, last_checked_at')
    .order('started_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function loadSessionData(supabase: SupabaseClient, sessionId: string): Promise<SessionData> {
  const [messages, aiEvents, clientEvents, feedback, anomalies, bots] = await Promise.all([
    fetchAll<MessageRecord>((from, to) =>
      supabase
        .from('messages')
        .select('id, room_id, profile_id, kind, content, client_msg_id, created_at')
        .eq('session_id', sessionId)
        .order('id')
        .range(from, to),
    ),
    fetchAll<AiEventRecord>((from, to) =>
      supabase
        .from('ai_events')
        .select(
          'id, created_at, room_id, trigger, caller_id, trigger_message_id, bot_id, decision, reason, message_id, llm_attempted, provider, model, latency_ms, prompt_tokens, completion_tokens, fallback_used, error_code, function_version',
        )
        .eq('session_id', sessionId)
        .order('id')
        .range(from, to),
    ),
    fetchAll<ClientEventRecord>((from, to) =>
      supabase
        .from('client_events')
        .select('id, server_ts, client_ts, type, profile_id, room_id, app_version, data')
        .eq('session_id', sessionId)
        .order('id')
        .range(from, to),
    ),
    fetchAll<FeedbackRecord>((from, to) =>
      supabase
        .from('feedback')
        .select('id, created_at, kind, category, note, message_id, room_id, profile_id, app_version, context')
        .eq('session_id', sessionId)
        .order('id')
        .range(from, to),
    ),
    fetchAll<AnomalyRecord>((from, to) =>
      supabase
        .from('anomalies')
        .select('id, detected_at, type, severity, room_id, related_ids, details')
        .eq('session_id', sessionId)
        .order('id')
        .range(from, to),
    ),
    fetchAll<{ profile_id: string }>((from, to) => supabase.from('bots').select('profile_id').range(from, to)),
  ])

  const profileIds = new Set<string>()
  for (const m of messages) if (m.profile_id) profileIds.add(m.profile_id)
  for (const e of clientEvents) profileIds.add(e.profile_id)
  for (const f of feedback) profileIds.add(f.profile_id)

  return {
    messages,
    aiEvents,
    clientEvents,
    feedback,
    anomalies,
    botProfileIds: new Set(bots.map((b) => b.profile_id)),
    names: await fetchNames(supabase, [...profileIds]),
  }
}
