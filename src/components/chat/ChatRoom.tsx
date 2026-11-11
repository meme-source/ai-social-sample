import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import type { Profile } from '../../hooks/useAuth.tsx'
import { usePageVisible } from '../../hooks/usePageVisible.ts'
import { useRoomChat, type RoomInfo } from '../../hooks/useRoomChat.ts'
import { useSilenceTimer } from '../../hooks/useSilenceTimer.ts'
import { friendlyError } from '../../lib/errors.ts'
import { newestConfirmed, type ChatMessage } from '../../lib/messages.ts'
import { supabase } from '../../lib/supabase.ts'
import { FeedbackButton } from '../feedback/FeedbackButton.tsx'
import { FeedbackSheet } from '../feedback/FeedbackSheet.tsx'
import { ScreenHeader } from '../layout/ScreenHeader.tsx'
import { SessionBanner } from '../layout/SessionBanner.tsx'
import { Icon } from '../ui/Icon.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { Composer } from './Composer.tsx'
import { MembersSheet } from './MembersSheet.tsx'
import { MessageList } from './MessageList.tsx'

/** Loads the room by its slug (/r/pop-music), then shows the chat. */
export function ChatRoomPage({ slug, me }: { slug: string; me: Profile }) {
  const [room, setRoom] = useState<RoomInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, navigate] = useLocation()

  useEffect(() => {
    let active = true
    void supabase
      .from('rooms')
      .select('id, slug, name, topic, emoji')
      .eq('slug', slug)
      .maybeSingle()
      .then(({ data, error: loadError }) => {
        if (!active) return
        if (loadError) setError(friendlyError(loadError, 'Could not open this room.'))
        else if (!data) setError('This room does not exist.')
        else setRoom(data)
      })
    return () => {
      active = false
    }
  }, [slug])

  if (error) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-muted">{error}</p>
        <button type="button" className="btn btn-quiet" onClick={() => navigate('/')}>
          Back to rooms
        </button>
      </main>
    )
  }
  if (!room) return <Spinner label="Opening room" />
  return <ChatRoom room={room} me={me} />
}

function ConnectionLabel({ status, online }: { status: string; online: number }) {
  if (status === 'SUBSCRIBED') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-good" />
        {online} online
      </span>
    )
  }
  return <span className="text-warn">{status === 'CONNECTING' ? 'Connecting…' : 'Reconnecting…'}</span>
}

function ChatRoom({ room, me }: { room: RoomInfo; me: Profile }) {
  const chat = useRoomChat(room, me.id)
  const visible = usePageVisible()
  const [, navigate] = useLocation()
  const [reported, setReported] = useState<ChatMessage | null>(null)
  const [membersOpen, setMembersOpen] = useState(false)

  const newest = newestConfirmed(chat.messages)
  useSilenceTimer({
    roomId: room.id,
    anchorServerMs: newest?.createdAtMs ?? chat.enteredAtServerMs,
    clockOffsetMs: chat.clockOffsetMs,
    enabled: chat.status === 'ready' && chat.channelStatus === 'SUBSCRIBED' && visible,
  })

  const closeReport = useCallback(() => setReported(null), [])
  const closeMembers = useCallback(() => setMembersOpen(false), [])

  return (
    <>
      <ScreenHeader
        onBack={() => navigate('/')}
        leading={<span className="text-2xl">{room.emoji}</span>}
        title={room.name}
        subtitle={<ConnectionLabel status={chat.channelStatus} online={chat.onlineCount} />}
        actions={
          <>
            <button type="button" className="icon-btn" onClick={() => setMembersOpen(true)} aria-label="Members">
              <Icon name="people" />
            </button>
            <FeedbackButton compact />
          </>
        }
      />
      <SessionBanner />

      {chat.status === 'loading' && <Spinner label="Joining" />}
      {chat.status === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="text-muted">{chat.error}</p>
          <button type="button" className="btn btn-quiet" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      )}
      {chat.status === 'ready' && (
        <MessageList
          messages={chat.messages}
          roster={chat.roster}
          meId={me.id}
          onReport={setReported}
          onRetry={chat.retry}
        />
      )}

      <Composer roster={chat.roster} meId={me.id} disabled={chat.status !== 'ready'} onSend={chat.send} />

      {reported?.id != null && (
        <FeedbackSheet mode={{ kind: 'message', messageId: reported.id, roomId: room.id }} onClose={closeReport} />
      )}
      <MembersSheet
        open={membersOpen}
        onClose={closeMembers}
        roster={chat.roster}
        meId={me.id}
        onlineCount={chat.onlineCount}
      />
    </>
  )
}
