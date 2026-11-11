# AI Social Spike — teacher sample

A small, working version of the student's idea: **topic group chats where real people and AI members talk in one room**, with an **AI host** that welcomes newcomers, answers @mentions and breaks awkward silences. Every test session also produces **evidence** — tester feedback, automatic app logs, AI decisions and anomaly checks — for the portfolio's iteration story.

This is the tutor's reference for rehearsals and class demos. It is separate from the student's own repository.

- **Phone-first web app (PWA).** Testers open a link on their iPhone (and can "Add to Home Screen"). No App Store or TestFlight needed.
- **Stack:** Vite + React + TypeScript + Tailwind · Supabase (anonymous sign-in, Postgres with Row Level Security, Realtime, Edge Functions) · any OpenAI-compatible LLM (DeepSeek by default), with a free question bank as fallback.

> Where to go next: **TESTING.md** explains how to run a test session with real people. **DATA.md** lists what is collected and why, ready to adapt for the consent screen.

---

## How it works

```
 iPhone / browser ──────────────► Supabase
  • consent → nickname → room      • Postgres + Row Level Security (who may read/write what)
  • live messages (Realtime)       • Realtime: new messages + who is online (Presence)
  • Feedback / "Something's off?"  • Edge Function room-ai ──► LLM (DeepSeek, or the local mock)
  • automatic app logs (batched)   • run_checks(): anomaly checks after a session
```

**The AI host's speaking rules** (code: `supabase/functions/_shared/ai-rules.ts`, unit-tested):

| | Rule |
|---|---|
| **Triggers** | someone **@mentions** an AI member · **45 s of silence** while a human is online (every phone's timer asks; the lock lets one through) · a **new member joins** (template welcome + a question-bank question, no LLM call) |
| **Lock** | One AI turn per room at a time: `update rooms set ai_lock_until = now() + interval '15 seconds' where id = $1 and (ai_lock_until is null or ai_lock_until < now()) returning id`. The lock is kept 15 s *after* each AI message, so AI messages are ≥ 15 s apart. |
| **Share** | AI writes at most **4 of any 12** messages in a row (⅓). |
| **Budget** | At most **60 LLM calls per room per hour**. |
| **Context** | Topic + persona + last 20 messages; reply ≤ 2 sentences (`max_tokens` 120, 8 s timeout). |
| **Honesty** | Asked "are you AI?" → neither lies nor confirms. Never claims to be human. |
| **Failure** | Wrong key, timeout, no credit → a question-bank prompt instead. Never an error in the chat. |
| **Privacy** | Testers cannot read personas (`bots` table), so the app never says who is AI. |

Every trigger writes one row in `ai_events`: spoke or skipped, and why (`lock_busy`, `ratio_cap`, `budget_cap`, `no_human_online`, `not_silent`, `ai_spoke_last`, …), plus provider, model, latency, tokens and fallback.

---

## Folder map

```
ai-social-spike/
├── src/                         the web app
│   ├── components/              screens: onboarding, rooms, chat, feedback, admin, me
│   ├── hooks/useRoomChat.ts     live room: join, Realtime, Presence, catch-up, sending
│   └── lib/                     pure logic + tests: messages (dedupe/order), telemetry,
│                                session summary, CSV, clock offset
├── supabase/
│   ├── migrations/              01 chat core · 02 test-data system · 03 AI lock · 04 run_checks
│   ├── seed.sql                 "Pop Music Bot" room, AI members Lena (host) + Theo, question bank
│   ├── tests/database/          pgTAP tests: privacy/RLS and every anomaly check
│   └── functions/
│       ├── room-ai/index.ts     the AI host (Deno Edge Function)
│       └── _shared/             rules, prompt, LLM client — shared with the app, unit-tested
├── scripts/
│   ├── mock-llm.ts              free local stand-in for the LLM (can fail on purpose)
│   ├── simulate.ts              load test: N simulated phones chat for M minutes
│   ├── verify-local.ts          end-to-end checks of the whole system (PASS/FAIL list)
│   └── …                        env:local, make-admin, icons
├── README.md · TESTING.md · DATA.md
```

**Tables:** `profiles` · `consents` · `rooms` · `bots` · `room_members` · `messages` · `question_bank` · `test_sessions` · `feedback` · `client_events` · `ai_events` · `anomalies` · `admins`. Every table has RLS on.

---

## Part 1 — Run it on your Mac (free, no accounts, no keys)

You need **Node 22+** and **Docker Desktop** (open it first).

```bash
npm install
```

```bash
npm run db:start
```

The first start downloads about 2–3 GB of Docker images. It also creates the tables and the seed room.

```bash
npm run env:local
```

This writes `.env.local` for the local database. It never prints a key.

```bash
cp supabase/functions/.env.example supabase/functions/.env.local
```

This tells the local AI function to use the mock LLM. Now open three terminal tabs:

```bash
npm run mock-llm
```

```bash
npm run functions:serve
```

```bash
npm run dev
```

Open **http://localhost:5173**. To be a second person in the same browser, open **http://localhost:5173/?slot=2** in another tab (each `slot` is its own identity).

**On iPhones on the same Wi-Fi:** `127.0.0.1` means "this device", so a phone can't use the address above. Run this instead of `env:local`:

```bash
npm run env:lan
```

It writes this Mac's Wi-Fi address (e.g. `192.168.3.16`) into `.env.local` and prints the link. Restart `npm run dev`, then open `http://<that address>:5173` in Safari on each phone. Run it again if the Mac joins another network. For testers who are not on your Wi-Fi, use the online version (Part 2).

**Become an admin:** open `/me` in the app, copy your id, then:

```bash
npm run make-admin -- <your id>
```

Then open **http://localhost:5173/admin**.

**Check everything works:**

```bash
npm test
```

```bash
npm run test:db
```

```bash
npm run verify:local
```

`npm test` runs 120 unit tests (rules, dedupe/order, telemetry, summary, CSV). `test:db` runs 30 database tests (privacy and anomaly checks). `verify:local` runs the whole system end to end in about 2 minutes and prints PASS/FAIL. Load test (20 phones, 3 minutes):

```bash
npm run simulate
```

Stop the database when done (data is kept for next time):

```bash
npm run db:stop
```

---

## Part 2 — Put it online (Supabase + Vercel)

Do these steps yourself. Keys go into files on your Mac, the Supabase dashboard or Vercel's settings — **never paste a key into a chat or commit it** (`.gitignore` already covers every `.env*` file).

### 1. Create the Supabase project
Create a project at supabase.com (pick a region close to Hong Kong or the UK, depending on where testers are). Note the **project ref** (the id in the dashboard URL).

### 2. Turn on guest sign-in, CAPTCHA and a classroom-sized rate limit
In the Supabase dashboard (menu names move occasionally; the search box finds them):
- **Authentication → Sign In / Providers → Allow anonymous sign-ins: on.**
- **Authentication → Attack Protection → CAPTCHA protection: on**, provider **Cloudflare Turnstile**. Create a free Turnstile widget at dash.cloudflare.com → Turnstile (add your Vercel domain and `localhost`). Paste the Turnstile **secret key** into Supabase. Keep the **site key** for step 6.
- **Authentication → Rate Limits → anonymous sign-ins.** The default is 30 per hour **per IP address**, and a whole class on one Wi-Fi shares one IP. Raise it (e.g. 150) for test days.

### 3. Create the tables

```bash
npx supabase login
```

```bash
npx supabase link --project-ref <your-project-ref>
```

```bash
npx supabase db push --include-seed
```

The last command creates all tables, policies and functions, and adds the seed room, AI members and question bank.

### 4. Give the AI function its LLM settings
Create the file `supabase/functions/.env.production` (git-ignored) on your Mac:

```
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-flash
LLM_API_KEY=<your DeepSeek API key>
```

Then:

```bash
npx supabase secrets set --env-file supabase/functions/.env.production
```

DeepSeek's `deepseek-flash` thinks before answering by default; the function automatically sends `"thinking": {"type": "disabled"}` to DeepSeek, so replies are fast and short.

### 5. Deploy the AI function

```bash
npx supabase functions deploy room-ai
```

(If Docker is not running, add `--use-api`.) The function checks the caller's sign-in itself, so `verify_jwt` is off in `supabase/config.toml`.

### 6. Deploy the web app on Vercel
Push this folder to a GitHub repository, import it at vercel.com (framework: **Vite**), and add these **Environment Variables**:

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | the project URL (dashboard → **Connect**, or Project Settings → API) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Project Settings → API Keys → **Publishable** key (or the legacy *anon* key) |
| `VITE_TURNSTILE_SITE_KEY` | the Turnstile **site** key from step 2 |

These three are safe in the browser; Row Level Security protects the data. **Never** add a service-role or secret key to a `VITE_` variable. Deploy.

`vercel.json` also sends security headers, including a Content-Security-Policy that only allows this app, `*.supabase.co`, Google Fonts and Cloudflare Turnstile. If you give Supabase a custom domain, add it to `connect-src` there. Vercel's commit id becomes the app version automatically (`VERCEL_GIT_COMMIT_SHA`), so every feedback row and log says which build it came from. `vercel.json` makes links like `/r/pop-music` and `/admin` work.

In Supabase, set **Authentication → URL Configuration → Site URL** to your Vercel URL.

### 7. Make yourself the admin
Open `https://<your-app>/me` on the laptop you will run sessions from and copy the SQL shown there. Then run it in **Supabase → SQL Editor**. Open `/admin`. (Your admin identity lives in that browser. If you clear its data, repeat this step.)

### 8. Try it on an iPhone
Open the Vercel URL in Safari → Share → **Add to Home Screen**. It opens full-screen like an app.

---

## Switching the LLM provider

Change secrets only (no code): `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`. Any OpenAI-compatible Chat Completions endpoint works (the function calls `<LLM_BASE_URL>/chat/completions`). If a provider needs an extra request field (for example its own "no thinking" switch), add it as JSON in `LLM_EXTRA_BODY`. Optional: `LLM_TIMEOUT_MS` (default 8000, max 12000 — it must finish inside the 15 s lock) and `LLM_MAX_TOKENS` (default 120).

Costs stay small by design: 2-sentence replies, at most 60 LLM calls per room per hour, and welcomes never call the LLM.

---

## Troubleshooting

| Symptom | Where to look |
|---|---|
| "Almost there" page | `.env.local` (local) or Vercel env vars are missing. |
| "Guest sign-in is switched off" | Step 2: allow anonymous sign-ins. |
| "Too many sign-ins from this network" | Step 2: raise the anonymous sign-in rate limit. |
| The host never speaks | `/admin` → *AI host decisions → Why it stayed quiet*. Common: `ratio_cap` (AI already wrote 4 of the last 12 — normal in 2-person rooms after welcomes), `no_human_online` (the room isn't open on any phone), `ai_spoke_last` (it waits for a human after speaking). |
| Every AI reply is a question-bank question | LLM problem: `/admin` → *Errors and fallbacks* shows `auth` (wrong key), `no_balance` (top up), `timeout`, `not_found` (wrong URL/model). |
| Function logs | Local: the `functions:serve` terminal. Hosted: Supabase → Edge Functions → room-ai → Logs. |

---

## Known limits and design questions (good portfolio material)

- **Small rooms:** welcomes count towards the AI's ⅓ share, so with 2 people the host can run out of turns (logged as `ratio_cap`). Should welcomes count?
- **Who is AI?** The app never labels AI members, but AI members never appear in Presence ("online"). Someone using browser developer tools could also infer it from timing. The UI only shows a count.
- **Identity** is an anonymous account per browser: a new browser or cleared data = a new person.
- **Two quick messages** are sent one after another, to keep their order; the server's clock decides the order everyone sees.
- **Realtime cold start:** when Realtime has been idle (or just restarted), changes made in the first ~2.5 s after a phone connects are not streamed (measured locally: 5 of 5 messages missed in that window, 0 once warm). The app re-checks 4 s after connecting and every 30 s while on screen; anything it had to recover shows on `/admin` as *Messages realtime missed*.
- **Not built:** moderation, editing/deleting messages, push notifications, multiple languages in the UI.
- **Things found while building this** (useful "iteration" examples): supabase-js queries only run when awaited (the heartbeat silently never ran → the host thought nobody was online); a frosted-glass header (`backdrop-filter`) trapped a pop-up sheet off-screen; parallel sends could swap order; a returning phone fired the silence timer on stale data; Realtime's cold start dropped the first seconds of messages. Each was caught by the checks or the rehearsal, is fixed, and is explained in a code comment.
