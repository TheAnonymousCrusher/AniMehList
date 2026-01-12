-- =========================================================
-- AniMehList — MAIN APP SCHEMA (updated)
-- =========================================================
-- Run this FIRST
-- =========================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";
create extension if not exists "pg_cron";

do $$
begin
  if not exists (select 1 from pg_type where typname = 'media_kind') then
    create type public.media_kind as enum ('SERIES', 'MOVIE');
  end if;

  if not exists (select 1 from pg_type where typname = 'entry_status') then
    create type public.entry_status as enum ('WATCHING', 'PLAN', 'REWATCH', 'WAITING', 'COMPLETED');
  end if;

  if not exists (select 1 from pg_type where typname = 'title_pref') then
    create type public.title_pref as enum ('ROMAJI','ENGLISH','NATIVE');
  end if;

  if not exists (select 1 from pg_type where typname = 'cover_source') then
    create type public.cover_source as enum ('ANILIST','JIKAN','KITSU');
  end if;
end
$$ language plpgsql;

-- =========================================================
-- Updated-at trigger function
-- =========================================================
create or replace function public.handle_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

-- =========================================================
-- Remove profanity filter (requested): drop sanitizer + triggers if exist
-- =========================================================
drop trigger if exists chat_messages_sanitize on public.chat_messages;
drop trigger if exists entries_notes_sanitize on public.entries;
drop function if exists public.chat_messages_sanitize_trigger();
drop function if exists public.entries_notes_sanitize_trigger();
drop function if exists public.sanitize_text(text);
drop table if exists public.profanity;

-- =========================================================
-- Entries table (ABSOLUTE EP REMOVED)
-- + per-entry cover_source override (nullable)
-- =========================================================
create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  title text not null check (length(trim(title)) > 0),

  title_romaji text,
  title_english text,
  title_native text,
  anilist_id integer,

  kind public.media_kind not null default 'SERIES',
  status public.entry_status not null default 'PLAN',

  season integer,
  episode integer,

  image_url text,
  cover_source public.cover_source, -- NULL => use profile default

  notes text,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  constraint season_non_negative check (season is null or season >= 0),
  constraint episode_non_negative check (episode is null or episode >= 0),
  constraint image_url_length check (image_url is null or length(image_url) <= 2048)
);

-- Back-compat: ensure new columns exist if table already existed
alter table if exists public.entries add column if not exists title_romaji text;
alter table if exists public.entries add column if not exists title_english text;
alter table if exists public.entries add column if not exists title_native text;
alter table if exists public.entries add column if not exists anilist_id integer;
alter table if exists public.entries add column if not exists cover_source public.cover_source;

-- ABSOLUTE EP: hard remove (requested)
alter table if exists public.entries drop constraint if exists abs_episode_non_negative;
alter table if exists public.entries drop constraint if exists mutually_exclusive_episode;
alter table if exists public.entries drop column if exists absolute_episode;

-- Triggers
drop trigger if exists entries_updated_at on public.entries;
create trigger entries_updated_at
before update on public.entries
for each row execute function public.handle_updated_at();

-- Indexes + RLS
create index if not exists entries_user_id_idx on public.entries(user_id);
create index if not exists entries_user_status_idx on public.entries(user_id, status);
create index if not exists entries_created_at_idx on public.entries(created_at desc);
create unique index if not exists entries_unique_title_per_user_idx on public.entries (user_id, lower(title));

-- Realtime delete payload reliability (fixes "delete doesn’t update until reload")
alter table public.entries replica identity full;

alter table public.entries enable row level security;

drop policy if exists "Users can view their own entries" on public.entries;
drop policy if exists "Users can insert their own entries" on public.entries;
drop policy if exists "Users can update their own entries" on public.entries;
drop policy if exists "Users can delete their own entries" on public.entries;

create policy "Users can view their own entries"
on public.entries
for select
using (auth.uid() = user_id);

create policy "Users can insert their own entries"
on public.entries
for insert
with check (auth.uid() = user_id);

create policy "Users can update their own entries"
on public.entries
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can delete their own entries"
on public.entries
for delete
using (auth.uid() = user_id);

-- =========================================================
-- Profiles table (title preference + cover source default)
-- =========================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username citext not null,
  title_pref public.title_pref not null default 'ROMAJI',
  cover_source public.cover_source not null default 'ANILIST',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint username_non_empty check (length(trim(username::text)) >= 3)
);

create unique index if not exists profiles_username_unique_idx on public.profiles (username);

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
before update on public.profiles
for each row execute function public.handle_updated_at();

alter table public.profiles enable row level security;

drop policy if exists "Users can view their profile" on public.profiles;
drop policy if exists "Users can insert their profile" on public.profiles;
drop policy if exists "Users can update their profile" on public.profiles;

create policy "Users can view their profile"
on public.profiles
for select
using (auth.uid() = id);

create policy "Users can insert their profile"
on public.profiles
for insert
with check (auth.uid() = id);

create policy "Users can update their profile"
on public.profiles
for update
using (auth.uid() = id)
with check (auth.uid() = id);

-- =========================================================
-- Sync Profile Function (auth.users → profiles)
-- =========================================================
create or replace function public.sync_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text;
begin
  v_username := coalesce(nullif(trim(new.raw_user_meta_data ->> 'username'), ''), split_part(new.email, '@', 1));

  if v_username is null then
    v_username := split_part(new.email, '@', 1);
  end if;

  if length(trim(v_username)) < 3 then
    v_username := 'user_' || substring(md5(new.id::text), 1, 8);
  end if;

  insert into public.profiles (id, username)
  values (new.id, v_username)
  on conflict (id) do update
    set username = excluded.username,
        updated_at = timezone('utc', now());

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists on_auth_user_updated on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.sync_profile();

create trigger on_auth_user_updated
after update on auth.users
for each row execute function public.sync_profile();

-- =========================================================
-- Email lookup by username or email (for login / forgot pw)
-- =========================================================
drop function if exists public.email_for_username(text);

create or replace function public.email_for_username(p_identifier text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  select u.email into v_email
  from auth.users u
  left join public.profiles p on p.id = u.id
  where lower(u.email) = lower(p_identifier)
     or (p.username is not null and lower(p.username::text) = lower(p_identifier))
     or lower(u.raw_user_meta_data ->> 'username') = lower(p_identifier)
  limit 1;

  return json_build_object('email', v_email);
end;
$$;

grant execute on function public.email_for_username(text) to authenticated, anon;

-- =========================================================
-- One-time fix for missing profiles (safe)
-- =========================================================
do $$
declare
  rec record;
  v_username text;
begin
  for rec in
    select u.*
    from auth.users u
    left join public.profiles p on p.id = u.id
    where p.id is null
  loop
    v_username := coalesce(nullif(trim(rec.raw_user_meta_data ->> 'username'), ''), split_part(rec.email, '@', 1));
    if length(trim(v_username)) < 3 then
      v_username := 'user_' || substring(md5(rec.id::text), 1, 8);
    end if;

    insert into public.profiles (id, username, created_at, updated_at)
    values (rec.id, v_username, rec.created_at, timezone('utc', now()))
    on conflict (id) do nothing;
  end loop;
end $$;

-- =========================================================
-- RPC: Clear all entries for current user (reliable)
-- =========================================================
drop function if exists public.delete_all_entries();

create or replace function public.delete_all_entries()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.entries where user_id = auth.uid();
end;
$$;

grant execute on function public.delete_all_entries() to authenticated;

-- =========================================================
-- Realtime publication
-- =========================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'entries'
  ) then
    alter publication supabase_realtime add table public.entries;
  end if;
end$$;

-- =========================================================
-- End MAIN APP schema
-- =========================================================
