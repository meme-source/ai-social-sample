-- Testers cannot tell who is AI, cannot read others' data, and cannot fake
-- server fields. Run with: npm run test:db   (everything is rolled back)
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

-- Arrange ─────────────────────────────────────────────────────────────────────
insert into auth.users (id, aud, role, email) values
  ('a0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ana@test.local'),
  ('a0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'bo@test.local');
insert into public.profiles (id, display_name, avatar) values
  ('a0000000-0000-4000-8000-000000000001', 'Ana', 'fox'),
  ('a0000000-0000-4000-8000-000000000002', 'Bo', 'owl');
insert into public.rooms (id, slug, name, topic) values
  ('b0000000-0000-4000-8000-000000000001', 'rls-room', 'RLS room', 'testing');

-- Act as Ana, a signed-in (anonymous) tester.
set local role authenticated;
set local request.jwt.claims to '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- Who is AI stays hidden ──────────────────────────────────────────────────────
select is_empty($$ select * from public.bots $$, 'testers cannot read AI personas (bots)');
select is_empty($$ select * from public.question_bank $$, 'testers cannot read the question bank');
select throws_ok(
  $$ select ai_lock_until from public.rooms $$,
  '42501', null, 'testers cannot read the AI lock column');
select isnt_empty($$ select id, name, topic from public.rooms $$, 'testers can list rooms by named columns');
select throws_ok(
  $$ select public.ai_try_lock('b0000000-0000-4000-8000-000000000001') $$,
  '42501', null, 'testers cannot call the AI lock functions');

-- Membership gates the conversation ───────────────────────────────────────────
select throws_ok(
  $$ insert into public.messages (room_id, profile_id, content)
     values ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'hi') $$,
  '42501', null, 'non-members cannot post');
select is(
  (public.join_room('b0000000-0000-4000-8000-000000000001') ->> 'joined')::boolean, true,
  'join_room adds a first-time member');
select is(
  (public.join_room('b0000000-0000-4000-8000-000000000001') ->> 'joined')::boolean, false,
  'join_room is idempotent');
select results_eq(
  $$ select content from public.messages where kind = 'system' $$,
  $$ values ('Ana joined') $$,
  'joining writes an "X joined" notice');
select lives_ok(
  $$ insert into public.messages (room_id, profile_id, content)
     values ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'hello') $$,
  'members can post as themselves');
select throws_ok(
  $$ insert into public.messages (room_id, profile_id, content)
     values ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'fake') $$,
  '42501', null, 'nobody can post as someone else');
select throws_ok(
  $$ insert into public.messages (room_id, profile_id, content, created_at)
     values ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'x', now() - interval '1 day') $$,
  '42501', null, 'testers cannot set the server time of a message');

-- Feedback and logs are write-only for testers ────────────────────────────────
select lives_ok(
  $$ insert into public.feedback (kind, category, note, app_version)
     values ('general', 'bug', 'button too small', '0.1.0') $$,
  'testers can send feedback');
select is_empty($$ select * from public.feedback $$, 'testers cannot read feedback (even their own)');
select throws_ok(
  $$ select public.run_checks(gen_random_uuid()) $$,
  '42501', 'Admins only', 'testers cannot run checks');

-- An admin can ────────────────────────────────────────────────────────────────
reset role;
insert into public.admins (user_id) values ('a0000000-0000-4000-8000-000000000002');
set local role authenticated;
set local request.jwt.claims to '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}';
select isnt_empty($$ select * from public.feedback $$, 'admins can read feedback');

select * from finish();
rollback;
