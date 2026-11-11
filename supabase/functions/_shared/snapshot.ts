/**
 * Turn the JSON returned by the SQL function ai_room_context() into the typed
 * RoomSnapshot the rules expect. Database output is treated as untrusted:
 * anything malformed becomes a safe default instead of a crash.
 */
import type { BotPersona, RoomSnapshot, SnapshotMessage } from './ai-rules.ts'
import { parseTimestampMs } from './time.ts'

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const timeOrNull = (v: unknown): number | null => (typeof v === 'string' && v ? parseTimestampMs(v) : null)

function toMessage(v: unknown): SnapshotMessage | null {
  if (!isObject(v)) return null
  const createdAtMs = timeOrNull(v.created_at)
  if (createdAtMs === null) return null
  return {
    id: num(v.id),
    profileId: typeof v.profile_id === 'string' ? v.profile_id : null,
    kind: v.kind === 'system' ? 'system' : 'chat',
    content: str(v.content),
    createdAtMs,
    displayName: str(v.display_name, 'Someone'),
    isAi: v.is_ai === true,
    mentions: strList(v.mentions),
  }
}

function toBot(v: unknown): BotPersona | null {
  if (!isObject(v) || typeof v.id !== 'string' || typeof v.profile_id !== 'string') return null
  return {
    id: v.id,
    profileId: v.profile_id,
    displayName: str(v.display_name, 'Host'),
    role: v.role === 'host' ? 'host' : 'participant',
    language: str(v.language, 'en'),
    tags: strList(v.tags),
    activityLevel: num(v.activity_level, 2),
    professionalism: num(v.professionalism, 2),
    bannedWords: strList(v.banned_words),
    customChatStyle: str(v.custom_chat_style),
  }
}

export function snapshotFromJson(raw: unknown): RoomSnapshot {
  const data = isObject(raw) ? raw : {}
  const room = isObject(data.room) && typeof data.room.id === 'string' ? data.room : null
  const latest = isObject(data.latest) ? data.latest : null
  const caller = isObject(data.caller) ? data.caller : null

  return {
    nowMs: timeOrNull(data.now) ?? Date.now(),
    room: room
      ? {
          id: str(room.id),
          name: str(room.name),
          topic: str(room.topic),
          tags: strList(room.tags),
          aiLockUntilMs: timeOrNull(room.ai_lock_until),
        }
      : null,
    bots: (Array.isArray(data.bots) ? data.bots : []).map(toBot).filter((b): b is BotPersona => b !== null),
    recentChat: (Array.isArray(data.recent_chat) ? data.recent_chat : [])
      .map(toMessage)
      .filter((m): m is SnapshotMessage => m !== null),
    latest:
      latest && timeOrNull(latest.created_at) !== null
        ? {
            id: num(latest.id),
            kind: latest.kind === 'system' ? 'system' : 'chat',
            isAi: latest.is_ai === true,
            createdAtMs: timeOrNull(latest.created_at) as number,
          }
        : null,
    triggerMessage: toMessage(data.trigger_message),
    alreadyReplied: data.already_replied === true,
    humansOnline: num(data.humans_online),
    caller:
      caller && timeOrNull(caller.joined_at) !== null
        ? {
            joinedAtMs: timeOrNull(caller.joined_at) as number,
            welcomedAtMs: timeOrNull(caller.welcomed_at),
            displayName: str(caller.display_name, 'there'),
          }
        : null,
    llmCallsLastHour: num(data.llm_calls_last_hour),
  }
}
