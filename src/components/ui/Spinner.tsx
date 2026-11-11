interface SpinnerProps {
  label?: string
}

export function Spinner({ label = 'Loading' }: SpinnerProps) {
  return (
    <div role="status" className="flex flex-1 flex-col items-center justify-center gap-3 text-muted">
      <span className="size-7 animate-spin rounded-full border-2 border-white/15 border-t-accent" />
      <span className="text-sm">{label}…</span>
    </div>
  )
}
