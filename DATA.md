# What this app collects, and why

Use this page to write (or check) the consent screen — its current wording is in `src/components/onboarding/consent-text.ts`. If you change what is collected, change both, and bump `CONSENT_VERSION` so everyone is asked again.

The principle: **collect only what helps improve the prototype, never what identifies a person, and tell testers plainly.**

## What is stored

| Data | Example | Why | Who can see it |
|---|---|---|---|
| **Guest account** | a random id like `a420e5d8-…` (Supabase anonymous sign-in) | to keep someone's messages and feedback together | the database; admins |
| **Profile** | nickname "Bo", avatar 🐱 | shown next to messages | everyone in the same room |
| **Consent record** | consent version + time | proof of agreement | the person; admins |
| **Messages** | text, room, time | it's a chat — and the material the study is about | people in that room; admins (and CSV exports) |
| **Room presence** | "last seen in this room" time, updated every 20 s while the room is on screen | the AI host only breaks silences when a human is there; online count | the AI function; admins |
| **Feedback** | type (bug / hard to use / idea, or a message issue), one line of text, which message it's about | testers' own words about problems | admins |
| **Feedback context** | browser + operating system (user agent), screen size, online count, app version, time, page | reproduce problems ("only on small iPhones") | admins |
| **App logs** (`client_events`) | JS errors, failed requests (operation + status code), realtime connection status, reconnects, catch-up counts, duplicates dropped, out-of-order arrivals, delivery times in milliseconds, clock offset | measure reliability and speed | admins |
| **AI decisions** (`ai_events`) | why the AI spoke or stayed quiet, model, response time, token counts, errors | understand and tune the AI host | admins |
| **Anomalies** | results of the after-session checks | find bugs | admins |

**App logs never contain message text.** The logging code strips any field that could hold it (`content`, `text`, `body`, `note`) and keeps only numbers, short codes and technical error messages; a test checks this.

## What is *not* collected
No email, phone number, real name, location, contacts, photos, camera or microphone, advertising or analytics trackers, or device identifiers. The app sets no cookies of its own (the sign-in session sits in the browser's local storage).

## Who else processes data (third parties)

| Service | What it receives | Note |
|---|---|---|
| **Supabase** (database, sign-in, realtime, functions) | everything above | stored in the region you chose for the project |
| **Vercel** (hosting the web app) | page requests (IP address, browser) in its logs | standard web hosting |
| **DeepSeek** (AI replies) | when an AI member replies: the room topic, the AI persona and the **last 20 messages of the room** (nicknames + text) | DeepSeek is a Chinese company and processes requests on its servers. Tell testers. To avoid this, switch provider (README → "Switching the LLM provider") |
| **Cloudflare Turnstile** (only if CAPTCHA is on) | a browser check during sign-in | stops bots creating accounts |
| **Google Fonts** | the display font is loaded from Google, which sees the IP address | self-host the font to avoid it |

## How long, and deleting on request

- Suggested: keep test data until the project/portfolio is finished, then delete it. Put the date in the consent text.
- Testers can find their id on the **My ID** page (`/me`). To delete one person's data, run this in Supabase → SQL Editor, using their id:

```sql
-- 1. Their messages (otherwise they would stay, without a name).
delete from public.messages where profile_id = '<their id>';
-- 2. Their profile — this also removes their room memberships and feedback.
delete from public.profiles where id = '<their id>';
-- 3. Their guest account — this also removes their consent record and app logs.
delete from auth.users where id = '<their id>';
```

- To remove a whole test session's logs: `delete from public.client_events where session_id = '<session id>';` (and the same for `feedback`, `ai_events`, `anomalies`).

## Being fair to testers
- Say clearly that **some members are AI** and that you won't say which (the consent screen does). The AI never claims to be human.
- Ask testers to use a nickname and not to share personal details in the chat.
- Test with adults (18+). For anyone younger, get a parent's or guardian's consent first.
- In the UK this falls under UK GDPR, in Hong Kong under the PDPO. For a small prototype test, clear information, minimal data, consent and deletion on request cover the basics — this is not legal advice.
