-- Seed data. `supabase db reset` runs this after the migrations.
-- On a hosted project, paste it into the SQL editor once (see README step 4).

-- The room. (The student's Figma calls topic rooms "chat bots".)
insert into public.rooms (id, slug, name, topic, tags, emoji, max_participants)
values (
  '3f6c2a1e-9b7d-4c58-a0e2-5d1f8b7c4e93',
  'pop-music',
  'Pop Music Bot',
  'Pop music: new releases, favourite artists, concerts, guilty-pleasure songs and what makes a chorus stick.',
  '{pop,music}',
  '🎧',
  60
)
on conflict (id) do nothing;

-- AI members get an ordinary profile, exactly like a person would.
insert into public.profiles (id, display_name, avatar) values
  ('b8e14d02-6a3f-47c1-9d55-2e0a7f3c8b61', 'Lena', 'cat'),
  ('5d9a7e3b-1c4f-4b86-8e27-c0f4a9b6d315', 'Theo', 'owl')
on conflict (id) do nothing;

-- Their personas live in bots, which testers cannot read.
insert into public.bots (
  profile_id, room_id, role, language, tags, activity_level, professionalism,
  banned_words, custom_chat_style
) values
  ('b8e14d02-6a3f-47c1-9d55-2e0a7f3c8b61', '3f6c2a1e-9b7d-4c58-a0e2-5d1f8b7c4e93',
   'host', 'en', '{pop,music,concerts}', 2, 1, '{}',
   'Warm and curious. Asks one easy question at a time and invites quieter people in. At most one emoji.'),
  ('5d9a7e3b-1c4f-4b86-8e27-c0f4a9b6d315', '3f6c2a1e-9b7d-4c58-a0e2-5d1f8b7c4e93',
   'participant', 'en', '{pop,charts,production}', 2, 2, '{}',
   'Playful music nerd who likes production details and chart trivia. Short sentences, no emoji.')
on conflict (profile_id) do nothing;

insert into public.room_members (room_id, profile_id, joined_at, welcomed_at) values
  ('3f6c2a1e-9b7d-4c58-a0e2-5d1f8b7c4e93', 'b8e14d02-6a3f-47c1-9d55-2e0a7f3c8b61', now(), now()),
  ('3f6c2a1e-9b7d-4c58-a0e2-5d1f8b7c4e93', '5d9a7e3b-1c4f-4b86-8e27-c0f4a9b6d315', now(), now())
on conflict do nothing;

-- Conversation starters: the free fallback and the second half of every welcome.
insert into public.question_bank (tags, language, text)
select v.tags, 'en', v.text
from (values
  ('{pop,music}'::text[], 'Which song have you had on repeat this week?'),
  ('{pop,music}', 'What''s a pop song you secretly love but would never admit to in public?'),
  ('{pop,music}', 'If you could see any artist live tomorrow, who would it be?'),
  ('{pop,music}', 'Which chorus gets stuck in your head the most?'),
  ('{pop,music}', 'Album person or playlist person — which one are you?'),
  ('{pop,music}', 'What was the first concert you ever went to?'),
  ('{pop,music}', 'Who''s an artist you think is underrated right now?'),
  ('{pop,music}', 'What''s a song that instantly puts you in a good mood?'),
  ('{pop,music}', 'Which comeback are you still waiting for?'),
  ('{pop,music}', 'What makes a song a "summer song" for you?'),
  ('{pop,music}', 'Lyrics or melody — which one hooks you first?'),
  ('{pop,music}', 'Which music video would you call a work of art?'),
  ('{pop,music}', 'What''s the best collab you''ve heard this year?'),
  ('{pop,music}', 'If this week had a theme song, what would it be?'),
  ('{pop,music}', 'Whose stage style would you borrow for a day?'),
  ('{pop,music}', 'Which song from your childhood still holds up?'),
  ('{pop,music}', 'K-pop, C-pop, J-pop, Western pop — where do your favourites come from?'),
  ('{pop,music}', 'What''s the most-played song in your library?'),
  ('{pop,music}', 'Which song would you pick to open a group karaoke night?'),
  ('{pop,music}', 'Bridge, drop or key change — what''s the best moment in a pop song?'),
  ('{}', 'What''s something small that made your day better recently?'),
  ('{}', 'What''s everyone up to this weekend?'),
  ('{}', 'What''s a hobby you''d pick up if you had more time?'),
  ('{}', 'What''s the best thing you''ve watched lately?'),
  ('{}', 'If you could live in any city for a year, where would you go?')
) as v (tags, text)
where not exists (select 1 from public.question_bank q where q.text = v.text);
