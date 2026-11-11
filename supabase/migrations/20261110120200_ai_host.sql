-- ─────────────────────────────────────────────────────────────────────────────
-- 03 · The AI host's "talking stick" and helpers for the room-ai Edge Function.
--
-- Several phones may ask the AI to speak at the same moment (for example, every
-- phone's 45-second silence timer fires together). The lock makes sure only one
-- of those requests becomes a message, and that AI messages in a room are at
-- least 15 seconds apart. All functions here are for the service role only.
-- ─────────────────────────────────────────────────────────────────────────────

-- Try to take the room's lock for 15 seconds. Returns a token (the new
-- ai_lock_until) or NULL when someone else holds it. A single UPDATE ... WHERE
-- is atomic: when two calls arrive together, exactly one of them changes the row.
create function public.ai_try_lock(p_room_id uuid)
returns timestamptz
language sql volatile set search_path = ''
as $$
  update public.rooms
     set ai_lock_until = now() + interval '15 seconds'
   where id = p_room_id
     and (ai_lock_until is null or ai_lock_until < now())
  returning ai_lock_until;
$$;

-- Give the lock back early (only if we still hold it), e.g. when a later
-- guard decides the AI should stay quiet after all.
create function public.ai_release_lock(p_room_id uuid, p_token timestamptz)
returns boolean
language sql volatile set search_path = ''
as $$
  update public.rooms set ai_lock_until = null
   where id = p_room_id and ai_lock_until = p_token
  returning true;
$$;

-- Post the AI's message while holding the lock, then keep the lock for 15 s
-- *after* the message, so the next AI message is at least 15 s later.
-- Returns the new message as JSON, or NULL if the lock was lost.
create function public.ai_post_message(
  p_room_id uuid,
  p_profile_id uuid,
  p_content text,
  p_token timestamptz
)
returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v public.messages;
begin
  -- Still holding the stick? FOR UPDATE stops anyone taking it meanwhile.
  perform 1 from public.rooms r
   where r.id = p_room_id and r.ai_lock_until = p_token
     for update;
  if not found then
    return null;
  end if;

  insert into public.messages (room_id, profile_id, kind, content)
  values (p_room_id, p_profile_id, 'chat', p_content)
  returning * into v;

  update public.rooms set ai_lock_until = v.created_at + interval '15 seconds'
   where id = p_room_id;

  return jsonb_build_object('id', v.id, 'created_at', v.created_at);
end;
$$;

-- Mark a member as welcomed. Returns true for the first caller only.
create function public.ai_claim_welcome(p_room_id uuid, p_profile_id uuid)
returns boolean
language sql volatile set search_path = ''
as $$
  update public.room_members set welcomed_at = now()
   where room_id = p_room_id and profile_id = p_profile_id and welcomed_at is null
  returning true;
$$;

-- Everything the AI needs to decide, in one round trip (a "snapshot").
create function public.ai_room_context(
  p_room_id uuid,
  p_caller_id uuid,
  p_message_id bigint default null
)
returns jsonb
language sql stable set search_path = ''
as $$
  with room as (
    select r.id, r.name, r.topic, r.tags, r.ai_lock_until
    from public.rooms r where r.id = p_room_id
  ),
  bot_list as (
    select b.id, b.profile_id, b.role, b.language, b.tags, b.activity_level,
           b.professionalism, b.banned_words, b.custom_chat_style, p.display_name
    from public.bots b
    join public.profiles p on p.id = b.profile_id
    where b.room_id = p_room_id and b.is_active
  ),
  ai_profiles as (
    select b.profile_id from public.bots b where b.room_id = p_room_id
  ),
  recent_chat as (
    select m.id, m.profile_id, m.kind, m.content, m.created_at, m.mentions,
           coalesce(p.display_name, 'Someone') as display_name,
           coalesce(m.profile_id in (select profile_id from ai_profiles), false) as is_ai
    from public.messages m
    left join public.profiles p on p.id = m.profile_id
    where m.room_id = p_room_id and m.kind = 'chat'
    order by m.created_at desc, m.id desc
    limit 20
  ),
  latest as (
    select m.id, m.kind, m.created_at,
           coalesce(m.kind = 'chat' and m.profile_id in (select profile_id from ai_profiles), false) as is_ai
    from public.messages m
    where m.room_id = p_room_id
    order by m.created_at desc, m.id desc
    limit 1
  ),
  trigger_message as (
    select m.id, m.profile_id, m.kind, m.content, m.created_at, m.mentions,
           coalesce(p.display_name, 'Someone') as display_name,
           coalesce(m.profile_id in (select profile_id from ai_profiles), false) as is_ai
    from public.messages m
    left join public.profiles p on p.id = m.profile_id
    where m.id = p_message_id and m.room_id = p_room_id
  )
  select jsonb_build_object(
    'now', now(),
    'room', (select to_jsonb(room) from room),
    'bots', coalesce((select jsonb_agg(to_jsonb(bot_list)) from bot_list), '[]'::jsonb),
    'recent_chat', coalesce(
      (select jsonb_agg(to_jsonb(rc) order by rc.created_at, rc.id) from recent_chat rc), '[]'::jsonb),
    'latest', (select to_jsonb(latest) from latest),
    'trigger_message', (select to_jsonb(trigger_message) from trigger_message),
    'already_replied', exists (
      select 1 from public.ai_events e
      where p_message_id is not null and e.trigger_message_id = p_message_id and e.decision = 'spoke'
    ),
    'humans_online', (
      select count(*) from public.room_members m
      where m.room_id = p_room_id
        and m.last_seen_at > now() - interval '60 seconds'
        and m.profile_id not in (select profile_id from ai_profiles)
    ),
    'caller', (
      select jsonb_build_object(
        'is_member', true,
        'joined_at', m.joined_at,
        'welcomed_at', m.welcomed_at,
        'display_name', p.display_name
      )
      from public.room_members m
      join public.profiles p on p.id = m.profile_id
      where m.room_id = p_room_id and m.profile_id = p_caller_id
    ),
    'llm_calls_last_hour', (
      select count(*) from public.ai_events e
      where e.room_id = p_room_id and e.llm_attempted and e.created_at > now() - interval '1 hour'
    )
  );
$$;

revoke all on function public.ai_try_lock(uuid) from public, anon, authenticated;
revoke all on function public.ai_release_lock(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.ai_post_message(uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.ai_claim_welcome(uuid, uuid) from public, anon, authenticated;
revoke all on function public.ai_room_context(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.ai_try_lock(uuid) to service_role;
grant execute on function public.ai_release_lock(uuid, timestamptz) to service_role;
grant execute on function public.ai_post_message(uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.ai_claim_welcome(uuid, uuid) to service_role;
grant execute on function public.ai_room_context(uuid, uuid, bigint) to service_role;
