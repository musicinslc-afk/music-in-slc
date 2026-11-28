-- Keep submitter details and review notes private. Run once in the Supabase SQL editor. Safe to run again.
--
-- Row-level security decides which shows a visitor can read, not which columns, so the public key
-- could read submitter names and emails on published shows. This limits the website's two roles to
-- the public columns. The admin page reads the review queue, private columns included, through a
-- function that returns rows only to admins. The scheduled jobs use the service key and are unaffected.
--
-- A column added to events later is private until it is granted here.

begin;

revoke select on events from public, anon, authenticated;
grant select (
  id, fingerprint, title, artists, venue_id, venue_name, city, starts_at, doors_at,
  price_min, price_max, is_free, age_restriction, genres, raw_genres, description,
  ticket_url, image_url, image_kind, image_checked_at, artist_url, status, source,
  source_url, sources, last_seen_at, created_at, updated_at
) on events to anon, authenticated;

create or replace function admin_review_queue() returns setof events
language sql stable security definer set search_path = public as $$
  select * from events where status = 'pending' and is_admin() order by starts_at limit 200;
$$;
revoke execute on function admin_review_queue() from public, anon;
grant execute on function admin_review_queue() to authenticated;

commit;

notify pgrst, 'reload schema';
