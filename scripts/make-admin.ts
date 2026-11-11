/**
 * Adds a user id to the admin allow-list on the LOCAL stack:
 *   npm run make-admin -- <user id from the /me page>
 * (Hosted project: run the SQL shown on /me in Supabase → SQL Editor instead.)
 */
import { createClient } from '@supabase/supabase-js'
import { resolveTarget } from './lib/local-env.ts'

const userId = process.argv[2] ?? ''
if (!/^[0-9a-f-]{36}$/i.test(userId)) {
  process.stderr.write('Usage: npm run make-admin -- <user id>   (open /me in the app to see your id)\n')
  process.exit(1)
}

delete process.env.SUPABASE_URL // local stack only
const target = resolveTarget({ needServiceKey: true })
if (!target.isLocal || !target.serviceKey) throw new Error('make-admin only works on the local stack.')
const admin = createClient(target.url, target.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const { error } = await admin.from('admins').upsert({ user_id: userId, note: 'added with npm run make-admin' })
if (error) {
  process.stderr.write(`Could not add admin: ${error.message}\n`)
  process.exit(1)
}
process.stdout.write(`${userId} is now an admin. Reload /admin.\n`)
