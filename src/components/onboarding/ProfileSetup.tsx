import { useCallback, useState, type FormEvent } from 'react'
import { useAuth } from '../../hooks/useAuth.tsx'
import { AVATARS } from '../../lib/avatars.ts'
import { env } from '../../lib/env.ts'
import { Avatar } from '../ui/Avatar.tsx'
import { Turnstile } from './Turnstile.tsx'

const NAME_MAX = 24

export function ProfileSetup() {
  const { createProfile } = useAuth()
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState(AVATARS[0]?.key ?? 'cat')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const needsCaptcha = env.turnstileSiteKey !== null
  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && trimmed.length <= NAME_MAX && (!needsCaptcha || captchaToken) && !busy

  const onCaptchaError = useCallback((message: string) => setError(message), [])

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    const result = await createProfile({ displayName: trimmed, avatar, captchaToken })
    setBusy(false)
    if (result.error) setError(result.error)
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto px-6 pt-10 pb-6">
          <h1 className="font-display text-[2.2rem] leading-[1.05] font-extrabold tracking-tight">Pick a nickname</h1>
          <p className="mt-2 text-muted">This is how others will see you. No real names needed.</p>

          <div className="mt-8 flex items-center gap-4">
            <Avatar avatar={avatar} size={64} />
            <label className="flex-1">
              <span className="sr-only">Nickname</span>
              <input
                className="field font-semibold"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={NAME_MAX}
                placeholder="e.g. NightOwl"
                autoComplete="nickname"
                autoCapitalize="words"
                enterKeyHint="go"
                required
              />
            </label>
          </div>

          <fieldset className="mt-8">
            <legend className="mb-3 text-sm font-semibold text-muted">Choose an avatar</legend>
            <div className="grid grid-cols-6 gap-2.5">
              {AVATARS.map((preset) => {
                const selected = preset.key === avatar
                return (
                  <button
                    key={preset.key}
                    type="button"
                    aria-label={preset.key}
                    aria-pressed={selected}
                    onClick={() => setAvatar(preset.key)}
                    className={`grid aspect-square place-items-center rounded-2xl text-2xl transition-transform duration-150 active:scale-95 ${
                      selected ? 'ring-2 ring-accent ring-offset-2 ring-offset-ink' : 'opacity-75 hover:opacity-100'
                    }`}
                    style={{ background: preset.tint }}
                  >
                    {preset.emoji}
                  </button>
                )
              })}
            </div>
          </fieldset>

          {env.turnstileSiteKey && (
            <div className="mt-8">
              <Turnstile siteKey={env.turnstileSiteKey} onToken={setCaptchaToken} onError={onCaptchaError} />
            </div>
          )}

          {error && (
            <p role="alert" className="mt-6 rounded-2xl border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">
              {error}
            </p>
          )}
        </div>

        <div className="safe-bottom border-t border-line bg-ink/80 px-6 pt-4 backdrop-blur">
          <button type="submit" className="btn btn-primary w-full" disabled={!canSubmit}>
            {busy ? 'Joining…' : 'Join'}
          </button>
        </div>
      </form>
    </main>
  )
}
