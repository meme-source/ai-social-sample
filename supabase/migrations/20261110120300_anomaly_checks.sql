-- ─────────────────────────────────────────────────────────────────────────────
-- 04 · Anomaly checks. Run after a test session (admin page → "Run checks",
--      or `select public.run_checks('<session id>');` in the SQL editor).
--
-- Each check looks for one kind of evidence that something went wrong and
-- writes one row per finding into public.anomalies. Re-running is safe: the
-- session's old findings are replaced.
-- ─────────────────────────────────────────────────────────────────────────────

create function public.run_checks(p_session_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  if not public.can_manage_tests() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.test_sessions s where s.id = p_session_id) then
    raise exception 'Unknown test session' using errcode = 'P0002';
  end if;

  delete from public.anomalies where session_id = p_session_id;

  -- 1 · Lock violation: two AI messages in one room less than 15 s apart.
  insert into public.anomalies (session_id, type, severity, room_id, related_ids, details)
  select p_session_id, 'ai_lock_violation', 'high', x.room_id,
         array['message:' || x.prev_id, 'message:' || x.id],
         jsonb_build_object(
           'gap_ms', round(extract(epoch from (x.created_at - x.prev_at)) * 1000),
           'min_gap_ms', 15000)
  from (
    select m.id, m.room_id, m.created_at,
           lag(m.id) over w as prev_id,
           lag(m.created_at) over w as prev_at
    from public.messages m
    where m.session_id = p_session_id
      and m.kind = 'chat'
      and exists (select 1 from public.bots b where b.profile_id = m.profile_id)
    window w as (partition by m.room_id order by m.created_at, m.id)
  ) x
  where x.prev_at is not null
    and x.created_at - x.prev_at < interval '15 seconds';

  -- 2 · AI share above 1/3: more than 4 AI messages in any 12 chat messages
  --     in a row. (Short rooms count too: 5 AI messages in the first 7 is over.)
  insert into public.anomalies (session_id, type, severity, room_id, related_ids, details)
  select p_session_id, 'ai_share_over_third', 'high', w.room_id,
         array['message:' || (array_agg(w.id order by w.created_at, w.id))[1]],
         jsonb_build_object(
           'windows_over_limit', count(*),
           'max_ai_in_12', max(w.ai_in_window),
           'limit', 4,
           'first_window_ends_at', min(w.created_at))
  from (
    select c.id, c.room_id, c.created_at,
           sum(c.is_ai) over (
             partition by c.room_id order by c.created_at, c.id
             rows between 11 preceding and current row) as ai_in_window
    from (
      select m.id, m.room_id, m.created_at,
             case when exists (select 1 from public.bots b where b.profile_id = m.profile_id)
                  then 1 else 0 end as is_ai
      from public.messages m
      where m.session_id = p_session_id and m.kind = 'chat'
    ) c
  ) w
  where w.ai_in_window > 4
  group by w.room_id;

  -- 3a · Duplicate client_msg_id. The unique constraint should make this
  --      impossible; the check proves it (and catches schemas without it).
  insert into public.anomalies (session_id, type, severity, room_id, related_ids, details)
  select p_session_id, 'duplicate_message', 'high', (array_agg(m.room_id))[1],
         array_agg('message:' || m.id order by m.id),
         jsonb_build_object('kind', 'same_client_msg_id', 'client_msg_id', m.client_msg_id, 'copies', count(*))
  from public.messages m
  where m.session_id = p_session_id
  group by m.client_msg_id
  having count(*) > 1;

  -- 3b · Double-send: the same person, same text, within 10 s, under a new
  --      client_msg_id (a retry that forgot to reuse its id).
  insert into public.anomalies (session_id, type, severity, room_id, related_ids, details)
  select p_session_id, 'duplicate_message', 'medium', x.room_id,
         array['message:' || x.prev_id, 'message:' || x.id],
         jsonb_build_object(
           'kind', 'same_text_within_10s',
           'gap_ms', round(extract(epoch from (x.created_at - x.prev_at)) * 1000))
  from (
    select m.id, m.room_id, m.content, m.created_at, m.client_msg_id,
           lag(m.id) over w as prev_id,
           lag(m.content) over w as prev_content,
           lag(m.created_at) over w as prev_at,
           lag(m.client_msg_id) over w as prev_client_msg_id
    from public.messages m
    where m.session_id = p_session_id and m.kind = 'chat' and m.profile_id is not null
    window w as (partition by m.room_id, m.profile_id order by m.created_at, m.id)
  ) x
  where x.prev_content = x.content
    and x.created_at - x.prev_at <= interval '10 seconds'
    and x.prev_client_msg_id <> x.client_msg_id;

  -- 4 · Messages from someone who was not a member of that room at the time.
  insert into public.anomalies (session_id, type, severity, room_id, related_ids, details)
  select p_session_id, 'non_member_message', 'high', m.room_id,
         array['message:' || m.id],
         jsonb_build_object('profile_id', m.profile_id, 'kind', m.kind)
  from public.messages m
  where m.session_id = p_session_id
    and m.profile_id is not null
    and not exists (
      select 1 from public.room_members rm
      where rm.room_id = m.room_id
        and rm.profile_id = m.profile_id
        and rm.joined_at <= m.created_at);

  -- 5 · Testers reported missed, duplicated or out-of-order messages.
  insert into public.anomalies (session_id, type, severity, room_id, related_ids, details)
  select p_session_id, 'tester_reported_delivery', 'medium', f.room_id,
         array['feedback:' || f.id]
           || case when f.message_id is null then '{}'::text[] else array['message:' || f.message_id] end,
         jsonb_build_object('category', f.category, 'note', f.note)
  from public.feedback f
  where f.session_id = p_session_id
    and f.category in ('duplicated', 'missed', 'out_of_order');

  -- 6 · Slow delivery: 95th percentile of message delivery latency above 2 s.
  insert into public.anomalies (session_id, type, severity, room_id, related_ids, details)
  select p_session_id, 'slow_delivery', 'medium', s.room_id, '{}',
         jsonb_build_object(
           'p95_ms', round(s.p95), 'p50_ms', round(s.p50), 'max_ms', round(s.max_ms),
           'samples', s.n, 'limit_ms', 2000)
  from (
    select e.room_id,
           count(v.ms) as n,
           percentile_cont(0.5) within group (order by v.ms) as p50,
           percentile_cont(0.95) within group (order by v.ms) as p95,
           max(v.ms) as max_ms
    from public.client_events e
    cross join lateral (
      select case when t.value ~ '^[0-9]+(\.[0-9]+)?$' then t.value::numeric end as ms
      from jsonb_array_elements_text(
        case when jsonb_typeof(e.data -> 'samples_ms') = 'array' then e.data -> 'samples_ms' else '[]'::jsonb end
      ) as t (value)
    ) v
    where e.session_id = p_session_id and e.type = 'latency_batch'
    group by e.room_id
  ) s
  where s.n > 0 and s.p95 > 2000;

  -- 7 · LLM trouble: more than 10 % of LLM calls errored or fell back.
  insert into public.anomalies (session_id, type, severity, room_id, related_ids, details)
  select p_session_id, 'llm_failure_rate', 'medium', null, '{}',
         jsonb_build_object(
           'llm_calls', x.n, 'errors', x.errors, 'fallbacks', x.fallbacks,
           'rate', round(x.rate, 3), 'limit', 0.10)
  from (
    select count(*) as n,
           count(*) filter (where e.error_code is not null) as errors,
           count(*) filter (where e.fallback_used) as fallbacks,
           (count(*) filter (where e.error_code is not null or e.fallback_used))::numeric
             / nullif(count(*), 0) as rate
    from public.ai_events e
    where e.session_id = p_session_id and e.llm_attempted
  ) x
  where x.n > 0 and x.rate > 0.10;

  update public.test_sessions set last_checked_at = now() where id = p_session_id;

  select count(*) into v_count from public.anomalies a where a.session_id = p_session_id;
  return v_count;
end;
$$;

revoke all on function public.run_checks(uuid) from public, anon;
grant execute on function public.run_checks(uuid) to authenticated, service_role;
