/** Preset avatars: an emoji on a tinted circle. Keys are stored in profiles.avatar. */
export interface AvatarPreset {
  key: string
  emoji: string
  tint: string
}

export const AVATARS: readonly AvatarPreset[] = [
  { key: 'cat', emoji: '🐱', tint: '#4a3570' },
  { key: 'owl', emoji: '🦉', tint: '#3d3a63' },
  { key: 'fox', emoji: '🦊', tint: '#5c3a2e' },
  { key: 'panda', emoji: '🐼', tint: '#33384a' },
  { key: 'frog', emoji: '🐸', tint: '#2e4a37' },
  { key: 'octopus', emoji: '🐙', tint: '#5a2f4f' },
  { key: 'bear', emoji: '🐻', tint: '#4d3b2c' },
  { key: 'koala', emoji: '🐨', tint: '#3a4250' },
  { key: 'tiger', emoji: '🐯', tint: '#5a4325' },
  { key: 'penguin', emoji: '🐧', tint: '#2c3d52' },
  { key: 'unicorn', emoji: '🦄', tint: '#55306a' },
  { key: 'alien', emoji: '👾', tint: '#3b2f6b' },
]

const FALLBACK: AvatarPreset = { key: 'unknown', emoji: '💬', tint: '#2a2440' }

export function avatarFor(key: string | null | undefined): AvatarPreset {
  return AVATARS.find((a) => a.key === key) ?? FALLBACK
}
