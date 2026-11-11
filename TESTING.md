# Running a test session

A **test session** is a labelled time window, such as "Class 3 — 6 testers, campus Wi-Fi". While it runs, every message, feedback report, app log and AI decision is stamped with its id **by the database**. Afterwards you can see exactly what happened during that hour and compare it with the next round.

The loop for the portfolio: **test → find → change → test again**, with numbers each time.

---

## Before testers arrive (10 minutes)

1. **Deploy the version you want to test.** The app version (git commit on Vercel) is recorded on every row, so you can compare builds later.
2. **Open `/admin`** on your laptop and check you see "Test sessions". If not, see README → Part 2, step 7.
3. **Check the AI works:** in the room, write `@Theo hi`. A real reply means the LLM key works. A generic question means it fell back; `/admin` shows why.
4. **Raise the anonymous sign-in limit** if more than ~25 people will join from one Wi-Fi (README → Part 2, step 2).
5. **Put the link in a QR code** (any QR generator) so testers can scan it with the iPhone camera.

## 1 · Start the session
`/admin` → name it (who, how many, where, what you changed since last time) → **Start session**. Testers now see a thin banner in the app: *"Test session … · feedback and app logs are recorded"*.

## 2 · Testers join
Testers scan the QR code, then read the consent screen, pick a nickname and avatar, and open **Pop Music Bot**. Tell them:

- "Chat normally. Some members are AI — you're not told who."
- "If anything feels off, tap the message → **Something's off?**"
- "For anything else, tap **Feedback** (bug / hard to use / idea, one line)."

**Small tasks that produce useful evidence** (hand them out on cards):

| Task | What it tests |
|---|---|
| @mention someone you think is AI | mention trigger, reply quality |
| Ask a member "are you an AI?" | the honesty rule |
| Everyone stay silent for one minute | the 45 s silence rule; does a human answer the host within 60 s? |
| Lock your phone for a minute, then come back | catch-up after sleep (`catchup` events) |
| Turn on airplane mode for 10 s, then off | reconnect (`realtime_status`, `reconnect`) |
| Send three messages very fast | ordering, duplicates |
| Two people @mention the same AI at once | the lock: only one reply |

## 3 · During the session
`/admin` → **Refresh** shows participants, message counts and feedback as they arrive. Note anything odd you see in the room (time + what happened), so you can match it with the data later.

## 4 · End the session
`/admin` → **End session**. Later activity is no longer recorded under it.

## 5 · Run the checks
`/admin` → **Run checks**. This runs `run_checks(session_id)` in the database and lists **anomalies**:

| Anomaly | Meaning | Severity |
|---|---|---|
| `ai_lock_violation` | two AI messages in one room less than 15 s apart (the lock failed) | high |
| `ai_share_over_third` | more than 4 AI messages in some 12 in a row | high |
| `duplicate_message` | same `client_msg_id` twice (high), or the same person sent the same text twice within 10 s (medium) | high / medium |
| `non_member_message` | someone posted in a room they hadn't joined (a security rule failed) | high |
| `tester_reported_delivery` | a tester reported missed, duplicated or out-of-order messages | medium |
| `slow_delivery` | the slowest 5 % of message deliveries took more than 2 s (p95 > 2 s) | medium |
| `llm_failure_rate` | more than 10 % of LLM calls errored or fell back | medium |

Re-running is safe (results are replaced). The same function runs in the SQL editor: `select public.run_checks('<session id>');`

## 6 · Read the summary
| Tile | What it tells you | Healthy |
|---|---|---|
| People | participants; how many **never spoke**; median time from opening the room to first message | few silent people, short time |
| Messages / AI share | human vs AI messages | the ⅓ rule never broken |
| Host revivals | after the host broke a silence, did a human reply within 60 s? | high — that's the feature working |
| Delivery p95 | how fast messages reach other phones (95 % arrive within …) | under 2 s |
| LLM calls | calls, fallbacks, errors, latency | 0 fallbacks |
| Client errors | JS errors, failed requests, realtime problems, crashes | 0 |
| AI host decisions | why the host stayed quiet (`lock_busy`, `ratio_cap`, …) | explains "the host was too quiet / too loud" |
| Messages realtime missed | messages a phone only got through catch-up | 0, or explained by phones sleeping |

## 7 · Export
`/admin` → **Export CSV** — one file per table: messages (with sender name and human/AI/system), participants, feedback (with auto context), client events, AI events, anomalies. They open in Excel/Numbers/Google Sheets (formulas in tester text are neutralised).

**Portfolio tip:** keep one row per session in a spreadsheet: version, testers, AI share, revival rate, p95, fallbacks, anomalies, top feedback themes. Two or three rounds tell the iteration story with numbers.

---

## Automated checks (no testers needed)

All of these run against the local stack (README → Part 1).

| Command | What it proves |
|---|---|
| `npm test` | 120 unit tests: AI trigger/guard decisions, prompt and reply cleaning, LLM error handling, message dedupe/ordering, telemetry batching and rate cap, session summary, CSV |
| `npm run test:db` | 30 database tests: testers can't read personas or the lock, can't post as others or fake times; each anomaly check flags injected faults; a clean session has 0 anomalies |
| `npm run verify:local` | 14 end-to-end checks with 3 simulated phones in a throwaway room: online count, live delivery, @mention dedupe (exactly one reply), 45 s silence (exactly one host message), wrong key → fallback logged, feedback + reports stamped with session/version, batched client events, run_checks finds an injected duplicate and lock violation, admin-only access, summary + CSV. Add `--keep` to inspect the run in `/admin`. |
| `npm run simulate` | load test (below) |

### Load simulation

```bash
npm run simulate -- --clients 20 --minutes 3
```

N simulated phones join one room (a throwaway room by default) and each sends a message every 5–20 s. At the end it compares what every phone received with what the database holds, and prints, per phone: sent, received, **missed**, **duplicates**, latency p50/p95/max. It writes a JSON report to `.sim/` and uploads the latency samples as client events (so `run_checks` and `/admin` can use them if a session is running).

Options: `--clients`, `--minutes`, `--min-gap`, `--max-gap`, `--room <slug>` (use an existing room), `--with-ai` (also @mentions the AI and runs silence timers — **this makes LLM calls**; without it, no LLM is called), `--keep`, `--no-events`.

**Sign-in for many phones:** locally, the script creates a pool of email/password test users with the service role key (stored in `.sim/users.json`, git-ignored), because anonymous sign-ins are limited per IP. Against a **hosted** project without a service key:

```bash
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_PUBLISHABLE_KEY=<publishable key> npm run simulate -- --auth anon --room pop-music --clients 20
```

Raise **Authentication → Rate Limits → anonymous sign-ins** first (default 30/hour per IP). Simulated users stay in the project afterwards: delete them in Authentication → Users if you like.

**Reference results** (this Mac, local Docker stack, 2026-11-10): 20 phones × 3 min → 282 messages, 5,640 deliveries, 0 missed, 0 duplicates, latency p50 265 ms / p95 520 ms / max 542 ms. 20 phones × 1 min after a database reset → 96 messages, 1,920 deliveries, 0 missed, 0 duplicates, p95 531 ms.

The simulation starts after Realtime is connected; `verify:local` also waits for Realtime to start streaming (it reports how long — about 2.5 s after a cold start).

---

## Rehearsing alone on one laptop
Open `http://localhost:5173` and `http://localhost:5173/?slot=2` (and `?slot=3`) — each tab is a separate person. Note that a tab in the background counts as "phone locked": its silence timer pauses and it catches up when you return, just like an iPhone.
