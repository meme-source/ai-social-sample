/** One CSV per table, with readable sender names next to raw ids. */
import { downloadCsv, toCsv } from '../../lib/csv.ts'
import type { SessionSummary } from '../../lib/session-summary.ts'
import type { SessionData, TestSession } from './load-session-data.ts'

export type ExportTable = 'messages' | 'participants' | 'feedback' | 'client_events' | 'ai_events' | 'anomalies'

/** Fixed columns, so even an empty table exports a header row. */
const COLUMNS: Record<ExportTable, string[]> = {
  messages: ['id', 'created_at', 'room_id', 'sender', 'sender_type', 'profile_id', 'kind', 'content', 'client_msg_id'],
  participants: ['profile_id', 'name', 'messages', 'first_seen_at', 'first_message_at', 'seconds_to_first_message'],
  feedback: ['id', 'created_at', 'kind', 'category', 'note', 'message_id', 'room_id', 'profile_id', 'sender', 'app_version', 'context'],
  client_events: ['id', 'server_ts', 'client_ts', 'type', 'profile_id', 'room_id', 'app_version', 'data'],
  ai_events: [
    'id', 'created_at', 'room_id', 'trigger', 'caller_id', 'trigger_message_id', 'bot_id', 'decision', 'reason',
    'message_id', 'llm_attempted', 'provider', 'model', 'latency_ms', 'prompt_tokens', 'completion_tokens',
    'fallback_used', 'error_code', 'function_version',
  ],
  anomalies: ['id', 'detected_at', 'type', 'severity', 'room_id', 'related_ids', 'details'],
}

export const EXPORT_TABLES: { table: ExportTable; label: string }[] = [
  { table: 'messages', label: 'Messages' },
  { table: 'participants', label: 'Participants' },
  { table: 'feedback', label: 'Feedback' },
  { table: 'client_events', label: 'Client events' },
  { table: 'ai_events', label: 'AI events' },
  { table: 'anomalies', label: 'Anomalies' },
]

function rowsFor(table: ExportTable, data: SessionData, summary: SessionSummary): Record<string, unknown>[] {
  const name = (id: string | null): string => (id ? (data.names.get(id) ?? '') : '')
  switch (table) {
    case 'messages':
      return data.messages.map((m) => ({
        id: m.id,
        created_at: m.created_at,
        room_id: m.room_id,
        sender: name(m.profile_id),
        sender_type: m.kind === 'system' ? 'system' : m.profile_id && data.botProfileIds.has(m.profile_id) ? 'ai' : 'human',
        profile_id: m.profile_id,
        kind: m.kind,
        content: m.content,
        client_msg_id: m.client_msg_id,
      }))
    case 'participants':
      return summary.participants.map((p) => ({
        profile_id: p.profileId,
        name: p.name,
        messages: p.messages,
        first_seen_at: p.firstSeenAt ? new Date(p.firstSeenAt).toISOString() : null,
        first_message_at: p.firstMessageAt ? new Date(p.firstMessageAt).toISOString() : null,
        seconds_to_first_message: p.timeToFirstMessageMs === null ? null : Math.round(p.timeToFirstMessageMs / 1000),
      }))
    case 'feedback':
      return data.feedback.map((f) => ({ ...f, sender: name(f.profile_id) }))
    case 'client_events':
      return data.clientEvents.map((e) => ({ ...e }))
    case 'ai_events':
      return data.aiEvents.map((e) => ({ ...e }))
    case 'anomalies':
      return data.anomalies.map((a) => ({ ...a }))
  }
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'session'

export function exportTable(table: ExportTable, session: TestSession, data: SessionData, summary: SessionSummary): void {
  downloadCsv(`${slug(session.label)}-${table}.csv`, toCsv(rowsFor(table, data, summary), COLUMNS[table]))
}
