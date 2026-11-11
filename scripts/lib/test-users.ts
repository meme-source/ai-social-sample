/**
 * A pool of email/password test users, created once with the service role
 * key and reused. Anonymous sign-in is limited per IP (30/hour by default on
 * hosted projects), which 20 simulated phones would exhaust quickly.
 * Credentials live in .sim/users.json (git-ignored) and are never printed.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { SupabaseTarget } from './local-env.ts'

const POOL_FILE = '.sim/users.json'

interface PoolEntry {
  id: string
  password: string
}

type Pool = Record<string, PoolEntry>

function readPool(): Pool {
  if (!existsSync(POOL_FILE)) return {}
  try {
    return JSON.parse(readFileSync(POOL_FILE, 'utf8')) as Pool
  } catch {
    return {}
  }
}

function writePool(pool: Pool): void {
  mkdirSync('.sim', { recursive: true })
  writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2), { mode: 0o600 })
}

export const poolEmail = (index: number): string => `sim-${String(index).padStart(2, '0')}@sim.local`

/** Make sure test users 1..count exist and have a password we know. */
export async function ensurePool(target: SupabaseTarget, count: number): Promise<Pool> {
  if (!target.serviceKey) throw new Error('The test-user pool needs the service role key (local stack or SUPABASE_SERVICE_ROLE_KEY).')
  const admin = createClient(target.url, target.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  let pool = readPool()
  let existing: Map<string, string> | null = null

  for (let i = 1; i <= count; i++) {
    const email = poolEmail(i)
    const known = pool[email]
    if (known) {
      // Still there? (`npm run db:reset` wipes users but not .sim/users.json.)
      const { data } = await admin.auth.admin.getUserById(known.id)
      if (data.user) continue
    }
    const password = randomBytes(18).toString('base64url')
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (created.data.user) {
      pool = { ...pool, [email]: { id: created.data.user.id, password } }
      continue
    }
    // The user exists but we lost its password (e.g. .sim/ was deleted): reset it.
    existing ??= await listUsers(admin)
    const id = existing.get(email)
    if (!id) throw new Error(`Could not create test user ${email}: ${created.error?.message ?? 'unknown error'}`)
    const updated = await admin.auth.admin.updateUserById(id, { password })
    if (updated.error) throw new Error(`Could not reset test user ${email}: ${updated.error.message}`)
    pool = { ...pool, [email]: { id, password } }
  }
  writePool(pool)
  return pool
}

async function listUsers(admin: SupabaseClient): Promise<Map<string, string>> {
  const users = new Map<string, string>()
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    for (const u of data.users) if (u.email) users.set(u.email, u.id)
    if (data.users.length < 200) break
  }
  return users
}

export async function signInPoolUser(client: SupabaseClient, pool: Pool, index: number): Promise<string> {
  const email = poolEmail(index)
  const entry = pool[email]
  if (!entry) throw new Error(`Test user ${email} is not in the pool`)
  const { data, error } = await client.auth.signInWithPassword({ email, password: entry.password })
  if (error || !data.user) throw new Error(`Sign-in failed for ${email}: ${error?.message ?? 'no user'}`)
  return data.user.id
}
