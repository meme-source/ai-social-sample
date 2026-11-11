import { useEffect, useState } from 'react'
import { Link } from 'wouter'
import { useAuth } from '../../hooks/useAuth.tsx'
import { APP_VERSION } from '../../lib/env.ts'
import { friendlyError } from '../../lib/errors.ts'
import { supabase } from '../../lib/supabase.ts'
import { logRequestFailure } from '../../lib/telemetry-browser.ts'
import { FeedbackButton } from '../feedback/FeedbackButton.tsx'
import { SessionBanner } from '../layout/SessionBanner.tsx'
import { Avatar } from '../ui/Avatar.tsx'
import { Icon } from '../ui/Icon.tsx'
import { Spinner } from '../ui/Spinner.tsx'

interface RoomRow {
  id: string
  slug: string
  name: string
  topic: string
  tags: string[]
  emoji: string
}

export function RoomList() {
  const { state } = useAuth()
  const profile = state.status === 'signed_in' ? state.profile : null
  const [rooms, setRooms] = useState<RoomRow[] | null>(null)
  const [joined, setJoined] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      const [roomsResult, membersResult] = await Promise.all([
        // Named columns: the AI lock column is not readable by testers.
        supabase.from('rooms').select('id, slug, name, topic, tags, emoji').order('created_at'),
        supabase.from('room_members').select('room_id'),
      ])
      if (!active) return
      if (roomsResult.error) {
        logRequestFailure('list_rooms', roomsResult.error)
        setError(friendlyError(roomsResult.error, 'Could not load rooms.'))
        return
      }
      setRooms(roomsResult.data)
      setJoined(new Set((membersResult.data ?? []).map((m) => m.room_id)))
    })()
    return () => {
      active = false
    }
  }, [])

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 px-6 pt-6">
        <div className="flex items-center gap-3">
          <Avatar avatar={profile?.avatar} size={40} />
          <div className="text-sm leading-tight">
            <div className="text-muted">Hi,</div>
            <div className="font-semibold">{profile?.display_name}</div>
          </div>
        </div>
        <FeedbackButton />
      </header>

      <div className="px-6 pt-8 pb-5">
        <h1 className="font-display text-[3rem] leading-[0.95] font-extrabold tracking-tight">
          Rooms<span className="text-accent">.</span>
        </h1>
        <p className="mt-2 max-w-[30ch] text-muted">Pick a topic and say hi. Someone is usually around.</p>
      </div>
      <SessionBanner />

      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-6">
        {error && <p className="px-2 text-bad">{error}</p>}
        {!rooms && !error && <Spinner label="Loading rooms" />}
        <ul className="space-y-3">
          {rooms?.map((room, index) => (
            <li key={room.id} className="animate-rise" style={{ animationDelay: `${index * 70}ms` }}>
              <Link
                href={`/r/${room.slug}`}
                className="card group flex items-center gap-4 p-4 transition-transform duration-200 active:scale-[0.985]"
              >
                <span className="grid size-16 shrink-0 place-items-center rounded-[1.25rem] bg-gradient-to-br from-accent/40 to-accent-strong/20 text-[2rem] ring-1 ring-white/10">
                  {room.emoji}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-display text-xl font-bold tracking-tight">{room.name}</span>
                  <span className="mt-1 line-clamp-2 block text-sm text-muted">{room.topic}</span>
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {room.tags.map((tag) => (
                      <span key={tag} className="chip bg-surface-3 text-[0.7rem] text-muted">
                        #{tag}
                      </span>
                    ))}
                    {joined.has(room.id) && <span className="chip bg-accent-soft text-[0.7rem] text-accent">joined</span>}
                  </span>
                </span>
                <Icon name="chevron" className="text-faint transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <footer className="safe-bottom flex items-center justify-between px-6 pt-2 text-xs text-faint">
        <span>v{APP_VERSION}</span>
        <Link href="/me" className="underline-offset-4 hover:text-muted hover:underline">
          My ID
        </Link>
      </footer>
    </main>
  )
}
