-- The You section: profiles, Maybe and Going, and friends.
-- Run once in the Supabase SQL editor. Safe to run again.
--
-- Who can see a person's plans is set on their profile:
--   private  only them
--   friends  people they have added who have added them back
--   public   anyone, signed in or not
-- Totals ("12 going") count everyone, but never say who.

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
