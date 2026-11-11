import { avatarFor } from '../../lib/avatars.ts'

interface AvatarProps {
  avatar: string | null | undefined
  size?: number
  className?: string
}

export function Avatar({ avatar, size = 36, className = '' }: AvatarProps) {
  const preset = avatarFor(avatar)
  return (
    <span
      aria-hidden="true"
      className={`inline-grid shrink-0 place-items-center rounded-full ring-1 ring-white/10 ${className}`}
      style={{ width: size, height: size, background: preset.tint, fontSize: size * 0.52 }}
    >
      {preset.emoji}
    </span>
  )
}
