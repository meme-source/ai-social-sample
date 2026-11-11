/** Shown instead of the app when .env.local (or Vercel's env vars) are missing. */
export function SetupNeeded({ missing }: { missing: string[] }) {
  return (
    <main className="app-shell justify-center gap-4 p-8">
      <h1 className="font-display text-3xl font-extrabold">Almost there</h1>
      <p className="text-muted">The app does not know which Supabase project to use yet. Missing:</p>
      <ul className="space-y-1 font-mono text-sm text-accent">
        {missing.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      <p className="text-sm text-muted">
        Locally: run <code className="text-text">npm run env:local</code> (or copy <code className="text-text">.env.example</code>{' '}
        to <code className="text-text">.env.local</code>) and restart <code className="text-text">npm run dev</code>. On
        Vercel: add them under Settings → Environment Variables and redeploy. See README.
      </p>
    </main>
  )
}
