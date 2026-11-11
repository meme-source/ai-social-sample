import { useMemo, type ReactNode } from 'react'
import { AI_RULES } from '../../../supabase/functions/_shared/ai-rules.ts'
import { summarizeSession } from '../../lib/session-summary.ts'
import { Icon } from '../ui/Icon.tsx'
import { EXPORT_TABLES, exportTable } from './exports.ts'
import type { AnomalyRecord, SessionData, TestSession } from './load-session-data.ts'

interface SessionReportProps {
  session: TestSession
  data: SessionData
}

const LATENCY_LIMIT_MS = 2_000
const RATIO_RULE = `rule: ≤ ${AI_RULES.ratioMaxAi} AI in any ${AI_RULES.ratioWindow} in a row`

const pct = (value: number | null): string => (value === null ? '—' : `${Math.round(value * 100)}%`)

function duration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1_000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1_000)} s`
}

type Tone = 'good' | 'bad' | 'neutral'
const TONE_CLASS: Record<Tone, string> = { good: 'text-good', bad: 'text-bad', neutral: 'text-text' }

function Tile({ label, value, note, tone = 'neutral' }: { label: string; value: ReactNode; note?: ReactNode; tone?: Tone }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</div>
      <div className={`mt-2 font-display text-3xl leading-none font-extrabold tracking-tight ${TONE_CLASS[tone]}`}>
        {value}
      </div>
      {note && <div className="mt-2 text-xs text-faint">{note}</div>}
    </div>
  )
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h3 className="font-display text-lg font-bold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Bars({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const max = Math.max(1, ...entries.map(([, n]) => n))
  if (entries.length === 0) return <p className="text-sm text-faint">None.</p>
  return (
    <ul className="space-y-2">
      {entries.map(([key, n]) => (
        <li key={key} className="grid grid-cols-[9rem_1fr_2.5rem] items-center gap-3 text-sm">
          <span className="truncate text-muted">{key.replaceAll('_', ' ')}</span>
          <span className="h-2 overflow-hidden rounded-full bg-surface-3">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${(n / max) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums">{n}</span>
        </li>
      ))}
    </ul>
  )
}

const SEVERITY_CLASS: Record<AnomalyRecord['severity'], string> = {
  high: 'bg-bad/15 text-bad',
  medium: 'bg-warn/15 text-warn',
  low: 'bg-surface-3 text-muted',
}

export function SessionReport({ session, data }: SessionReportProps) {
  const summary = useMemo(
    () =>
      summarizeSession({
        messages: data.messages,
        botProfileIds: data.botProfileIds,
        names: data.names,
        aiEvents: data.aiEvents,
        clientEvents: data.clientEvents,
        feedbackProfileIds: data.feedback.map((f) => f.profile_id),
      }),
    [data],
  )
  const clientErrorTotal = Object.values(summary.clientErrors).reduce((a, b) => a + b, 0)
  // The rule is about any 12 messages in a row, not the overall average, so the
  // tile's colour comes from run_checks' window check.
  const ratioBreached = data.anomalies.some((a) => a.type === 'ai_share_over_third')
  const ratioTone: Tone = ratioBreached ? 'bad' : session.last_checked_at ? 'good' : 'neutral'
  const highAnomalies = data.anomalies.filter((a) => a.severity === 'high').length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="People"
          value={summary.participants.length}
          note={`${summary.neverSpoke.length} never spoke · median ${duration(summary.medianTimeToFirstMessageMs)} to first message`}
        />
        <Tile label="Messages" value={summary.messages.human + summary.messages.ai} note={`${summary.messages.human} human · ${summary.messages.ai} AI`} />
        <Tile
          label="AI share"
          value={pct(summary.messages.aiShare)}
          tone={ratioTone}
          note={`overall · ${ratioBreached ? 'over the limit in some window' : RATIO_RULE}`}
        />
        <Tile
          label="Host revivals"
          value={`${summary.silences.hostBreaksAnswered}/${summary.silences.hostBreaks}`}
          note={`human replied within 60 s · ${summary.silences.count} silences ≥ 45 s`}
        />
        <Tile
          label="Delivery p95"
          value={duration(summary.latency.p95)}
          tone={summary.latency.p95 === null ? 'neutral' : summary.latency.p95 <= LATENCY_LIMIT_MS ? 'good' : 'bad'}
          note={`${summary.latency.n} samples · p50 ${duration(summary.latency.p50)}`}
        />
        <Tile
          label="LLM calls"
          value={summary.ai.llmCalls}
          note={`${summary.ai.fallbacks} fallbacks · ${summary.ai.llmErrors} errors · p50 ${duration(summary.ai.llmLatency.p50)}`}
          tone={summary.ai.fallbacks > 0 ? 'bad' : 'neutral'}
        />
        <Tile label="Client errors" value={clientErrorTotal} tone={clientErrorTotal > 0 ? 'bad' : 'good'} note="JS, requests, realtime" />
        <Tile
          label="Anomalies"
          value={data.anomalies.length}
          tone={highAnomalies > 0 ? 'bad' : data.anomalies.length > 0 ? 'neutral' : 'good'}
          note={session.last_checked_at ? `${highAnomalies} high · checked` : 'run checks to update'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Participants" aside={<span className="text-xs text-faint">humans only</span>}>
          {summary.participants.length === 0 ? (
            <p className="text-sm text-faint">Nobody yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-semibold">Name</th>
                  <th className="pb-2 text-right font-semibold">Messages</th>
                  <th className="pb-2 text-right font-semibold">First message after</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {summary.participants.map((p) => (
                  <tr key={p.profileId}>
                    <td className="py-2">{p.name}</td>
                    <td className="py-2 text-right tabular-nums">{p.messages}</td>
                    <td className={`py-2 text-right tabular-nums ${p.messages === 0 ? 'text-bad' : ''}`}>
                      {p.messages === 0 ? 'never spoke' : duration(p.timeToFirstMessageMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="AI host decisions" aside={<span className="text-xs text-faint">{summary.ai.triggers} triggers · {summary.ai.spoke} spoke</span>}>
          <div className="space-y-5">
            <div>
              <h4 className="mb-2 text-xs font-semibold text-muted uppercase">Why it stayed quiet</h4>
              <Bars counts={summary.ai.skippedByReason} />
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold text-muted uppercase">Errors and fallbacks</h4>
              <Bars counts={{ ...summary.ai.errorCodes, ...Object.fromEntries(Object.entries(summary.clientErrors).map(([k, v]) => [`client: ${k}`, v])) }} />
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold text-muted uppercase">Messages realtime missed (recovered by catch-up)</h4>
              <Bars counts={summary.recovered} />
            </div>
            <p className="text-xs text-faint">
              Tokens: {summary.ai.promptTokens} prompt · {summary.ai.completionTokens} completion. Longest silence{' '}
              {duration(summary.silences.longestMs)}.
            </p>
          </div>
        </Section>
      </div>

      <Section title="Anomalies" aside={<span className="text-xs text-faint">from run_checks()</span>}>
        {data.anomalies.length === 0 ? (
          <p className="text-sm text-faint">
            {session.last_checked_at ? 'No anomalies found. 🎉' : 'Not checked yet — press “Run checks”.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {data.anomalies.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start gap-3 rounded-2xl border border-line bg-surface-2/60 p-3 text-sm">
                <span className={`chip ${SEVERITY_CLASS[a.severity]}`}>{a.severity}</span>
                <span className="font-semibold">{a.type.replaceAll('_', ' ')}</span>
                <code className="min-w-0 flex-1 text-xs break-all text-muted">{JSON.stringify(a.details)}</code>
                <span className="text-xs text-faint">{a.related_ids.join(' ')}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Tester feedback" aside={<span className="text-xs text-faint">{data.feedback.length} reports</span>}>
        {data.feedback.length === 0 ? (
          <p className="text-sm text-faint">No feedback yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.feedback.map((f) => (
              <li key={f.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5 text-sm">
                <span className="chip bg-accent-soft text-accent">{f.category.replaceAll('_', ' ')}</span>
                <span className="min-w-0 flex-1">{f.note ?? <span className="text-faint">(no note)</span>}</span>
                <span className="text-xs text-faint">
                  {data.names.get(f.profile_id) ?? 'someone'}
                  {f.message_id ? ` · message ${f.message_id}` : ''} · app {f.app_version ?? '?'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Export CSV">
        <div className="flex flex-wrap gap-2">
          {EXPORT_TABLES.map(({ table, label }) => (
            <button
              key={table}
              type="button"
              className="btn btn-quiet min-h-10 text-sm"
              onClick={() => exportTable(table, session, data, summary)}
            >
              <Icon name="download" size={17} />
              {label}
            </button>
          ))}
        </div>
      </Section>
    </div>
  )
}
