import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { RosterEntry } from '../../hooks/useRoomChat.ts'
import { Avatar } from '../ui/Avatar.tsx'
import { Icon } from '../ui/Icon.tsx'

interface ComposerProps {
  roster: ReadonlyMap<string, RosterEntry>
  meId: string
  disabled: boolean
  onSend: (text: string) => void
}

const MAX_LENGTH = 1000
const MAX_HEIGHT_PX = 132

/** "@Th" right before the caret → suggest members whose name starts with "Th". */
function mentionQueryAt(text: string, caret: number): string | null {
  const match = /(?:^|\s)@([^\s@]{0,20})$/u.exec(text.slice(0, caret))
  return match ? (match[1] ?? '') : null
}

export function Composer({ roster, meId, disabled, onSend }: ComposerProps) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const query = mentionQueryAt(text, caret)
  const suggestions = useMemo(() => {
    if (query === null) return []
    const q = query.toLowerCase()
    return [...roster.values()]
      .filter((r) => r.profileId !== meId && r.displayName.toLowerCase().startsWith(q))
      .slice(0, 5)
  }, [query, roster, meId])

  function resize(): void {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }

  function update(value: string, caretAt: number): void {
    setText(value)
    setCaret(caretAt)
    requestAnimationFrame(resize)
  }

  function pickMention(entry: RosterEntry): void {
    if (query === null) return
    const start = caret - query.length - 1 // position of "@"
    const next = `${text.slice(0, start)}@${entry.displayName} ${text.slice(caret)}`
    const nextCaret = start + entry.displayName.length + 2
    update(next, nextCaret)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  function submit(event?: FormEvent): void {
    event?.preventDefault()
    if (disabled || !text.trim()) return
    onSend(text)
    update('', 0)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // isComposing: a Chinese/Japanese IME is still choosing characters — Enter belongs to it.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (suggestions[0] && query !== null && query.length > 0) pickMention(suggestions[0])
      else submit()
    }
  }

  return (
    <form onSubmit={submit} className="safe-bottom relative border-t border-line bg-ink/80 px-3 pt-2.5 backdrop-blur-xl">
      {suggestions.length > 0 && (
        <ul className="absolute right-3 bottom-full left-3 mb-2 animate-rise overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-2xl">
          {suggestions.map((entry) => (
            <li key={entry.profileId}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()} // keep the keyboard open
                onClick={() => pickMention(entry)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-3"
              >
                <Avatar avatar={entry.avatar} size={28} />
                <span className="font-semibold">{entry.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="sr-only">Message</span>
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            maxLength={MAX_LENGTH}
            disabled={disabled}
            placeholder={disabled ? 'Connecting…' : 'Message · @ to mention'}
            enterKeyHint="send"
            onChange={(event) => update(event.target.value, event.target.selectionStart)}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            className="field block max-h-[132px] resize-none rounded-[1.4rem] py-2.5 leading-snug"
          />
        </label>
        <button
          type="submit"
          aria-label="Send"
          disabled={disabled || !text.trim()}
          className="btn btn-primary size-11 shrink-0 p-0"
        >
          <Icon name="send" />
        </button>
      </div>
    </form>
  )
}
