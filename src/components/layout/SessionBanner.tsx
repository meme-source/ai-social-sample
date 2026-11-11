import { useActiveSession } from '../../hooks/useActiveSession.ts'

/** A thin strip telling testers a recorded test session is running. */
export function SessionBanner() {
  const session = useActiveSession()
  if (!session) return null
  return (
    <div className="flex items-center justify-center gap-2 border-b border-line bg-accent-soft px-4 py-1.5 text-xs text-text">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-accent" />
      </span>
      <span className="truncate">
        Test session <strong className="font-semibold">{session.label}</strong> · feedback and app logs are recorded
      </span>
    </div>
  )
}
