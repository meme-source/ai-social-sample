import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { useAuth } from '../../hooks/useAuth.tsx'
import { APP_VERSION } from '../../lib/env.ts'
import { friendlyError } from '../../lib/errors.ts'
import { supabase } from '../../lib/supabase.ts'
import { ScreenHeader } from '../layout/ScreenHeader.tsx'
import { Icon } from '../ui/Icon.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { loadSessionData, loadSessions, type SessionData, type TestSession } from './load-session-data.ts'
import { SessionControls } from './SessionControls.tsx'
import { SessionReport } from './SessionReport.tsx'

/** /admin — only for user ids in the admins table (enforced by RLS, not just hidden). */
export function AdminPage() {
  const { state } = useAuth()
  const [, navigate] = useLocation()
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)
  const userId = state.status === 'signed_in' ? state.userId : null

  useEffect(() => {
    if (!userId) return
    void supabase.rpc('is_admin').then(({ data, error }) => setIsAdmin(!error && data === true))
  }, [userId])

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        title="Test sessions"
        subtitle={`Admin · app ${APP_VERSION}`}
        onBack={() => navigate('/')}
      />
      {state.status === 'loading' || (userId && isAdmin === null) ? (
        <Spinner label="Checking access" />
      ) : !userId ? (
        <p className="p-6 text-muted">
          Sign in first: open <Link href="/" className="text-accent underline">the app</Link> on this device and pick a nickname.
        </p>
      ) : !isAdmin ? (
        <div className="space-y-3 p-6">
          <p className="font-semibold">This device is not on the admin list.</p>
          <p className="text-sm text-muted">
            Your id is <code className="break-all text-accent">{userId}</code>. Add it with the SQL on the{' '}
            <Link href="/me" className="text-accent underline">My ID</Link> page, then reload.
          </p>
        </div>
      ) : (
        <AdminDashboard />
      )}
    </main>
  )
}

function AdminDashboard() {
  const [sessions, setSessions] = useState<TestSession[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [data, setData] = useState<SessionData | null>(null)
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshSessions = useCallback(async (selectId?: string) => {
    try {
      const list = await loadSessions(supabase)
      setSessions(list)
      setSelectedId((current) => selectId ?? current ?? list[0]?.id ?? null)
    } catch (loadError) {
      setError(friendlyError(loadError, 'Could not load sessions.'))
    }
  }, [])

  const refreshData = useCallback(async (sessionId: string) => {
    setLoading(true)
    setError(null)
    try {
      setData(await loadSessionData(supabase, sessionId))
    } catch (loadError) {
      setError(friendlyError(loadError, 'Could not load this session.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    if (selectedId) void refreshData(selectedId)
  }, [selectedId, refreshData])

  async function runChecks(sessionId: string): Promise<void> {
    setChecking(true)
    setError(null)
    const { error: checkError } = await supabase.rpc('run_checks', { p_session_id: sessionId })
    setChecking(false)
    if (checkError) {
      setError(friendlyError(checkError, 'Checks failed.'))
      return
    }
    await refreshSessions(sessionId)
    await refreshData(sessionId)
  }

  const active = sessions?.find((s) => s.ended_at === null) ?? null
  const selected = sessions?.find((s) => s.id === selectedId) ?? null

  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-4 md:p-6">
      <SessionControls active={active} onChanged={(id) => void refreshSessions(id)} />

      {sessions && sessions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="min-w-[16rem] flex-1">
            <span className="sr-only">Session</span>
            <select
              className="field"
              value={selectedId ?? ''}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} — {new Date(s.started_at).toLocaleString()} {s.ended_at ? '' : '(running)'}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!selectedId || checking}
            onClick={() => selectedId && void runChecks(selectedId)}
          >
            <Icon name="spark" size={18} />
            {checking ? 'Checking…' : 'Run checks'}
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={!selectedId || loading}
            onClick={() => selectedId && void refreshData(selectedId)}
          >
            <Icon name="refresh" size={18} />
            Refresh
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-2xl border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">
          {error}
        </p>
      )}
      {sessions?.length === 0 && <p className="text-muted">No sessions yet. Start one above, then invite testers.</p>}
      {loading && !data && <Spinner label="Loading session" />}
      {selected && data && <SessionReport session={selected} data={data} />}
    </div>
  )
}
