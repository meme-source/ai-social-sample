import { useEffect, useState, type FormEvent } from 'react'
import { friendlyError } from '../../lib/errors.ts'
import {
  GENERAL_CATEGORIES,
  MESSAGE_CATEGORIES,
  NOTE_MAX,
  browserContext,
  sendFeedback,
  type GeneralCategory,
  type MessageCategory,
} from '../../lib/feedback.ts'
import { getRoomStatus } from '../../lib/room-status.ts'
import { Sheet } from '../ui/Sheet.tsx'

type Mode = { kind: 'general' } | { kind: 'message'; messageId: number; roomId: string }

interface FeedbackSheetProps {
  mode: Mode
  onClose: () => void
}

type Phase = 'editing' | 'sending' | 'sent'

/**
 * One sheet for both the global Feedback button and "Something's off" on a
 * message. Parents mount it only while open, so every report starts empty.
 */
export function FeedbackSheet({ mode, onClose }: FeedbackSheetProps) {
  const isMessage = mode.kind === 'message'
  const [category, setCategory] = useState<GeneralCategory | MessageCategory | null>(null)
  const [note, setNote] = useState('')
  const [phase, setPhase] = useState<Phase>('editing')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (phase !== 'sent') return
    const timer = window.setTimeout(onClose, 1_200)
    return () => window.clearTimeout(timer)
  }, [phase, onClose])

  const noteRequired = !isMessage
  const canSend = category !== null && (!noteRequired || note.trim().length > 0) && phase === 'editing'

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!canSend || category === null) return
    setPhase('sending')
    setError(null)
    const status = getRoomStatus()
    const { error: sendError } = await sendFeedback({
      kind: mode.kind,
      category,
      note,
      roomId: mode.kind === 'message' ? mode.roomId : status.roomId,
      messageId: mode.kind === 'message' ? mode.messageId : null,
      context: browserContext(status),
    })
    if (sendError) {
      setError(friendlyError(sendError, 'Could not send. Please try again.'))
      setPhase('editing')
      return
    }
    setPhase('sent')
  }

  const options = isMessage ? MESSAGE_CATEGORIES : GENERAL_CATEGORIES

  return (
    <Sheet open onClose={onClose} title={isMessage ? 'Something’s off?' : 'Send feedback'}>
      {phase === 'sent' ? (
        <p className="animate-rise pb-8 pt-2 text-center text-lg font-semibold text-good">Thanks — saved! 🙏</p>
      ) : (
        <form onSubmit={submit} className="pb-2">
          <div className={isMessage ? 'flex flex-col gap-2' : 'grid grid-cols-3 gap-2'}>
            {options.map((option) => {
              const selected = option.value === category
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setCategory(option.value)}
                  className={`flex flex-col items-start justify-start rounded-2xl border px-3 py-3 text-left text-sm font-semibold transition-colors ${
                    selected
                      ? 'border-accent bg-accent-soft text-text'
                      : 'border-line bg-surface-2 text-muted hover:text-text'
                  }`}
                >
                  {option.label}
                  {'hint' in option && <span className="mt-1 block text-xs font-normal text-faint">{option.hint}</span>}
                </button>
              )
            })}
          </div>

          <label className="mt-4 block">
            <span className="mb-1.5 block text-sm text-muted">
              {isMessage ? 'Anything to add? (optional)' : 'What happened? One line is enough.'}
            </span>
            <input
              className="field"
              value={note}
              maxLength={NOTE_MAX}
              onChange={(event) => setNote(event.target.value)}
              placeholder={isMessage ? 'e.g. it appeared twice after I unlocked my phone' : 'e.g. the keyboard covers the send button'}
              enterKeyHint="send"
            />
          </label>

          {error && (
            <p role="alert" className="mt-3 text-sm text-bad">
              {error}
            </p>
          )}

          <p className="mt-3 text-xs text-faint">
            Sent with: app version, screen size, browser, room and online count — no messages.
          </p>
          <button type="submit" className="btn btn-primary mt-4 w-full" disabled={!canSend}>
            {phase === 'sending' ? 'Sending…' : 'Send'}
          </button>
        </form>
      )}
    </Sheet>
  )
}
