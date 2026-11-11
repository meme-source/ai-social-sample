/**
 * Throwaway rooms for scripts, with their own AI host and participant, so
 * tests never disturb the real "Pop Music Bot" room. Service role only.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface ScratchRoom {
  id: string
  slug: string
  hostProfileId: string
  participantProfileId: string
}

export async function createScratchRoom(admin: SupabaseClient, slug: string, name: string): Promise<ScratchRoom> {
  const room = { id: randomUUID(), slug, name, topic: 'Pop music, for a scripted test run.', tags: ['pop', 'music'], emoji: '🧪', max_participants: 200 }
  const host = { id: randomUUID(), display_name: 'Mira', avatar: 'koala' }
  const participant = { id: randomUUID(), display_name: 'Jun', avatar: 'penguin' }

  const steps: [string, PromiseLike<{ error: { message: string } | null }>][] = [
    ['room', admin.from('rooms').insert(room)],
    ['profiles', admin.from('profiles').insert([host, participant])],
  ]
  for (const [what, step] of steps) {
    const { error } = await step
    if (error) throw new Error(`create ${what}: ${error.message}`)
  }
  const bots = await admin.from('bots').insert([
    { profile_id: host.id, room_id: room.id, role: 'host', tags: ['pop'], custom_chat_style: 'Warm host.' },
    { profile_id: participant.id, room_id: room.id, role: 'participant', tags: ['pop'], custom_chat_style: 'Playful.' },
  ])
  if (bots.error) throw new Error(`create bots: ${bots.error.message}`)
  const members = await admin.from('room_members').insert([
    { room_id: room.id, profile_id: host.id, welcomed_at: new Date().toISOString() },
    { room_id: room.id, profile_id: participant.id, welcomed_at: new Date().toISOString() },
  ])
  if (members.error) throw new Error(`add AI members: ${members.error.message}`)
  return { id: room.id, slug, hostProfileId: host.id, participantProfileId: participant.id }
}

/** Deletes the room (messages, members, bots and AI events go with it) and the AI profiles. */
export async function deleteScratchRoom(admin: SupabaseClient, room: ScratchRoom): Promise<void> {
  await admin.from('rooms').delete().eq('id', room.id)
  await admin.from('profiles').delete().in('id', [room.hostProfileId, room.participantProfileId])
}
