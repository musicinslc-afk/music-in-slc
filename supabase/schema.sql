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
  image_kind      text check (image_kind in ('flyer','photo')),  -- flyers replace artist photos
  image_checked_at timestamptz,              -- when the flyer finder read the event page
  artist_url      text,                      -- headliner link offered by a submitter or email
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
    and image_url is null
    and (artist_url is null or (artist_url ~* '^https?://' and char_length(artist_url) <= 500))
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

-- ---------------------------------------------------------------------------
-- Band links, one row per artist, matched to shows by a normalized name
-- (artist_key in ingest/slclive/links.py, artistKey in web/data.js)
-- ---------------------------------------------------------------------------
create table if not exists artists (
  key        text primary key,
  name       text not null,
  homepage   text,
  links      jsonb not null default '{}',   -- {"bandcamp": url, "instagram": url, ...}
  source     text,                         -- ticketmaster, musicbrainz, email, admin
  locked     boolean not null default false, -- set by an admin; the ingest jobs leave it alone
  checked_at timestamptz,                  -- last MusicBrainz lookup, found or not
  updated_at timestamptz default now()
);

drop trigger if exists artists_touch on artists;
create trigger artists_touch before update on artists
for each row execute function touch_updated_at();

alter table artists enable row level security;
drop policy if exists artists_read on artists;
create policy artists_read on artists for select using (true);
drop policy if exists artists_admin on artists;
create policy artists_admin on artists for all using (is_admin()) with check (is_admin());

-- Flyers attached to emails are stored here and served from a public address
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('flyers', 'flyers', true, 6291456, array['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

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

-- ---------------------------------------------------------------------------
-- You: profiles, Maybe and Going, friends (same as migrations/003)
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  handle       text unique not null check (handle ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null check (char_length(display_name) between 1 and 40),
  visibility   text not null default 'friends' check (visibility in ('private', 'friends', 'public')),
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
drop trigger if exists profiles_touch on profiles;
create trigger profiles_touch before update on profiles
for each row execute function touch_updated_at();

create table if not exists rsvps (
  user_id    uuid not null references profiles(user_id) on delete cascade,
  event_id   uuid not null references events(id) on delete cascade,
  status     text not null check (status in ('maybe', 'going')),
  updated_at timestamptz default now(),
  primary key (user_id, event_id)
);
create index if not exists rsvps_event_idx on rsvps (event_id);

-- A friendship is two follows, one each way: adding someone sends a request, adding back accepts it.
create table if not exists follows (
  follower   uuid not null references profiles(user_id) on delete cascade,
  followee   uuid not null references profiles(user_id) on delete cascade,
  created_at timestamptz default now(),
  primary key (follower, followee),
  check (follower <> followee)
);
create index if not exists follows_followee_idx on follows (followee);

create or replace function are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from follows where follower = a and followee = b)
     and exists (select 1 from follows where follower = b and followee = a);
$$;

create or replace function can_see_plans(owner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select owner = auth.uid() or exists (
    select 1 from profiles p
    where p.user_id = owner
      and (p.visibility = 'public'
           or (p.visibility = 'friends' and auth.uid() is not null and are_friends(owner, auth.uid())))
  );
$$;

alter table profiles enable row level security;
alter table rsvps enable row level security;
alter table follows enable row level security;

-- Profiles: your own, public ones, and anyone you have added or who has added you
create or replace function is_connected(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from follows f
    where (f.follower = auth.uid() and f.followee = other)
       or (f.followee = auth.uid() and f.follower = other)
  );
$$;
drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select using (
  user_id = auth.uid() or visibility = 'public' or is_connected(user_id)
);
drop policy if exists profiles_own on profiles;
create policy profiles_own on profiles for insert with check (user_id = auth.uid());
drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists profiles_delete on profiles;
create policy profiles_delete on profiles for delete using (user_id = auth.uid());

-- Plans: readable as the owner's visibility allows, written only by the owner
drop policy if exists rsvps_read on rsvps;
create policy rsvps_read on rsvps for select using (can_see_plans(user_id));
drop policy if exists rsvps_insert on rsvps;
create policy rsvps_insert on rsvps for insert with check (user_id = auth.uid());
drop policy if exists rsvps_update on rsvps;
create policy rsvps_update on rsvps for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists rsvps_delete on rsvps;
create policy rsvps_delete on rsvps for delete using (user_id = auth.uid());

-- Follows: you see the ones you're part of, add your own, and can remove either direction
drop policy if exists follows_read on follows;
create policy follows_read on follows for select using (follower = auth.uid() or followee = auth.uid());
drop policy if exists follows_insert on follows;
create policy follows_insert on follows for insert with check (follower = auth.uid());
drop policy if exists follows_delete on follows;
create policy follows_delete on follows for delete using (follower = auth.uid() or followee = auth.uid());

-- Totals for every upcoming show, without names
create or replace function rsvp_counts(since timestamptz default now() - interval '6 hours')
returns table (event_id uuid, going int, maybe int)
language sql stable security definer set search_path = public as $$
  select r.event_id,
         (count(*) filter (where r.status = 'going'))::int,
         (count(*) filter (where r.status = 'maybe'))::int
  from rsvps r join events e on e.id = r.event_id
  where e.starts_at >= since and e.status in ('published', 'cancelled')
  group by r.event_id;
$$;

-- A shared profile link (?u=handle) needs the name even before you're friends
create or replace function profile_by_handle(h text)
returns table (user_id uuid, handle text, display_name text, visibility text)
language sql stable security definer set search_path = public as $$
  select p.user_id, p.handle, p.display_name, p.visibility from profiles p where p.handle = lower(h);
$$;

grant select, insert, update, delete on profiles, rsvps, follows to authenticated;
grant select on profiles, rsvps to anon;
grant execute on function rsvp_counts(timestamptz) to anon, authenticated;
grant execute on function profile_by_handle(text) to anon, authenticated;
