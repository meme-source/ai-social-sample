import type { RosterEntry } from '../../hooks/useRoomChat.ts'
import { Avatar } from '../ui/Avatar.tsx'
import { Sheet } from '../ui/Sheet.tsx'

interface MembersSheetProps {
  open: boolean
  onClose: () => void
  roster: ReadonlyMap<string, RosterEntry>
  meId: string
  onlineCount: number
}

/** Everyone in the room, humans and AI alike — no labels, by design. */
export function MembersSheet({ open, onClose, roster, meId, onlineCount }: MembersSheetProps) {
  const members = [...roster.values()]
  return (
    <Sheet open={open} onClose={onClose} title="In this room">
      <p className="-mt-2 mb-4 text-sm text-muted">
        {members.length} members · {onlineCount} online now
      </p>
      <ul className="max-h-[50dvh] space-y-1 overflow-y-auto pb-4">
        {members.map((m) => (
          <li key={m.profileId} className="flex items-center gap-3 rounded-2xl px-2 py-2">
            <Avatar avatar={m.avatar} size={36} />
            <span className="font-semibold">{m.displayName}</span>
            {m.profileId === meId && <span className="chip bg-surface-3 text-[0.7rem] text-muted">you</span>}
          </li>
        ))}
      </ul>
    </Sheet>
  )
}
