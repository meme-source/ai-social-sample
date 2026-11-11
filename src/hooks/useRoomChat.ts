/**
 * Everything live about one room:
 *   join → load roster, clock offset and recent messages → subscribe to new
 *   messages (postgres_changes) + who is online (Presence) → catch up after
 *   the phone sleeps or the connection drops → send with "sending…" bubbles.
 * Every hiccup is counted and sent as a client event (never message text).
 */
import type { RealtimeChannel } from '@supabase/supabase-js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { findMentions } from '../../supabase/functions/_shared/ai-rules.ts'
import { parseTimestampMs } from '../../supabase/functions/_shared/time.ts'
import { callRoomAi } from '../lib/ai.ts'
import { bestSample, deliveryLatencyMs, sampleOffset, type ClockSample } from '../lib/clock.ts'
import { friendlyError } from '../lib/errors.ts'
import {
  MESSAGE_COLUMNS,
  createPending,
  fromRow,
  isMessageRow,
  maxConfirmedId,
  mergeMessages,
  trimHistory,
  withStatus,
  type ChatMessage,
  type MergeResult,
  type MergeSource,
} from '../lib/messages.ts'
import { setRoomStatus } from '../lib/room-status.ts'
import { supabase } from '../lib/supabase.ts'
import { logRequestFailure, telemetry } from '../lib/telemetry-browser.ts'
import { uuid } from '../lib/uuid.ts'

const INITIAL_LIMIT = 60
const CATCHUP_PAGE = 100
const CATCHUP_MAX_PAGES = 5
/** Ids are handed out before commit, so a slightly older id can appear late: re-read a few. */
const CATCHUP_OVERLAP_IDS = 20
const HEARTBEAT_MS = 20_000
/** Safety net: while on screen, look for messages realtime may have missed. */
const POLL_MS = 30_000
/**
 * Measured locally: when Realtime starts cold (after being idle), changes made
 * in the first ~2.5 s after SUBSCRIBED are not streamed. A second catch-up a
 * few seconds later picks those up (and logs that it had to).
 */
const WARMUP_CATCHUP_MS = 4_000
const WELCOME_RETRIES = 2

export interface RoomInfo {
  id: string
  slug: string
  name: string
  topic: string
  emoji: string
}

export interface RosterEntry {
  profileId: string
  displayName: string
  avatar: string
}

export type LoadStatus = 'loading' | 'ready' | 'error'

export interface RoomChat {
  status: LoadStatus
  error: string | null
  messages: ChatMessage[]
  roster: ReadonlyMap<string, RosterEntry>
  onlineCount: number
  channelStatus: string
  /** serverTime − phoneTime (ms) */
  clockOffsetMs: number
  /** server time when this phone entered the room (anchor for an empty room's silence timer) */
  enteredAtServerMs: number | null
  send: (text: string) => void
  retry: (clientMsgId: string) => void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A first-time member gets a welcome; if another AI turn holds the lock, try again once it frees up. */
async function requestWelcome(roomId: string): Promise<void> {
  for (let attempt = 0; attempt < WELCOME_RETRIES; attempt++) {
    const { retryAfterMs } = await callRoomAi({ roomId, trigger: 'join' })
    if (!retryAfterMs) return
    await sleep(Math.min(retryAfterMs, 20_000))
  }
}

/**
 * Heartbeat: "I still have this room open" (the AI host only breaks silences
 * while a human is around). Note the await: supabase-js queries are lazy and
 * are only sent once something awaits them — `void supabase.rpc(...)` alone
 * would silently do nothing.
 */
async function touchRoom(roomId: string): Promise<void> {
  const { error } = await supabase.rpc('touch_room', { p_room_id: roomId })
  if (error) logRequestFailure('touch_room', error, roomId)
}

async function measureClock(): Promise<ClockSample | null> {
  const samples: ClockSample[] = []
  for (let i = 0; i < 3; i++) {
    const sentAt = Date.now()
    const { data, error } = await supabase.rpc('server_time')
    const receivedAt = Date.now()
    if (error || typeof data !== 'string') continue
    samples.push(sampleOffset(sentAt, parseTimestampMs(data), receivedAt))
  }
  return bestSample(samples)
}

export function useRoomChat(room: RoomInfo, meId: string): RoomChat {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [roster, setRoster] = useState<ReadonlyMap<string, RosterEntry>>(new Map())
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [onlineCount, setOnlineCount] = useState(0)
  const [channelStatus, setChannelStatus] = useState('CONNECTING')
  const [clockOffsetMs, setClockOffsetMs] = useState(0)
  const [enteredAtServerMs, setEnteredAtServerMs] = useState<number | null>(null)

  // Refs hold the latest values for async callbacks (realtime handlers, timers).
  const messagesRef = useRef<ChatMessage[]>([])
  // Messages leave this phone one at a time. Two quick sends as parallel requests
  // can reach the database in either order, and the server time decides the
  // order everyone sees — so "ok back" could land after the message typed next.
  const sendQueue = useRef<Promise<void>>(Promise.resolve())
  const rosterRef = useRef<ReadonlyMap<string, RosterEntry>>(new Map())
  const offsetRef = useRef(0)

  const apply = useCallback((incoming: ChatMessage[], source: MergeSource): MergeResult => {
    const result = mergeMessages(messagesRef.current, incoming, source)
    messagesRef.current = trimHistory(result.messages)
    setMessages(messagesRef.current)
    return result
  }, [])

  const loadRoster = useCallback(async (roomId: string): Promise<void> => {
    const { data, error: rosterError } = await supabase.rpc('room_roster', { p_room_id: roomId })
    if (rosterError) {
      logRequestFailure('room_roster', rosterError, roomId)
      return
    }
    const rows = (data ?? []) as { profile_id: string; display_name: string; avatar: string }[]
    const next = new Map(
      rows.map((r) => [r.profile_id, { profileId: r.profile_id, displayName: r.display_name, avatar: r.avatar }]),
    )
    rosterRef.current = next
    setRoster(next)
  }, [])

  useEffect(() => {
    const roomId = room.id
    let cancelled = false
    let channel: RealtimeChannel | null = null
    let everSubscribed = false
    let disconnectedAt: number | null = null
    let hiddenAt: number | null = null
    let warmupTimer: number | undefined

    messagesRef.current = []
    setMessages([])
    setStatus('loading')
    setError(null)
    setRoomStatus({ roomId, onlineCount: null, channelStatus: 'CONNECTING' })

    async function catchUp(
      reason: 'subscribed' | 'warmup' | 'visible' | 'reconnect' | 'poll',
      gapMs: number | null,
    ): Promise<void> {
      let cursor = Math.max(0, maxConfirmedId(messagesRef.current) - CATCHUP_OVERLAP_IDS)
      let fetched = 0
      let added = 0
      let overlap = 0
      for (let page = 0; page < CATCHUP_MAX_PAGES; page++) {
        const { data, error: fetchError } = await supabase
          .from('messages')
          .select(MESSAGE_COLUMNS)
          .eq('room_id', roomId)
          .gt('id', cursor)
          .order('id', { ascending: true })
          .limit(CATCHUP_PAGE)
        if (fetchError) {
          logRequestFailure('catchup', fetchError, roomId)
          return
        }
        if (cancelled) return
        const rows = (data ?? []).filter(isMessageRow)
        const result = apply(rows.map(fromRow), 'catchup')
        fetched += rows.length
        added += result.added + result.reconciled
        overlap += result.overlap
        const last = rows.at(-1)
        if (rows.length < CATCHUP_PAGE || !last) break
        cursor = last.id
      }
      // Opening the room and the safety-net poll are routine: log them only when they
      // recovered something (= realtime missed a message — useful evidence).
      if (!['subscribed', 'warmup', 'poll'].includes(reason) || added > 0) {
        telemetry.log('catchup', { reason, fetched, added, overlap, gap_ms: gapMs }, roomId)
      }
      if (added > 0) void loadRoster(roomId)
    }

    function onInsert(payload: { new: unknown }): void {
      const receivedAt = Date.now()
      if (!isMessageRow(payload.new)) {
        telemetry.log('bad_payload', { source: 'realtime' }, roomId)
        return
      }
      const row = payload.new
      const result = apply([fromRow(row)], 'realtime')
      for (const m of result.firstDeliveries) {
        telemetry.addLatencySample(deliveryLatencyMs(m.createdAtMs, receivedAt, offsetRef.current), roomId)
      }
      if (result.duplicates > 0) telemetry.log('dup_dropped', { count: result.duplicates, source: 'realtime' }, roomId)
      if (result.outOfOrder > 0) {
        telemetry.log('out_of_order', { count: result.outOfOrder, max_gap_ms: result.maxOutOfOrderMs }, roomId)
      }
      if (row.kind === 'system' || (row.profile_id !== null && !rosterRef.current.has(row.profile_id))) {
        void loadRoster(roomId)
      }
    }

    function subscribe(): void {
      const ch = supabase.channel(`room:${roomId}`, { config: { presence: { key: meId } } })
      channel = ch
      ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` }, onInsert)
        .on('presence', { event: 'sync' }, () => {
          // One key per person (several tabs of one person count once).
          const count = Object.keys(ch.presenceState()).length
          setOnlineCount(count)
          setRoomStatus({ onlineCount: count })
        })
        .subscribe((state, subscribeError) => {
          if (cancelled) return
          setChannelStatus(state)
          setRoomStatus({ channelStatus: state })
          telemetry.log('realtime_status', { status: state, error: subscribeError?.message ?? null }, roomId)
          if (state === 'SUBSCRIBED') {
            void ch.track({ online_at: new Date().toISOString() })
            if (everSubscribed) {
              const downMs = disconnectedAt === null ? null : Date.now() - disconnectedAt
              telemetry.log('reconnect', { down_ms: downMs }, roomId)
              void catchUp('reconnect', downMs)
            } else {
              void catchUp('subscribed', null) // anything sent between loading and subscribing
              warmupTimer = window.setTimeout(() => void catchUp('warmup', null), WARMUP_CATCHUP_MS)
            }
            everSubscribed = true
            disconnectedAt = null
          } else {
            disconnectedAt ??= Date.now()
          }
        })
    }

    async function init(): Promise<void> {
      try {
        const joined = await supabase.rpc('join_room', { p_room_id: roomId })
        if (joined.error) throw joined.error
        const isNewMember = (joined.data as { joined?: boolean } | null)?.joined === true
        // Not tied to `cancelled`: the join already happened, so the welcome should too.
        if (isNewMember) void requestWelcome(roomId)
        telemetry.log('room_enter', { new_member: isNewMember }, roomId)

        const [clock, latest] = await Promise.all([
          measureClock(),
          supabase.from('messages').select(MESSAGE_COLUMNS).eq('room_id', roomId).order('id', { ascending: false }).limit(INITIAL_LIMIT),
          loadRoster(roomId),
        ])
        if (latest.error) throw latest.error
        if (cancelled) return

        if (clock) {
          offsetRef.current = clock.offsetMs
          setClockOffsetMs(clock.offsetMs)
          telemetry.log('clock_sync', { offset_ms: clock.offsetMs, rtt_ms: clock.rttMs }, roomId)
        }
        setEnteredAtServerMs(Date.now() + offsetRef.current)
        apply((latest.data ?? []).filter(isMessageRow).map(fromRow), 'initial')
        setStatus('ready')
        subscribe()
      } catch (initError) {
        logRequestFailure('room_init', initError, roomId)
        if (!cancelled) {
          setError(friendlyError(initError, 'Could not open this room. Please try again.'))
          setStatus('error')
        }
      }
    }

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      const gapMs = hiddenAt === null ? null : Date.now() - hiddenAt
      hiddenAt = null
      void touchRoom(roomId)
      if (channel) void catchUp('visible', gapMs)
    }

    const heartbeat = window.setInterval(() => {
      if (document.visibilityState === 'visible') void touchRoom(roomId)
    }, HEARTBEAT_MS)
    const poll = window.setInterval(() => {
      if (channel && document.visibilityState === 'visible') void catchUp('poll', null)
    }, POLL_MS)
    document.addEventListener('visibilitychange', onVisibility)
    void init()

    return () => {
      cancelled = true
      window.clearInterval(heartbeat)
      window.clearInterval(poll)
      window.clearTimeout(warmupTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      telemetry.log('room_leave', {}, roomId)
      setRoomStatus(null)
      if (channel) void supabase.removeChannel(channel)
    }
  }, [room.id, meId, apply, loadRoster])

  const deliver = useCallback(
    async (clientMsgId: string, content: string, mentions: string[]): Promise<void> => {
      const roomId = room.id
      const insert = await supabase
        .from('messages')
        .insert({ room_id: roomId, profile_id: meId, content, client_msg_id: clientMsgId, mentions })
        .select(MESSAGE_COLUMNS)
        .single()

      let row: unknown = insert.data
      if (insert.error?.code === '23505') {
        // Unique client_msg_id: an earlier attempt was saved after all. Fetch it instead of sending twice.
        const existing = await supabase.from('messages').select(MESSAGE_COLUMNS).eq('client_msg_id', clientMsgId).maybeSingle()
        row = existing.data
      } else if (insert.error) {
        logRequestFailure('send_message', insert.error, roomId)
        messagesRef.current = withStatus(messagesRef.current, clientMsgId, 'failed')
        setMessages(messagesRef.current)
        return
      }
      if (!isMessageRow(row)) return
      apply([fromRow(row)], 'send')
      if (mentions.length > 0) void callRoomAi({ roomId, trigger: 'mention', messageId: row.id })
    },
    [room.id, meId, apply],
  )

  const enqueue = useCallback((job: () => Promise<void>): void => {
    sendQueue.current = sendQueue.current.then(job).catch((error: unknown) => logRequestFailure('send_queue', error, room.id))
  }, [room.id])

  const send = useCallback(
    (text: string): void => {
      const content = text.trim()
      if (!content) return
      const clientMsgId = uuid()
      const others = [...rosterRef.current.values()].filter((r) => r.profileId !== meId)
      const mentions = findMentions(content, others)
      messagesRef.current = [
        ...messagesRef.current,
        createPending({ roomId: room.id, profileId: meId, content, clientMsgId, mentions, nowMs: Date.now() }),
      ]
      setMessages(messagesRef.current)
      enqueue(() => deliver(clientMsgId, content, mentions))
    },
    [room.id, meId, deliver, enqueue],
  )

  const retry = useCallback(
    (clientMsgId: string): void => {
      const failed = messagesRef.current.find((m) => m.id === null && m.clientMsgId === clientMsgId)
      if (!failed) return
      messagesRef.current = withStatus(messagesRef.current, clientMsgId, 'sending')
      setMessages(messagesRef.current)
      telemetry.log('send_retry', {}, room.id)
      enqueue(() => deliver(clientMsgId, failed.content, failed.mentions))
    },
    [room.id, deliver, enqueue],
  )

  return {
    status,
    error,
    messages,
    roster,
    onlineCount,
    channelStatus,
    clockOffsetMs,
    enteredAtServerMs,
    send,
    retry,
  }
}
