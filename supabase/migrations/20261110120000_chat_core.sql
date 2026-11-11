-- ─────────────────────────────────────────────────────────────────────────────
-- 01 · Chat core: who is talking, in which room, and what they said.
--
-- Row Level Security (RLS) is switched on for every table. With RLS on and no
-- policy, nobody can read or write a table through the API — except the
-- "service role" used by Edge Functions and scripts. Each policy below opens
-- exactly one door, and its name says which.
-- ─────────────────────────────────────────────────────────────────────────────

-- profiles ────────────────────────────────────────────────────────────────────
-- The public face of every member, human or AI. Humans: id = auth.uid().
-- AI members: a random id, linked from bots.profile_id. There is deliberately
-- no "is_ai" column (and no created_at), so testers cannot tell who is AI.
create table public.profiles (
  id uuid primary key,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 24),
  avatar text not null check (avatar ~ '^[a-z0-9-]{1,24}$')
);

alter table public.profiles enable row level security;

create policy "read own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "create own profile" on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy "update own profile" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- consents ────────────────────────────────────────────────────────────────────
-- Kept apart from profiles so consent details are private to each person.
create table public.consents (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  consent_version text not null check (char_length(consent_version) <= 32),
  accepted_at timestamptz not null default now()
);

alter table public.consents enable row level security;

create policy "read own consent" on public.consents
  for select to authenticated using (user_id = (select auth.uid()));
create policy "give own consent" on public.consents
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "renew own consent" on public.consents
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- rooms ───────────────────────────────────────────────────────────────────────
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  name text not null check (char_length(name) between 1 and 60),
  topic text not null check (char_length(topic) between 1 and 400),
  tags text[] not null default '{}',
  emoji text not null default '💬',
  max_participants int not null default 50 check (max_participants between 2 and 500),
  -- The AI "talking stick". Only one AI turn per room can hold it (see migration 03).
  ai_lock_until timestamptz,
  created_at timestamptz not null default now()
);

alter table public.rooms enable row level security;

create policy "signed-in users list rooms" on public.rooms
  for select to authenticated using (true);

-- Column privileges: testers may read every column except the AI lock.
-- (So the app must name its columns: select('id, name, ...'), not select('*').)
revoke select on public.rooms from anon, authenticated;
grant select (id, slug, name, topic, tags, emoji, max_participants, created_at)
  on public.rooms to authenticated;

-- bots (AI members) ────────────────────────────────────────────────────────────
create table public.bots (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  role text not null check (role in ('host', 'participant')),
  language text not null default 'en' check (language ~ '^[a-z]{2}(-[A-Za-z]{2,4})?$'),
  tags text[] not null default '{}',
  activity_level smallint not null default 2 check (activity_level between 1 and 3),   -- 1 quiet · 3 chatty
  professionalism smallint not null default 2 check (professionalism between 1 and 3), -- 1 casual · 3 expert
  banned_words text[] not null default '{}',
  custom_chat_style text not null default '' check (char_length(custom_chat_style) <= 600),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index bots_one_active_host_per_room
  on public.bots (room_id) where role = 'host' and is_active;

alter table public.bots enable row level security;
-- No policy for testers on purpose: nobody in the app can read personas, so
-- nobody can tell which members are AI. The room-ai Edge Function reads this
-- table with the service role. (Admins get read access in migration 02.)

-- room_members ────────────────────────────────────────────────────────────────
create table public.room_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz,   -- heartbeat while the room is open ("is a human online?")
  welcomed_at timestamptz,    -- set once the AI host has welcomed this member
  primary key (room_id, profile_id)
);

create index room_members_profile_idx on public.room_members (profile_id);

alter table public.room_members enable row level security;

create policy "read own memberships" on public.room_members
  for select to authenticated using (profile_id = (select auth.uid()));
-- Joining happens through join_room() below, so the "X joined" notice is
-- written in the same transaction. The member list comes from room_roster().

-- Helper used by policies. SECURITY DEFINER = runs with the owner's rights,
-- which avoids RLS checking RLS checking RLS.
create function public.is_room_member(p_room_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.room_members m
    where m.room_id = p_room_id and m.profile_id = (select auth.uid())
  );
$$;

-- messages ────────────────────────────────────────────────────────────────────
create table public.messages (
  -- A growing number: "give me everything after id 1234" is how a phone that
  -- was asleep catches up.
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms (id) on delete cascade,
  profile_id uuid references public.profiles (id) on delete set null,
  kind text not null default 'chat' check (kind in ('chat', 'system')),
  content text not null check (char_length(btrim(content)) between 1 and 1000),
  -- Made by the sender's phone before sending. If the same send is retried,
  -- the unique constraint stops a second copy.
  client_msg_id uuid not null unique default gen_random_uuid(),
  mentions uuid[] not null default '{}' check (cardinality(mentions) <= 10),
  -- Server time. Testers cannot set it (see the column grants below).
  created_at timestamptz not null default now()
);

create index messages_room_created_idx on public.messages (room_id, created_at desc, id desc);
create index messages_room_id_idx on public.messages (room_id, id);

alter table public.messages enable row level security;

create policy "members read their rooms" on public.messages
  for select to authenticated using (public.is_room_member(room_id));
create policy "members post as themselves" on public.messages
  for insert to authenticated
  with check (
    profile_id = (select auth.uid())
    and kind = 'chat'
    and public.is_room_member(room_id)
  );

-- Testers may only fill in these columns; id, kind and created_at are the server's.
revoke insert, update, delete on public.messages from anon, authenticated;
grant insert (room_id, profile_id, content, client_msg_id, mentions)
  on public.messages to authenticated;

-- Realtime: broadcast new rows to subscribers (RLS still decides who receives them).
alter publication supabase_realtime add table public.messages;

-- question_bank ───────────────────────────────────────────────────────────────
-- Conversation starters. The free fallback when the LLM is unavailable,
-- and the second half of every welcome message.
create table public.question_bank (
  id bigint generated always as identity primary key,
  tags text[] not null default '{}',  -- matches rooms.tags; empty = fits any room
  language text not null default 'en',
  text text not null check (char_length(text) between 5 and 300),
  is_active boolean not null default true
);

alter table public.question_bank enable row level security;
-- No policies: only the Edge Function (service role) reads it.

-- RPCs the app calls ──────────────────────────────────────────────────────────

-- Precise server time, so each phone can measure its clock offset.
create function public.server_time()
returns timestamptz
language sql volatile
as $$ select clock_timestamp() $$;

-- Join a room (idempotent). Writes "<name> joined" for first-time members.
create function public.join_room(p_room_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_max int;
  v_count int;
begin
  if v_uid is null then
    raise exception 'Sign in first' using errcode = '28000';
  end if;

  select p.display_name into v_name from public.profiles p where p.id = v_uid;
  if v_name is null then
    raise exception 'Create your profile first' using errcode = 'P0001';
  end if;

  -- Lock the room row so two people cannot take the last seat at once.
  select r.max_participants into v_max from public.rooms r where r.id = p_room_id for update;
  if not found then
    raise exception 'Room not found' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.room_members m where m.room_id = p_room_id and m.profile_id = v_uid) then
    update public.room_members set last_seen_at = now()
     where room_id = p_room_id and profile_id = v_uid;
    return jsonb_build_object('joined', false);
  end if;

  select count(*) into v_count from public.room_members m where m.room_id = p_room_id;
  if v_count >= v_max then
    raise exception 'This room is full' using errcode = 'P0001';
  end if;

  insert into public.room_members (room_id, profile_id, last_seen_at) values (p_room_id, v_uid, now());
  insert into public.messages (room_id, profile_id, kind, content)
  values (p_room_id, v_uid, 'system', v_name || ' joined');

  return jsonb_build_object('joined', true);
end;
$$;

-- Everyone in a room (humans and AI look the same), for names and @mentions.
-- Ordered by name, not join time, so it does not hint at who was there first.
create function public.room_roster(p_room_id uuid)
returns table (profile_id uuid, display_name text, avatar text)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.display_name, p.avatar
  from public.room_members m
  join public.profiles p on p.id = m.profile_id
  where m.room_id = p_room_id
    and public.is_room_member(p_room_id)
  order by lower(p.display_name), p.id;
$$;

-- Heartbeat: "I still have this room open". Used for the "no human online" rule.
create function public.touch_room(p_room_id uuid)
returns void
language sql volatile security definer set search_path = ''
as $$
  update public.room_members set last_seen_at = now()
   where room_id = p_room_id and profile_id = auth.uid();
$$;

-- Functions are executable by everyone by default; open only what the app needs.
revoke all on function public.is_room_member(uuid) from public, anon;
revoke all on function public.server_time() from public, anon;
revoke all on function public.join_room(uuid) from public, anon;
revoke all on function public.room_roster(uuid) from public, anon;
revoke all on function public.touch_room(uuid) from public, anon;
grant execute on function public.is_room_member(uuid) to authenticated, service_role;
grant execute on function public.server_time() to authenticated, service_role;
grant execute on function public.join_room(uuid) to authenticated;
grant execute on function public.room_roster(uuid) to authenticated, service_role;
grant execute on function public.touch_room(uuid) to authenticated;
