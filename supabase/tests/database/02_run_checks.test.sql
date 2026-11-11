-- The anomaly checks: a clean session passes; each injected fault is flagged.
-- Run with: npm run test:db   (everything is rolled back)
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

-- Arrange: a room with an AI host, two human members, one outsider ─────────────
insert into auth.users (id, aud, role, email) values
  ('c0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'h1@test.local'),
  ('c0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'h2@test.local'),
  ('c0000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'out@test.local');
insert into public.profiles (id, display_name, avatar) values
  ('c0000000-0000-4000-8000-000000000001', 'Human One', 'fox'),
  ('c0000000-0000-4000-8000-000000000002', 'Human Two', 'owl'),
  ('c0000000-0000-4000-8000-000000000003', 'Outsider', 'cat'),
  ('c0000000-0000-4000-8000-0000000000a1', 'Hosty', 'panda');
insert into public.rooms (id, slug, name, topic) values
  ('d0000000-0000-4000-8000-000000000001', 'checks-room', 'Checks room', 'testing');
insert into public.bots (id, profile_id, room_id, role) values
  ('e0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1',
   'd0000000-0000-4000-8000-000000000001', 'host');
insert into public.room_members (room_id, profile_id, joined_at) values
  ('d0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', now() - interval '2 hours'),
  ('d0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', now() - interval '2 hours'),
  ('d0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', now() - interval '2 hours');

create temp table s as select * from public.start_test_session('pgTAP checks', 'test');

-- Helper: one chat message, `secs` seconds into the test (all inside the session).
create function pg_temp.say(p_profile text, p_secs int, p_text text) returns void language sql as $$
  insert into public.messages (room_id, profile_id, content, created_at)
  values ('d0000000-0000-4000-8000-000000000001', p_profile::uuid, p_text,
          now() - interval '1 hour' + make_interval(secs => p_secs));
$$;

-- A clean conversation: 12 messages, 3 from the AI, AI messages ≥ 15 s apart.
select pg_temp.say('c0000000-0000-4000-8000-000000000001',   0, 'hi all');
select pg_temp.say('c0000000-0000-4000-8000-0000000000a1',  20, 'welcome!');
select pg_temp.say('c0000000-0000-4000-8000-000000000002',  40, 'hey');
select pg_temp.say('c0000000-0000-4000-8000-000000000001',  60, 'what are you listening to?');
select pg_temp.say('c0000000-0000-4000-8000-000000000002',  80, 'old stuff');
select pg_temp.say('c0000000-0000-4000-8000-0000000000a1', 100, 'like what?');
select pg_temp.say('c0000000-0000-4000-8000-000000000002', 120, '90s pop');
select pg_temp.say('c0000000-0000-4000-8000-000000000001', 140, 'nice');
select pg_temp.say('c0000000-0000-4000-8000-000000000002', 160, 'you?');
select pg_temp.say('c0000000-0000-4000-8000-000000000001', 180, 'mostly k-pop');
select pg_temp.say('c0000000-0000-4000-8000-0000000000a1', 240, 'any favourite group?');
select pg_temp.say('c0000000-0000-4000-8000-000000000001', 260, 'too many');
insert into public.ai_events (room_id, trigger, decision, llm_attempted)
select 'd0000000-0000-4000-8000-000000000001', 'mention', 'spoke', true from generate_series(1, 10);
insert into public.client_events (profile_id, room_id, type, data, client_ts)
values ('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
        'latency_batch', '{"samples_ms":[120,180,240,300,900]}', now());

select is(public.run_checks((select id from s)), 0, 'a clean session has no anomalies');
select isnt((select last_checked_at from public.test_sessions where id = (select id from s)), null,
  'run_checks records when it ran');

-- Inject faults ───────────────────────────────────────────────────────────────
-- Two AI messages 5 s apart (a lock violation), then a third 25 s later (no
-- violation): now 5 of the last 12 chat messages are AI — over the 1/3 limit.
select pg_temp.say('c0000000-0000-4000-8000-0000000000a1', 300, 'first AI line');
select pg_temp.say('c0000000-0000-4000-8000-0000000000a1', 305, 'second AI line, too soon');
select pg_temp.say('c0000000-0000-4000-8000-0000000000a1', 330, 'third AI line');
-- A double-send: same person, same text, 3 s apart, new client_msg_id.
select pg_temp.say('c0000000-0000-4000-8000-000000000002', 400, 'see you later');
select pg_temp.say('c0000000-0000-4000-8000-000000000002', 403, 'see you later');
-- Someone who is not a member of the room.
select pg_temp.say('c0000000-0000-4000-8000-000000000003', 420, 'let me in');
-- A tester says they missed messages.
insert into public.feedback (profile_id, kind, category, note, message_id, room_id)
select 'c0000000-0000-4000-8000-000000000001', 'message', 'missed', 'gap after unlocking', max(id),
       'd0000000-0000-4000-8000-000000000001'
from public.messages;
-- Slow deliveries and a failing LLM.
insert into public.client_events (profile_id, room_id, type, data, client_ts)
values ('c0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001',
        'latency_batch', '{"samples_ms":[3000,4000,5000,6000,7000,8000,9000]}', now());
insert into public.ai_events (room_id, trigger, decision, llm_attempted, fallback_used, error_code)
values ('d0000000-0000-4000-8000-000000000001', 'silence', 'spoke', true, true, 'auth'),
       ('d0000000-0000-4000-8000-000000000001', 'silence', 'spoke', true, true, 'timeout');

create temp table found as select public.run_checks((select id from s)) as n;
create function pg_temp.flagged(p_type text, p_kind text default null) returns bigint language sql as $$
  select count(*) from public.anomalies
  where session_id = (select id from s) and type = p_type
    and (p_kind is null or details ->> 'kind' = p_kind);
$$;

select is(pg_temp.flagged('ai_lock_violation'), 1::bigint, 'flags two AI messages 5 s apart');
select is(
  (select (details ->> 'gap_ms')::int from public.anomalies
   where session_id = (select id from s) and type = 'ai_lock_violation'),
  5000, 'reports the gap in milliseconds');
select is(pg_temp.flagged('ai_share_over_third'), 1::bigint, 'flags more than 4 AI messages in 12');
select is(pg_temp.flagged('duplicate_message', 'same_text_within_10s'), 1::bigint, 'flags a double-send');
select is(pg_temp.flagged('non_member_message'), 1::bigint, 'flags a message from a non-member');
select is(pg_temp.flagged('tester_reported_delivery'), 1::bigint, 'turns a "missed messages" report into an anomaly');
select is(pg_temp.flagged('slow_delivery'), 1::bigint, 'flags delivery p95 above 2 s');
select is(pg_temp.flagged('llm_failure_rate'), 1::bigint, 'flags an LLM error/fallback rate above 10 %');
select is((select n from found), 7, 'finds exactly the seven injected problems');
select is(public.run_checks((select id from s)), 7, 'running the checks again gives the same result');

-- The unique constraint normally makes duplicate client_msg_ids impossible.
-- Drop it inside this transaction to prove the check would catch one.
alter table public.messages drop constraint messages_client_msg_id_key;
insert into public.messages (room_id, profile_id, content, client_msg_id, created_at)
select 'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', t,
       'f0000000-0000-4000-8000-000000000001', now() - interval '30 minutes' + make_interval(secs => i)
from (values ('retry A', 0), ('retry B', 30)) as v (t, i);
select public.run_checks((select id from s));
select is(pg_temp.flagged('duplicate_message', 'same_client_msg_id'), 1::bigint,
  'flags a duplicate client_msg_id when the constraint is missing');

-- Only admins, scripts and direct connections may run checks.
select set_config('tests.session_id', (select id::text from s), true);
set local role authenticated;
set local request.jwt.claims to '{"sub":"c0000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  format('select public.run_checks(%L::uuid)', current_setting('tests.session_id')),
  '42501', 'Admins only', 'a tester cannot run checks');

select * from finish();
rollback;
