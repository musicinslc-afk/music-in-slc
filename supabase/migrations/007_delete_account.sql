-- Self-service account deletion, used by web/delete-account.html.
-- Run once in the Supabase SQL editor. Safe to run again.
--
-- A signed-in person can delete only their own account. It removes:
--   the login (email), and through it the profile, Maybe and Going, and friend connections
--   messages and requests sent from the same email address
--   their name, email and submitter notes on shows sent from that address (the listings stay)
-- Admin accounts are refused, so the site can't lose its moderator by accident.

create or replace function delete_my_account() returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_email text;
begin
  if me is null then
    raise exception 'Sign in to delete your account.' using errcode = '42501';
  end if;
  if exists (select 1 from admins where user_id = me) then
    raise exception 'Admin accounts can''t be deleted here.' using errcode = '42501';
  end if;

  -- Match on email only once the address has been confirmed as theirs
  select lower(email) into my_email from auth.users where id = me and email_confirmed_at is not null;

  if coalesce(my_email, '') <> '' then
    delete from requests where lower(trim(email)) = my_email;
    update events set submitter_name = null, submitter_email = null, submitter_notes = null
      where lower(trim(submitter_email)) = my_email;
    update processed_emails set sender = null, subject = null where lower(trim(sender)) = my_email;
  end if;

  delete from auth.users where id = me;
end $$;

revoke execute on function delete_my_account() from public, anon;
grant execute on function delete_my_account() to authenticated;

notify pgrst, 'reload schema';
