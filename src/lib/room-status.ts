/**
 * A tiny shared store for "what room am I in and how many people are online",
 * so the global Feedback button can attach it as context.
 */
import { useSyncExternalStore } from 'react'

export interface RoomStatus {
  roomId: string | null
  onlineCount: number | null
  channelStatus: string | null
}

const EMPTY: RoomStatus = { roomId: null, onlineCount: null, channelStatus: null }

let current: RoomStatus = EMPTY
const listeners = new Set<() => void>()

export function setRoomStatus(next: Partial<RoomStatus> | null): void {
  current = next === null ? EMPTY : { ...current, ...next }
  for (const listener of listeners) listener()
}

export function getRoomStatus(): RoomStatus {
  return current
}

export function useRoomStatus(): RoomStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getRoomStatus,
    getRoomStatus,
  )
}
