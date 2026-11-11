import { memo, type ReactNode } from 'react'
import type { ChatMessage } from '../../lib/messages.ts'
import type { RosterEntry } from '../../hooks/useRoomChat.ts'
import { Avatar } from '../ui/Avatar.tsx'

interface MessageBubbleProps {
  message: ChatMessage
  author: RosterEntry | undefined
  mine: boolean
  showAuthor: boolean
  selected: boolean
  mentionNames: readonly string[]
  onSelect: (message: ChatMessage) => void
  onReport: (message: ChatMessage) => void
  onRetry: (clientMsgId: string) => void
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Bold the "@Name" parts of a message. */
function withMentions(text: string, names: readonly string[]): ReactNode {
  if (names.length === 0 || !text.includes('@')) return text
  const pattern = new RegExp(`(@(?:${[...names].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')}))`, 'giu')
  return text.split(pattern).map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-semibold text-[#e3d5ff]">
        {part}
      </strong>
    ) : (
      part
    ),
  )
}

function MessageBubbleView({
  message,
  author,
  mine,
  showAuthor,
  selected,
  mentionNames,
  onSelect,
  onReport,
  onRetry,
}: MessageBubbleProps) {
  if (message.kind === 'system') {
    return (
      <li className="flex justify-center py-2">
        <span className="chip bg-surface-2/80 font-medium text-faint">{message.content}</span>
      </li>
    )
  }

  const pending = message.status === 'sending'
  const failed = message.status === 'failed'

  return (
    <li className={`flex animate-rise gap-2 ${mine ? 'justify-end' : 'justify-start'} ${showAuthor ? 'mt-3' : 'mt-0.5'}`}>
      {!mine && (
        <span className="w-8 shrink-0 self-end">{showAuthor && <Avatar avatar={author?.avatar} size={32} />}</span>
      )}
      <div className={`flex max-w-[78%] flex-col ${mine ? 'items-end' : 'items-start'}`}>
        {showAuthor && !mine && (
          <span className="mb-1 ml-3 text-xs font-semibold text-muted">{author?.displayName ?? '…'}</span>
        )}
        <button
          type="button"
          onClick={() => onSelect(message)}
          className={`rounded-[1.35rem] px-3.5 py-2 text-left text-[0.97rem] leading-snug break-words whitespace-pre-wrap transition-opacity ${
            mine
              ? 'rounded-br-md bg-gradient-to-br from-accent to-accent-strong text-white shadow-[0_8px_24px_-14px_rgb(124_77_255/0.9)]'
              : 'rounded-bl-md border border-line bg-surface-2 text-text'
          } ${pending ? 'opacity-60' : ''} ${selected ? 'ring-2 ring-accent/60' : ''}`}
        >
          {withMentions(message.content, mentionNames)}
        </button>

        {pending && <span className="mt-1 mr-2 text-[0.7rem] text-faint">Sending…</span>}
        {failed && (
          <button
            type="button"
            onClick={() => onRetry(message.clientMsgId)}
            className="mt-1 mr-2 text-[0.75rem] font-semibold text-bad"
          >
            Not sent · Tap to retry
          </button>
        )}
        {selected && message.id !== null && (
          <span className="mt-1 flex animate-fade items-center gap-3 px-2 text-[0.75rem] text-faint">
            {timeFormat.format(message.createdAtMs)}
            <button type="button" onClick={() => onReport(message)} className="font-semibold text-accent">
              Something’s off?
            </button>
          </span>
        )}
      </div>
    </li>
  )
}

export const MessageBubble = memo(MessageBubbleView)
