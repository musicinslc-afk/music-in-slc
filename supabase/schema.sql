-- SLC Live: concert calendar for Salt Lake County
-- Run this once in the Supabase SQL editor (Project > SQL Editor > New query).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Venues
-- ---------------------------------------------------------------------------
create table if not exists venues (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  name          text not null,
  address       text,
  city          text,
  lat           double precision,
  lng           double precision,
  website       text,
  age_policy    text,              -- 'all_ages', '21_plus', 'varies'
  default_genres text[] default '{}',
  aliases       text[] default '{}', -- other spellings seen in source data
  created_at    timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Events: one table for published shows, pending submissions and email finds
-- ---------------------------------------------------------------------------
create table if not exists events (
  id              uuid primary key default gen_random_uuid(),
  fingerprint     text unique not null,      -- venue + local date + headliner, for dedupe
  title           text not null,
  artists         text[] default '{}',       -- headliner first
  venue_id        uuid references venues(id) on delete set null,
  venue_name      text not null,
  city            text,
  starts_at       timestamptz not null,
  doors_at        timestamptz,
  price_min       numeric,
  price_max       numeric,
  is_free         boolean default false,
  age_restriction text,                      -- 'all_ages', '18_plus', '21_plus'
  genres          text[] default '{}',       -- normalized site genres (see web/genres.js)
  raw_genres      text[] default '{}',       -- whatever the source said
  description     text,
  ticket_url      text,
  image_url       text,
  status          text not null default 'pending'
                  check (status in ('published','pending','rejected','cancelled')),
  source          text not null,             -- 'jsonld:kilby-court', 'ticketmaster', 'email', 'submission', ...
  source_url      text,
  sources         text[] default '{}',       -- every source that has reported this show
  submitter_name  text,
  submitter_email text,
  submitter_notes text,
  review_notes    text,
  last_seen_at    timestamptz default now(),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists events_starts_at_idx on events (starts_at);
create index if not exists events_status_idx on events (status);
create index if not exists events_genres_idx on events using gin (genres);
create index if not exists events_artists_idx on events using gin (artists);

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists events_touch on events;
create trigger events_touch before update on events
for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Scraper health: one row per source per run, so broken scrapers are visible
-- ---------------------------------------------------------------------------
create table if not exists source_runs (
  id          bigserial primary key,
  source      text not null,
  ran_at      timestamptz default now(),
  ok          boolean not null,
  found       int default 0,
  inserted    int default 0,
  updated     int default 0,
  error       text,
  content_hash text               -- lets the AI page reader skip unchanged pages
);
create index if not exists source_runs_source_idx on source_runs (source, ran_at desc);

-- Emails already processed, so the inbox job never double-ingests
create table if not exists processed_emails (
  message_id  text primary key,
  subject     text,
  sender      text,
  shows_found int default 0,
  processed_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Admins: Supabase Auth users allowed to moderate
-- ---------------------------------------------------------------------------
create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email   text
);

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- The ingest jobs use the service-role key, which bypasses RLS.
-- The website uses the anon key, which is limited by these policies.
-- ---------------------------------------------------------------------------
alter table venues enable row level security;
alter table events enable row level security;
alter table source_runs enable row level security;
alter table processed_emails enable row level security;
alter table admins enable row level security;

drop policy if exists venues_read on venues;
create policy venues_read on venues for select using (true);
drop policy if exists venues_admin on venues;
create policy venues_admin on venues for all using (is_admin()) with check (is_admin());

-- Anyone can read published shows
drop policy if exists events_public_read on events;
create policy events_public_read on events for select
  using (status = 'published' or is_admin());

-- Anyone can submit a show, but only as a pending submission
drop policy if exists events_public_submit on events;
create policy events_public_submit on events for insert
  with check (
    status = 'pending'
    and source = 'submission'
    and char_length(title) between 2 and 200
    and starts_at > now() - interval '1 day'
    and starts_at < now() + interval '2 years'
  );

drop policy if exists events_admin_write on events;
create policy events_admin_write on events for update using (is_admin()) with check (is_admin());
drop policy if exists events_admin_delete on events;
create policy events_admin_delete on events for delete using (is_admin());

drop policy if exists source_runs_admin on source_runs;
create policy source_runs_admin on source_runs for select using (is_admin());

drop policy if exists admins_self on admins;
create policy admins_self on admins for select using (user_id = auth.uid());

-- Public submissions can't choose their own fingerprint collision target:
-- give them a random one so a spam insert can never overwrite a real show.
create or replace function submission_fingerprint() returns trigger language plpgsql as $$
begin
  if new.source = 'submission' then
    new.fingerprint := 'submission:' || gen_random_uuid()::text;
    new.sources := array['submission'];
  end if;
  return new;
end $$;

drop trigger if exists events_submission_fp on events;
create trigger events_submission_fp before insert on events
for each row execute function submission_fingerprint();

-- Health summary for the admin page
create or replace view source_health with (security_invoker = true) as
select distinct on (source)
  source, ran_at, ok, found, inserted, updated, error
from source_runs
order by source, ran_at desc;

-- After creating your own login (admin page > "Email me a login link"),
-- make yourself an admin by running:
--   insert into admins (user_id, email)
--   select id, email from auth.users where email = 'you@example.com';
