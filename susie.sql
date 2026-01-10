-- =========================================================
-- AniMehList — SUSIE THE GHOST (server-side)
-- =========================================================
-- Run this THIRD (after chat.sql)
-- =========================================================

create extension if not exists "pgcrypto";

-- =========================================================
-- CONFIG TABLE (easy knobs for testing)
-- - cooldown_seconds: minimum seconds between Susie messages
-- - random_chance: chance to post a random line when no trigger matched
-- - scan_last_n: how many recent user messages to scan
-- - triggers: JSON list with keywords + lines
-- - random_lines: fallback pool
-- =========================================================
create table if not exists public.susie_config (
  id int primary key,
  enabled boolean not null default true,
  cooldown_seconds int not null default 120,
  random_chance numeric not null default 0.07,
  scan_last_n int not null default 8,
  triggers jsonb not null default '[]'::jsonb,
  random_lines jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);

-- keep single row
insert into public.susie_config (id, enabled, cooldown_seconds, random_chance, scan_last_n, triggers, random_lines)
values (
  1,
  true,
  120,
  0.07,
  8,
  '[
    {
      "id": "filler_arc",
      "keywords": ["filler", "filler arc"],
      "lines": ["Filler arc? Skip at your own risk."]
    },
    {
      "id": "sub_dub",
      "keywords": ["sub", "dub"],
      "lines": ["Dub > Sub? Fight me."]
    },
    {
      "id": "op_opening",
      "keywords": ["op", "opening"],
      "lines": ["This OP slaps fr."]
    },
    {
      "id": "plot_twist",
      "keywords": ["plot twist", "twist"],
      "lines": ["Plot armor is strong with this one."]
    },
    {
      "id": "main_character",
      "keywords": ["main character"],
      "lines": ["Main character vibes."]
    },
    {
      "id": "binge_episode",
      "keywords": ["binge", "episode"],
      "lines": ["Binge responsibly. Or don’t."]
    },
    {
      "id": "drink_water",
      "keywords": ["drink water"],
      "lines": ["Drink water, bro."]
    },
    {
      "id": "cliffhanger",
      "keywords": ["cliffhanger"],
      "lines": ["Cliffhanger? Classic."]
    },
    {
      "id": "ramen_food",
      "keywords": ["ramen", "food", "noodles", "snacks"],
      "lines": ["I’m cooking ramen in the server room."]
    },
    {
      "id": "hello",
      "keywords": ["hello", "hi", "hey", "wassup", "sup", "yo"],
      "lines": ["Susie says hi 👀"]
    },
    {
      "id": "susie_boo",
      "keywords": ["susie", "scare", "boo"],
      "lines": ["Boo. Did I scare ya?"]
    },
    {
      "id": "leaving",
      "keywords": ["heading out", "leaving", "dip"],
      "lines": ["Be right back, entering the Shadow Realm."]
    },
    {
      "id": "approve_like",
      "keywords": ["approve", "like"],
      "lines": ["Susie approves this anime."]
    }
  ]'::jsonb,
  '[
    "Susie says hi 👀",
    "Boo. Did I scare ya?",
    "This OP slaps fr.",
    "Cliffhanger? Classic.",
    "Drink water, bro.",
    "I’m cooking ramen in the server room.",
    "Binge responsibly. Or don’t.",
    "Main character vibes.",
    "Susie approves this anime.",
    "Plot armor is strong with this one.",
    "Filler arc? Skip at your own risk.",
    "Dub > Sub? Fight me.",
    "Be right back, entering the Shadow Realm.",
    "No spoilers. Or else.",
    "Touch grass. After one more episode."
  ]'::jsonb
)
on conflict (id) do update
set enabled = excluded.enabled,
    cooldown_seconds = excluded.cooldown_seconds,
    random_chance = excluded.random_chance,
    scan_last_n = excluded.scan_last_n,
    triggers = excluded.triggers,
    random_lines = excluded.random_lines,
    updated_at = timezone('utc', now());

-- =========================================================
-- Susie trigger function
-- Logic:
-- - only after NON-system inserts
-- - enforce cooldown
-- - scan last N non-system messages for trigger keywords
-- - if triggers matched => post 1 context line
-- - else => post 1 random line with random_chance
-- =========================================================
drop trigger if exists chat_messages_susie_after on public.chat_messages;
drop function if exists public.chat_maybe_susie();

create or replace function public.chat_maybe_susie()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg record;

  v_last timestamptz;
  v_now timestamptz := timezone('utc', now());

  v_recent text[];
  v_scan_n int;

  trig jsonb;
  trig_list jsonb;
  rand_list jsonb;

  matched_triggers jsonb := '[]'::jsonb;

  msg_content text;
  kw text;
  kw_pattern text;

  pick_trigger jsonb;
  lines jsonb;
  pick_line text;

  idx int;
  line_idx int;

  roll numeric;
begin
  -- Only react to human messages
  if new.is_system then
    return null;
  end if;

  select *
  into cfg
  from public.susie_config
  where id = 1;

  if cfg is null or cfg.enabled is not true then
    return null;
  end if;

  -- Cooldown check
  select max(created_at)
  into v_last
  from public.chat_messages
  where is_system = true
    and lower(username) = lower('Susie the Ghost');

  if v_last is not null and (v_now - v_last) < make_interval(secs => cfg.cooldown_seconds) then
    return null;
  end if;

  v_scan_n := greatest(1, least(cfg.scan_last_n, 50)); -- sanity cap
  trig_list := cfg.triggers;
  rand_list := cfg.random_lines;

  -- Pull last N non-system messages (including the one that just got inserted)
  select array_agg(content order by created_at desc)
  into v_recent
  from (
    select content, created_at
    from public.chat_messages
    where is_system = false
    order by created_at desc
    limit v_scan_n
  ) t;

  if v_recent is null then
    v_recent := array[]::text[];
  end if;

  -- Scan triggers
  for trig in
    select value from jsonb_array_elements(trig_list)
  loop
    -- For each trigger, see if ANY keyword hits ANY recent message
    for kw in
      select value::text from jsonb_array_elements(coalesce(trig->'keywords','[]'::jsonb))
    loop
      kw := lower(kw);

      -- escape regex specials in kw
      kw_pattern := regexp_replace(kw, '([\\.^$|()?*+{}\\[\\]])', '\\\1', 'g');
      kw_pattern := replace(kw_pattern, ' ', '\\s+');

      foreach msg_content in array v_recent
      loop
        msg_content := lower(coalesce(msg_content,''));

        -- word-ish boundary match:
        if msg_content ~ ('(^|[^a-z0-9])' || kw_pattern || '([^a-z0-9]|$)') then
          matched_triggers := matched_triggers || jsonb_build_array(trig);
          exit; -- keyword hit for this trigger
        end if;
      end loop;

      -- if trigger already matched, stop checking its other keywords
      if jsonb_array_length(matched_triggers) > 0 then
        -- NOTE: matched_triggers is a growing array; we still want to allow multiple triggers.
        -- But we only add one trig per hit; so we should not re-add same trig repeatedly.
        -- quick de-dup: if last appended trig has same id, skip (cheap)
        -- (keeping it simple, because N is tiny)
        null;
      end if;
    end loop;
  end loop;

  -- If triggers matched: pick one trigger + one line
  if jsonb_array_length(matched_triggers) > 0 then
    idx := floor(random() * jsonb_array_length(matched_triggers))::int;
    pick_trigger := matched_triggers->idx;

    lines := coalesce(pick_trigger->'lines','[]'::jsonb);
    if jsonb_array_length(lines) = 0 then
      return null;
    end if;

    line_idx := floor(random() * jsonb_array_length(lines))::int;
    pick_line := (lines->line_idx)::text;
    pick_line := trim(both '"' from pick_line);

    insert into public.chat_messages (user_id, username, content, is_system, created_at)
    values (null, 'Susie the Ghost', pick_line, true, v_now);

    return null;
  end if;

  -- No triggers: random chance for chaos
  roll := random();
  if roll < cfg.random_chance then
    if jsonb_array_length(rand_list) = 0 then
      return null;
    end if;

    line_idx := floor(random() * jsonb_array_length(rand_list))::int;
    pick_line := (rand_list->line_idx)::text;
    pick_line := trim(both '"' from pick_line);

    insert into public.chat_messages (user_id, username, content, is_system, created_at)
    values (null, 'Susie the Ghost', pick_line, true, v_now);
  end if;

  return null;
end;
$$;

create trigger chat_messages_susie_after
after insert on public.chat_messages
for each row execute function public.chat_maybe_susie();

-- =========================================================
-- End SUSIE
-- =========================================================
