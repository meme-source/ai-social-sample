import { useState } from 'react'
import { useAuth } from '../../hooks/useAuth.tsx'
import { CONSENT_POINTS } from './consent-text.ts'

export function ConsentScreen() {
  const { acceptConsent } = useAuth()
  const [agreed, setAgreed] = useState(false)

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-6 pt-10 pb-6">
        <p className="chip mb-5 bg-accent-soft text-accent">Before you join</p>
        <h1 className="font-display text-[2.4rem] leading-[1.02] font-extrabold tracking-tight">
          Chat rooms where some members are <span className="text-accent">AI</span>.
        </h1>
        <p className="mt-4 max-w-[34ch] text-muted">Please read this — it takes a minute.</p>

        <ol className="mt-8 space-y-5">
          {CONSENT_POINTS.map((point, index) => (
            <li key={point.title} className="flex gap-4 animate-rise" style={{ animationDelay: `${index * 60}ms` }}>
              <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface-2 font-display text-sm font-bold text-accent ring-1 ring-line">
                {index + 1}
              </span>
              <div>
                <h2 className="font-semibold">{point.title}</h2>
                <p className="mt-1 text-[0.95rem] leading-relaxed text-muted">{point.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="safe-bottom border-t border-line bg-ink/80 px-6 pt-4 backdrop-blur">
        <label className="flex cursor-pointer items-start gap-3 py-1 text-[0.95rem]">
          <input
            type="checkbox"
            className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]"
            checked={agreed}
            onChange={(event) => setAgreed(event.target.checked)}
          />
          <span>I understand and agree to take part in this test.</span>
        </label>
        <button type="button" className="btn btn-primary mt-4 w-full" disabled={!agreed} onClick={acceptConsent}>
          Continue
        </button>
      </div>
    </main>
  )
}
