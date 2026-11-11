import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.ts'

export interface ActiveSession {
  id: string
  label: string
  started_at: string
}

const REFRESH_MS = 60_000

/** The running test session, if any (shown as a small banner so testers know data is recorded). */
export function useActiveSession(): ActiveSession | null {
  const [session, setSession] = useState<ActiveSession | null>(null)

  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      const { data, error } = await supabase
        .from('test_sessions')
        .select('id, label, started_at')
        .is('ended_at', null)
        .maybeSingle()
      if (active && !error) setSession(data)
    }
    void load()
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  return session
}
