import type { ReactNode } from 'react'
import { Icon } from '../ui/Icon.tsx'

interface ScreenHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  leading?: ReactNode
  onBack?: () => void
  actions?: ReactNode
}

export function ScreenHeader({ title, subtitle, leading, onBack, actions }: ScreenHeaderProps) {
  return (
    <header className="relative z-10 flex items-center gap-2 border-b border-line bg-ink/70 px-3 py-2.5 backdrop-blur-xl">
      {onBack && (
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
      )}
      {leading}
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-[1.15rem] leading-tight font-bold tracking-tight">{title}</div>
        {subtitle && <div className="truncate text-xs text-muted">{subtitle}</div>}
      </div>
      {actions}
    </header>
  )
}
