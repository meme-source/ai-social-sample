import { useCallback, useState } from 'react'
import { Icon } from '../ui/Icon.tsx'
import { FeedbackSheet } from './FeedbackSheet.tsx'

interface FeedbackButtonProps {
  /** Icon only, for crowded headers (the chat room). */
  compact?: boolean
}

/** The global Feedback button that sits in every screen's header. */
export function FeedbackButton({ compact = false }: FeedbackButtonProps) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      {compact ? (
        <button type="button" onClick={() => setOpen(true)} className="icon-btn" aria-label="Send feedback">
          <Icon name="flag" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="chip border border-line bg-surface-2 py-1.5 text-muted transition-colors hover:text-text"
        >
          <Icon name="flag" size={15} />
          Feedback
        </button>
      )}
      {open && <FeedbackSheet mode={{ kind: 'general' }} onClose={close} />}
    </>
  )
}
