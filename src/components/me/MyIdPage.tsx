import { useState } from 'react'
import { useLocation } from 'wouter'
import { useAuth } from '../../hooks/useAuth.tsx'
import { APP_VERSION } from '../../lib/env.ts'
import { identitySlot } from '../../lib/supabase.ts'
import { ScreenHeader } from '../layout/ScreenHeader.tsx'
import { Icon } from '../ui/Icon.tsx'

/**
 * Shows this person's user id — to add them to the admin list, or to find
 * and delete their data on request.
 */
export function MyIdPage() {
  const { state, signOut } = useAuth()
  const [, navigate] = useLocation()
  const [copied, setCopied] = useState(false)
  const userId = state.status === 'signed_in' ? state.userId : null
  const sql = userId ? `insert into public.admins (user_id, note) values ('${userId}', 'added from /me');` : ''

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader title="My ID" onBack={() => navigate('/')} />
      <div className="flex-1 space-y-6 overflow-y-auto p-6">
        {!userId ? (
          <p className="text-muted">You are not signed in on this device yet. Open the app and pick a nickname first.</p>
        ) : (
          <>
            <section>
              <h2 className="text-sm font-semibold text-muted">Your user id</h2>
              <p className="mt-2 rounded-2xl border border-line bg-surface-1 p-4 font-mono text-sm break-all select-all">
                {userId}
              </p>
              <button type="button" className="btn btn-quiet mt-3" onClick={() => void copy(userId)}>
                <Icon name="copy" size={18} />
                {copied ? 'Copied' : 'Copy id'}
              </button>
              <p className="mt-3 text-sm text-muted">
                Show this to the organiser if you want your data deleted. It is tied to this browser
                {identitySlot ? ` (test slot ${identitySlot})` : ''}.
              </p>
            </section>

            <section className="card p-5">
              <h2 className="font-display text-lg font-bold">Make this device an admin</h2>
              <p className="mt-1 text-sm text-muted">
                Run this once in Supabase → SQL Editor, then open <code className="text-accent">/admin</code>.
              </p>
              <pre className="mt-3 overflow-x-auto rounded-xl bg-ink p-3 text-xs leading-relaxed text-muted">{sql}</pre>
              <button type="button" className="btn btn-quiet mt-3" onClick={() => void copy(sql)}>
                <Icon name="copy" size={18} />
                Copy SQL
              </button>
            </section>

            <section>
              <button
                type="button"
                className="text-sm text-faint underline underline-offset-4 hover:text-bad"
                onClick={() => void signOut().then(() => navigate('/'))}
              >
                Sign out and start as a new tester
              </button>
            </section>
          </>
        )}
        <p className="text-xs text-faint">App version {APP_VERSION}</p>
      </div>
    </main>
  )
}
