-- Lists of shows, venues, special events and questions sent from the submit page.
-- Single shows still go to the events table. Run once in the Supabase SQL editor. Safe to run again.

create table if not exists requests (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('show_list', 'venue', 'special_event', 'question')),
  submitter_role text not null check (submitter_role in ('artist', 'venue', 'promoter', 'fan')),
  name           text not null check (char_length(name) between 1 and 100),
  email          text not null check (char_length(email) between 3 and 254),
  subject        text not null check (char_length(subject) between 1 and 200),
  message        text check (char_length(message) <= 8000),
  details        jsonb not null default '{}' check (octet_length(details::text) <= 20000),
  status         text not null default 'open' check (status in ('open', 'done')),
  created_at     timestamptz default now()
);
create index if not exists requests_status_idx on requests (status, created_at);

-- Anyone can send one; only admins can read, close or delete them
alter table requests enable row level security;
drop policy if exists requests_public_send on requests;
create policy requests_public_send on requests for insert with check (status = 'open');
drop policy if exists requests_admin_read on requests;
create policy requests_admin_read on requests for select using (is_admin());
drop policy if exists requests_admin_update on requests;
create policy requests_admin_update on requests for update using (is_admin()) with check (is_admin());
drop policy if exists requests_admin_delete on requests;
create policy requests_admin_delete on requests for delete using (is_admin());

grant insert on requests to anon, authenticated;
grant select, update, delete on requests to authenticated;
