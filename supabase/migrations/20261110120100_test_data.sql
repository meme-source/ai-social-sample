-- ─────────────────────────────────────────────────────────────────────────────
-- 02 · Test-data system: test sessions, tester feedback, automatic logs,
--      anomalies, and the admin allow-list.
--
-- Every row written while a test session is running gets that session's id,
-- stamped by the database itself (the app cannot choose or fake it).
-- ─────────────────────────────────────────────────────────────────────────────

-- admins ──────────────────────────────────────────────────────────────────────
-- Add someone with:  insert into public.admins (user_id, note) values ('<id from /me>', 'tutor laptop');
create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  note text,
  added_at timestamptz not null default now()
);

alter table public.admins enable row level security;

create policy "see whether I am an admin" on public.admins
  for select to authenticated using (user_id = (select auth.uid()));

create function public.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = (select auth.uid()));
$$;

-- Admins in the app, scripts using the service role key, or a direct database
-- connection as the owner (SQL editor, psql) may manage test sessions. A
-- connection that switched to another role (how the API and tests act as a
-- user) is judged as that user instead.
create function public.can_manage_tests()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.is_admin()
      or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
      or (
        session_user in ('postgres', 'supabase_admin')
        and coalesce(nullif(current_setting('role', true), ''), 'none') = 'none'
      );
$$;

-- test_sessions ───────────────────────────────────────────────────────────────
create table public.test_sessions (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(btrim(label)) between 1 and 80),
  app_version text check (char_length(app_version) <= 64),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  started_by uuid references auth.users (id) on delete set null,
  last_checked_at timestamptz,
  check (ended_at is null or ended_at >= started_at)
);

-- At most one session can be running at a time.
create unique index test_sessions_one_active on public.test_sessions ((true)) where ended_at is null;

alter table public.test_sessions enable row level security;

-- Testers may see that a session is running (the app shows a small banner).
create policy "signed-in users see sessions" on public.test_sessions
  for select to authenticated using (true);

create function public.active_session_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select s.id from public.test_sessions s
  where s.ended_at is null
  order by s.started_at desc
  limit 1;
$$;

-- Trigger: stamp the running session on each new row.
create function public.stamp_session_id()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.session_id := public.active_session_id();
  return new;
end;
$$;

alter table public.messages
  add column session_id uuid references public.test_sessions (id) on delete set null;
create index messages_session_idx on public.messages (session_id, room_id, created_at);
create trigger messages_stamp_session
  before insert on public.messages
  for each row execute function public.stamp_session_id();

-- feedback (written by testers) ───────────────────────────────────────────────
create table public.feedback (
  id bigint generated always as identity primary key,
  session_id uuid references public.test_sessions (id) on delete set null,
  profile_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  -- 'general' = the Feedback button; 'message' = "Something's off" on one message
  kind text not null check (kind in ('general', 'message')),
  category text not null check (category in (
    'bug', 'hard_to_use', 'idea',                                    -- general
    'duplicated', 'out_of_order', 'missed', 'weird_reply', 'other'   -- message
  )),
  note text check (char_length(note) <= 500),
  message_id bigint references public.messages (id) on delete set null,
  room_id uuid references public.rooms (id) on delete set null,
  app_version text check (char_length(app_version) <= 64),
  -- user agent, viewport, online count, client time, path (no message text)
  context jsonb not null default '{}' check (pg_column_size(context) <= 4096),
  created_at timestamptz not null default now(),
  check ((kind = 'general') = (category in ('bug', 'hard_to_use', 'idea'))),
  check (kind <> 'general' or char_length(btrim(coalesce(note, ''))) > 0),
  check (kind <> 'message' or message_id is not null)
);

create index feedback_session_idx on public.feedback (session_id, created_at);

alter table public.feedback enable row level security;

create policy "testers send feedback as themselves" on public.feedback
  for insert to authenticated with check (profile_id = (select auth.uid()));

revoke insert, update, delete on public.feedback from anon, authenticated;
grant insert (kind, category, note, message_id, room_id, app_version, context)
  on public.feedback to authenticated;

create trigger feedback_stamp_session
  before insert on public.feedback
  for each row execute function public.stamp_session_id();

-- client_events (written automatically by the app) ────────────────────────────
-- Errors, failed requests, realtime status, catch-ups, duplicates, ordering and
-- delivery latency. Never message text.
create table public.client_events (
  id bigint generated always as identity primary key,
  session_id uuid references public.test_sessions (id) on delete set null,
  app_version text check (char_length(app_version) <= 64),
  profile_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  room_id uuid references public.rooms (id) on delete set null,
  type text not null check (type ~ '^[a-z][a-z0-9_]{1,39}$'),
  data jsonb not null default '{}' check (pg_column_size(data) <= 8192),
  client_ts timestamptz not null,
  server_ts timestamptz not null default now()
);

create index client_events_session_idx on public.client_events (session_id, type);
create index client_events_profile_ts_idx on public.client_events (profile_id, server_ts desc);

alter table public.client_events enable row level security;

create policy "apps log events as their user" on public.client_events
  for insert to authenticated with check (profile_id = (select auth.uid()));

revoke insert, update, delete on public.client_events from anon, authenticated;
grant insert (room_id, type, data, client_ts, app_version)
  on public.client_events to authenticated;

create trigger client_events_stamp_session
  before insert on public.client_events
  for each row execute function public.stamp_session_id();

-- Server-side safety net: the app already caps itself at 60 events a minute;
-- this drops anything beyond 240 a minute from one user (a runaway loop).
create function public.client_events_rate_cap()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (
    select count(*) from public.client_events e
    where e.profile_id = new.profile_id and e.server_ts > now() - interval '1 minute'
  ) >= 240 then
    return null;  -- skip this row on purpose
  end if;
  return new;
end;
$$;

create trigger client_events_rate_cap
  before insert on public.client_events
  for each row execute function public.client_events_rate_cap();

-- ai_events (written by the room-ai Edge Function only) ───────────────────────
-- One row per trigger: what happened and why.
create table public.ai_events (
  id bigint generated always as identity primary key,
  session_id uuid references public.test_sessions (id) on delete set null,
  room_id uuid not null references public.rooms (id) on delete cascade,
  trigger text not null check (trigger in ('mention', 'silence', 'join')),
  caller_id uuid,                -- whose app made the call
  trigger_message_id bigint references public.messages (id) on delete set null,
  bot_id uuid references public.bots (id) on delete set null,
  decision text not null check (decision in ('spoke', 'skipped')),
  reason text,                   -- why it skipped: lock_busy, ratio_cap, budget_cap, no_human_online, ...
  message_id bigint references public.messages (id) on delete set null,  -- what it said
  llm_attempted boolean not null default false,
  provider text,
  model text,
  latency_ms int,
  prompt_tokens int,
  completion_tokens int,
  fallback_used boolean not null default false,
  error_code text,
  function_version text,
  created_at timestamptz not null default now()
);

create index ai_events_room_created_idx on public.ai_events (room_id, created_at desc);
create index ai_events_session_idx on public.ai_events (session_id, created_at);
create index ai_events_trigger_message_idx on public.ai_events (trigger_message_id) where trigger_message_id is not null;

alter table public.ai_events enable row level security;
-- No insert policy: only the service role (the Edge Function) writes here.

create trigger ai_events_stamp_session
  before insert on public.ai_events
  for each row execute function public.stamp_session_id();

-- anomalies (written by run_checks) ───────────────────────────────────────────
create table public.anomalies (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.test_sessions (id) on delete cascade,
  type text not null,
  severity text not null check (severity in ('low', 'medium', 'high')),
  room_id uuid references public.rooms (id) on delete set null,
  related_ids text[] not null default '{}',   -- e.g. {message:42, feedback:7}
  details jsonb not null default '{}',
  detected_at timestamptz not null default now()
);

create index anomalies_session_idx on public.anomalies (session_id, severity);

alter table public.anomalies enable row level security;

-- Admin read access ───────────────────────────────────────────────────────────
create policy "admins read profiles" on public.profiles for select to authenticated using (public.is_admin());
create policy "admins read consents" on public.consents for select to authenticated using (public.is_admin());
create policy "admins read bots" on public.bots for select to authenticated using (public.is_admin());
create policy "admins read memberships" on public.room_members for select to authenticated using (public.is_admin());
create policy "admins read messages" on public.messages for select to authenticated using (public.is_admin());
create policy "admins read feedback" on public.feedback for select to authenticated using (public.is_admin());
create policy "admins read client events" on public.client_events for select to authenticated using (public.is_admin());
create policy "admins read ai events" on public.ai_events for select to authenticated using (public.is_admin());
create policy "admins read anomalies" on public.anomalies for select to authenticated using (public.is_admin());
create policy "admins read admins" on public.admins for select to authenticated using (public.is_admin());

-- Admin RPCs ──────────────────────────────────────────────────────────────────
create function public.start_test_session(p_label text, p_app_version text default null)
returns public.test_sessions
language plpgsql security definer set search_path = ''
as $$
declare
  v public.test_sessions;
begin
  if not public.can_manage_tests() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if exists (select 1 from public.test_sessions s where s.ended_at is null) then
    raise exception 'A session is already running. End it first.' using errcode = 'P0001';
  end if;
  insert into public.test_sessions (label, app_version, started_by)
  values (btrim(p_label), p_app_version, auth.uid())
  returning * into v;
  return v;
end;
$$;

create function public.end_test_session(p_session_id uuid)
returns public.test_sessions
language plpgsql security definer set search_path = ''
as $$
declare
  v public.test_sessions;
begin
  if not public.can_manage_tests() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update public.test_sessions set ended_at = now()
   where id = p_session_id and ended_at is null
  returning * into v;
  if v.id is null then
    raise exception 'That session is not running' using errcode = 'P0001';
  end if;
  return v;
end;
$$;

revoke all on function public.is_admin() from public, anon;
revoke all on function public.can_manage_tests() from public, anon, authenticated;
revoke all on function public.active_session_id() from public, anon, authenticated;
revoke all on function public.stamp_session_id() from public, anon, authenticated;
revoke all on function public.client_events_rate_cap() from public, anon, authenticated;
revoke all on function public.start_test_session(text, text) from public, anon;
revoke all on function public.end_test_session(uuid) from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.start_test_session(text, text) to authenticated, service_role;
grant execute on function public.end_test_session(uuid) to authenticated, service_role;
