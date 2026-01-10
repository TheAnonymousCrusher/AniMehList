-- =========================================================
-- AniMehList — CHAT SCHEMA (updated)
-- =========================================================
-- Run this SECOND
-- =========================================================

create extension if not exists "pgcrypto";

-- =========================================================
-- Global Chat table
-- - user_id is NULLABLE for system messages (requested)
-- - system messages use is_system=true + user_id=null
-- =========================================================
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  username text not null,
  content text not null check (length(trim(content)) > 0 and length(content) <= 2000),
  is_system boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  constraint chat_user_required check (is_system or user_id is not null)
);

alter table public.chat_messages add column if not exists is_system boolean not null default false;

-- Realtime payload reliability (nice to have)
alter table public.chat_messages replica identity full;

alter table public.chat_messages enable row level security;

drop policy if exists "Anyone authenticated can read chat" on public.chat_messages;
drop policy if exists "Users can post messages" on public.chat_messages;

create policy "Anyone authenticated can read chat"
on public.chat_messages
for select
to authenticated
using (true);

-- Users can only insert THEIR messages, and cannot claim system messages
create policy "Users can post messages"
on public.chat_messages
for insert
to authenticated
with check (auth.uid() = user_id and is_system = false);

create index if not exists chat_messages_user_created_idx on public.chat_messages(user_id, created_at desc);
create index if not exists chat_messages_created_at_idx on public.chat_messages(created_at desc);

-- =========================================================
-- Chat rate-limit (5s)
-- - Skips system messages (so Susie doesn't get blocked)
-- =========================================================
drop trigger if exists chat_messages_rate_limit on public.chat_messages;
drop function if exists public.chat_enforce_rate_limit();

create or replace function public.chat_enforce_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last timestamptz;
begin
  if new.is_system then
    return new;
  end if;

  select max(created_at) into v_last
  from public.chat_messages
  where user_id = auth.uid()
    and is_system = false;

  if v_last is not null and (timezone('utc', now()) - v_last) < interval '5 seconds' then
    raise exception 'Rate limited. Please wait a few seconds.';
  end if;

  return new;
end;
$$;

create trigger chat_messages_rate_limit
before insert on public.chat_messages
for each row execute function public.chat_enforce_rate_limit();

-- =========================================================
-- Chat retention: keep latest 3000 messages
-- =========================================================
drop trigger if exists chat_messages_cap_after on public.chat_messages;
drop function if exists public.chat_cap_messages();
drop function if exists public.chat_cap_messages(integer);

create or replace function public.chat_cap_messages()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := TG_ARGV[0]::integer;
begin
  with ordered as (
    select id
    from public.chat_messages
    order by created_at desc
    offset v_limit
  )
  delete from public.chat_messages
  where id in (select id from ordered);

  return null;
end;
$$;

create trigger chat_messages_cap_after
after insert on public.chat_messages
for each statement execute function public.chat_cap_messages('3000');

-- =========================================================
-- Realtime publication
-- =========================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end$$;

-- =========================================================
-- End CHAT schema
-- =========================================================
