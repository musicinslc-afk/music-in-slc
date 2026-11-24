-- Why each show in the review queue was published or rejected, so patterns show up over time
-- (venues that need music_only, senders worth trusting, sources that get details wrong).
-- Run once in the Supabase SQL editor. Safe to run again.

alter table events add column if not exists review_reason text;
alter table events add column if not exists review_edits text[] default '{}';
alter table events add column if not exists reviewed_at timestamptz;

alter table events drop constraint if exists events_review_reason_check;
alter table events add constraint events_review_reason_check check (review_reason is null or review_reason in (
  'approved',        -- published as sent
  'approved_edited', -- published after fixing something (review_edits says what)
  'not_music',       -- sports, comedy, talks, trivia, markets...
  'outside_county',
  'duplicate',
  'wrong_details',
  'private',
  'spam',
  'other'
));

-- reviewed_at is set only by a person in the admin page; the scrapers' own filtering leaves it empty
create index if not exists events_reviewed_at_idx on events (reviewed_at) where reviewed_at is not null;
