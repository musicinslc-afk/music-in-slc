-- Flyers and band links. Safe to run more than once.
-- Run in the Supabase SQL editor on an existing project; schema.sql includes the same changes.

-- Each show's image: a 'flyer' (from the venue, ticket page or an emailed flyer) or a
-- 'photo' (an artist press photo from Ticketmaster or SeatGeek). Flyers replace photos.
alter table events add column if not exists image_kind text;
alter table events drop constraint if exists events_image_kind_check;
alter table events add constraint events_image_kind_check check (image_kind in ('flyer', 'photo'));
-- When the flyer finder last looked at the show's event page, so each page is read once
alter table events add column if not exists image_checked_at timestamptz;
-- A link for the headliner offered by a submitter or an email, checked by an admin on review
alter table events add column if not exists artist_url text;

-- Band links, one row per artist, matched to shows by a normalized name (see artist_key in
-- ingest/slclive/links.py and artistKey in web/data.js)
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

-- Public submissions may offer a band link but not an image
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

-- Flyers attached to emails are stored here and served from a public address
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('flyers', 'flyers', true, 6291456, array['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
