import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RosterEntry } from '../../hooks/useRoomChat.ts'
import type { ChatMessage } from '../../lib/messages.ts'
import { MessageBubble } from './MessageBubble.tsx'

interface MessageListProps {
  messages: readonly ChatMessage[]
  roster: ReadonlyMap<string, RosterEntry>
  meId: string
  onReport: (message: ChatMessage) => void
  onRetry: (clientMsgId: string) => void
}

const GROUP_GAP_MS = 2 * 60_000
const DIVIDER_GAP_MS = 10 * 60_000
const NEAR_BOTTOM_PX = 120

const dividerFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })

export function MessageList({ messages, roster, meId, onReport, onRetry }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const seenCount = useRef(0)
  const [unseen, setUnseen] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)

  const mentionNames = useMemo(() => [...roster.values()].map((r) => r.displayName), [roster])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    stickToBottom.current = true
    setUnseen(0)
  }, [])

  // After each render: follow the conversation if the reader is at the bottom
  // (or just sent something); otherwise count what they have not seen yet.
  useLayoutEffect(() => {
    const added = messages.length - seenCount.current
    seenCount.current = messages.length
    const last = messages.at(-1)
    if (stickToBottom.current || (last && last.profileId === meId && last.id === null)) {
      scrollToBottom()
    } else if (added > 0) {
      setUnseen((n) => n + added)
    }
  }, [messages, meId, scrollToBottom])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    if (stickToBottom.current) setUnseen(0)
  }

  const onSelect = useCallback((m: ChatMessage) => {
    setSelected((current) => (current === m.clientMsgId ? null : m.clientMsgId))
  }, [])

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain px-3 pt-3 pb-4">
        {messages.length === 0 && (
          <p className="mx-auto mt-16 max-w-[26ch] text-center text-muted">
            It’s quiet in here. Say hi — or wait a moment and someone will.
          </p>
        )}
        <ul aria-live="polite" aria-relevant="additions">
          {messages.map((m, i) => {
            const prev = messages[i - 1]
            const showDivider = !prev || m.createdAtMs - prev.createdAtMs > DIVIDER_GAP_MS
            const showAuthor =
              showDivider ||
              !prev ||
              prev.kind !== 'chat' ||
              prev.profileId !== m.profileId ||
              m.createdAtMs - prev.createdAtMs > GROUP_GAP_MS
            return (
              <MessageRow key={m.clientMsgId} showDivider={showDivider} at={m.createdAtMs}>
                <MessageBubble
                  message={m}
                  author={m.profileId ? roster.get(m.profileId) : undefined}
                  mine={m.profileId === meId}
                  showAuthor={showAuthor}
                  selected={selected === m.clientMsgId}
                  mentionNames={mentionNames}
                  onSelect={onSelect}
                  onReport={onReport}
                  onRetry={onRetry}
                />
              </MessageRow>
            )
          })}
        </ul>
      </div>
      {unseen > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="chip absolute bottom-3 left-1/2 -translate-x-1/2 animate-rise bg-accent px-3 py-1.5 text-white shadow-lg"
        >
          {unseen} new ↓
        </button>
      )}
    </div>
  )
}

function MessageRow({ showDivider, at, children }: { showDivider: boolean; at: number; children: ReactNode }) {
  return (
    <>
      {showDivider && (
        <li className="flex justify-center pt-4 pb-1 text-[0.7rem] font-semibold tracking-wide text-faint uppercase">
          {dividerFormat.format(at)}
        </li>
      )}
      {children}
    </>
  )
}
