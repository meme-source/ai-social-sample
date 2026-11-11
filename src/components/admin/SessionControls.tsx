import { useState, type FormEvent } from 'react'
import { APP_VERSION } from '../../lib/env.ts'
import { friendlyError } from '../../lib/errors.ts'
import { supabase } from '../../lib/supabase.ts'
import type { TestSession } from './load-session-data.ts'

interface SessionControlsProps {
  active: TestSession | null
  onChanged: (selectId?: string) => void
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** Start or end the recorded test session. Only one can run at a time. */
export function SessionControls({ active, onChanged }: SessionControlsProps) {
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!label.trim()) return
    setBusy(true)
    setError(null)
    const { data, error: startError } = await supabase.rpc('start_test_session', {
      p_label: label.trim(),
      p_app_version: APP_VERSION,
    })
    setBusy(false)
    if (startError) {
      setError(friendlyError(startError))
      return
    }
    setLabel('')
    onChanged((data as TestSession | null)?.id)
  }

  async function end(): Promise<void> {
    if (!active || !window.confirm(`End “${active.label}”? New activity will no longer be recorded under it.`)) return
    setBusy(true)
    setError(null)
    const { error: endError } = await supabase.rpc('end_test_session', { p_session_id: active.id })
    setBusy(false)
    if (endError) setError(friendlyError(endError))
    else onChanged(active.id)
  }

  return (
    <section className="card p-5">
      {active ? (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="chip bg-good/15 text-good">● Recording</p>
            <h2 className="mt-2 font-display text-2xl font-bold">{active.label}</h2>
            <p className="text-sm text-muted">
              Started {dateTime.format(new Date(active.started_at))} · app {active.app_version ?? '—'}
            </p>
          </div>
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void end()}>
            End session
          </button>
        </div>
      ) : (
        <form onSubmit={start} className="flex flex-wrap items-end gap-3">
          <label className="min-w-[14rem] flex-1">
            <span className="mb-1.5 block text-sm text-muted">No session running. Name the next one:</span>
            <input
              className="field"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={80}
              placeholder="e.g. Class 3 — 5 testers, wifi"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || !label.trim()}>
            Start session
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-bad">
          {error}
        </p>
      )}
    </section>
  )
}
