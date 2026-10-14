-- Just Met Her — Fantasy Survivor league schema for Supabase (Postgres)
-- Run this once in the Supabase SQL Editor after creating your project.

create extension if not exists pgcrypto;

-- One row per league member. `auth_user_id` links to a real logged-in account.
-- Historical/imported players (old-site nicknames with no real account yet) have
-- auth_user_id = null until that person signs up and an admin links them.
create table profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  name text not null,
  first_name text,
  is_commissioner boolean not null default false,
  historical boolean not null default false,
  created_at timestamptz not null default now()
);

create table castaways (
  id text primary key,
  name text not null,
  tribe text,
  photo text,
  eliminated boolean not null default false,
  eliminated_episode int
);

create table episodes (
  number int primary key,
  picks_deadline timestamptz,
  mystery_question text,
  merged boolean not null default false,
  is_finale boolean not null default false,
  locked boolean not null default false,
  results jsonb
);

create table picks (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  episode_num int not null references episodes(number) on delete cascade,
  reward text,
  immunity text,
  voted_off text,
  safe text,
  mystery text,
  mvp text,
  winner text,
  submitted_at timestamptz not null default now(),
  unique (profile_id, episode_num)
);

create table adjustments (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  episode_num int not null references episodes(number) on delete cascade,
  delta int not null,
  note text,
  created_at timestamptz not null default now()
);

-- Helper: is the currently-authenticated user the commissioner?
-- SECURITY DEFINER so this internal lookup bypasses RLS on profiles instead of
-- re-triggering it -- without this, policies on profiles that call this
-- function recurse into evaluating themselves and Postgres eventually fails
-- with "stack depth limit exceeded".
create or replace function is_commissioner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles where auth_user_id = auth.uid() and is_commissioner = true
  );
$$;

-- Helper: profile id belonging to the currently-authenticated user (or null).
-- SECURITY DEFINER for the same reason as is_commissioner() above.
create or replace function my_profile_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from profiles where auth_user_id = auth.uid();
$$;

alter table profiles enable row level security;
alter table castaways enable row level security;
alter table episodes enable row level security;
alter table picks enable row level security;
alter table adjustments enable row level security;

-- Everyone signed in can read everything (league is small and trusted).
create policy "profiles readable" on profiles for select using (auth.role() = 'authenticated');
create policy "castaways readable" on castaways for select using (auth.role() = 'authenticated');
create policy "episodes readable" on episodes for select using (auth.role() = 'authenticated');
create policy "picks readable" on picks for select using (auth.role() = 'authenticated');
create policy "adjustments readable" on adjustments for select using (auth.role() = 'authenticated');

-- Each person can create their own profile row at signup, and update it afterward.
create policy "profiles self insert" on profiles for insert
  with check (auth_user_id = auth.uid());
create policy "profiles self update" on profiles for update
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- Commissioner can edit any profile (e.g. renaming, linking a historical entry to a real account).
create policy "profiles commissioner write" on profiles for all
  using (is_commissioner()) with check (is_commissioner());

-- Only commissioner manages the roster and episode results.
create policy "castaways commissioner write" on castaways for all
  using (is_commissioner()) with check (is_commissioner());
create policy "episodes commissioner write" on episodes for all
  using (is_commissioner()) with check (is_commissioner());
create policy "adjustments commissioner write" on adjustments for all
  using (is_commissioner()) with check (is_commissioner());

-- Each player can only write their own picks.
create policy "picks self write" on picks for insert
  with check (profile_id = my_profile_id());
create policy "picks self update" on picks for update
  using (profile_id = my_profile_id()) with check (profile_id = my_profile_id());

-- Commissioner can also write picks (for proxy entry / corrections).
create policy "picks commissioner write" on picks for all
  using (is_commissioner()) with check (is_commissioner());
