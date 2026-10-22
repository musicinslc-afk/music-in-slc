# Music in SLC

A concert calendar for every live music show in Salt Lake County.

- **Scrapes** venue calendars and the Ticketmaster feed every 6 hours, with SeatGeek as an optional backstop.
- **Reads the musicinslc@gmail.com inbox** every hour, including flyer images, and turns show announcements into listings.
- **Takes submissions** from the public through a form, with an admin review queue.
- **Shows flyers and band links**: each listing carries the show's flyer (or an artist photo) and links to the headliner's website, Bandcamp, Instagram and other pages. A show opens into a detail view with the full flyer, every act on the bill, tickets, sharing and add-to-calendar.
- **Filters** by genre, date, venue, all ages and free shows.
- **Venues page**: a directory of every venue with a picture, type, approximate capacity, address and map link, website, and its next show.
- **Watches its own coverage**: flags venues that should have shows but don't, and emails a weekly digest to the inbox.
- **Recommends** shows from Last.fm (which covers Spotify and Pandora listeners), or artists a visitor types in.
- **You**: a set-once section for taste and account, Maybe and Going on every show, and friends who can see each other's plans.

Hosting is free or nearly free: a static site on GitHub Pages, a free Supabase database, and scheduled GitHub Actions. The only metered cost is the Claude API used to read emails and venue pages that have no structured data.

## How it fits together

```
 venue websites ─┐
 Ticketmaster  ──┼─► ingest/run_scrapers.py ─┐                       ┌─► web/index.html  (calendar, filters, You)
                 │   (every 6 h)             ├─► Supabase Postgres ──┼─► web/submit.html (public form → pending)
 musicinslc     ─┴─► ingest/run_email.py ────┘    events, venues     └─► web/admin.html  (review queue, source health)
 @gmail.com          (hourly, Claude reads        source_runs
                      text + flyer images)
```

Every source produces the same show record. Each show gets a fingerprint (venue, local date, headliner), and near-matches at the same venue on the same night are merged, so a show listed by the venue, Ticketmaster and an email appears once. Scraped shows publish directly. Emailed and submitted shows wait in the review queue, unless the email comes from a sender you trust. When a scraper later confirms a pending show, it publishes automatically. A show you hide in the admin page stays hidden.

## Status

- Supabase project **musicinslc** created (organization musicinslc, free plan, East US). Project URL: `https://bamrbmxakgdhczzcprzt.supabase.co`.
- `supabase/schema.sql` has been run; all tables have row-level security on. A public visitor can read published shows but cannot publish a show directly.
- `web/config.js` has the project URL and public anon key filled in.
- GitHub repository **musicinslc-afk/music-in-slc** created (public) with all files; GitHub Pages is on and the site is live at https://musicinslc-afk.github.io/music-in-slc/.
- Repository secrets SUPABASE_URL and SUPABASE_SERVICE_KEY and variables SITE_URL and CONTACT_EMAIL are set. Supabase sign-in URLs point at the live site.
- The 24tix calendar feed supplies Kilby Court, Urban Lounge, Metro Music Hall, International Bar, The DLC and The Pearl on Main.
- The State Room Presents calendar supplies The State Room, The Commonwealth Room and Live at the Eccles shows (the shows sold on AXS, which blocks automated access itself). Eccles shows wait for review unless Ticketmaster confirms them, since that series mixes in comedy and talks.
- The KRCL 90.9 community calendar (Live Music category) adds shows at bars, breweries, churches and other rooms; shows at venues not on the list wait for review, and anything outside the county is skipped.
- Secrets TICKETMASTER_API_KEY, ANTHROPIC_API_KEY and INBOX_APP_PASSWORD are set. Ticketmaster, the inbox reader and the AI venue reader all run cleanly; the calendar held 458 upcoming published shows after the first full run.
- musicinslc@gmail.com is an admin.
- Spotify sign-in has been removed from the site; recommendations use Last.fm and typed-in artists.
- Soundwell and The Hog Wallow Pub are read with layout parsers for their full calendars; Liquid Joe's comes from its Ticketsauce event list; The Union Event Center's JavaScript calendar is read in a headless browser (its shows also come from Ticketmaster). The Great Saltair comes from Ticketmaster and is marked seasonal.
- Bars, breweries and lounges: Lake Effect (a week of nightly acts from its rendered calendar), Drift Lounge (Wix event pages), Epic Brewing (its calendar links), and weekly standing nights at Hopkins Brewing, The Green Pig Pub, The Break and Tailgate Tavern. Gracie's, HandleBar, Caputo's, Woodbine Food Hall, Melancholy, Boilerroom and SKY SLC come through Mato. Aces High Saloon is listed so KRCL, SeatGeek and emailed shows attach to it.
- Mato (ma.to), where many small rooms post, is read every run: its Salt Lake live-music listing, the general listings (titles that say music only) and the Mato pages of listed venues.
- The coverage watchdog flags any watched venue with no published show in its window, as a red `coverage:<venue>` row in Source health. The weekly digest goes to musicinslc@gmail.com on Monday mornings.
- Flyers and band links are live: `supabase/migrations/002_flyers_and_artist_links.sql` has been run. After the first run, 306 of 567 upcoming shows had an image and 222 bands had links.
- The You section (Maybe and Going, friends, visibility) is live on the site. It needs `supabase/migrations/003_you_plans_and_friends.sql` run and the sign-in redirect URL added; until then picks stay in each browser.
- Still to do: Last.fm key (genre tags and similar-artist recommendations); optional SeatGeek client ID (backstop for touring shows).

## Setup

Plan on about an hour. You need a GitHub account and the musicinslc@gmail.com login.

### 1. Database (Supabase, free)

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste all of `supabase/schema.sql`, and run it.
3. Under **Authentication → URL Configuration**, set the Site URL to your site address (step 6) so admin sign-in links land on the right page.
4. From **Project Settings → API**, copy the Project URL, the `anon` public key, and the `service_role` key. The service key is secret; it only goes into GitHub secrets.

### 2. Inbox access (musicinslc@gmail.com)

The inbox job uses IMAP with a Gmail app password. Unlike OAuth tokens for unverified apps, it doesn't expire weekly.

1. Sign in to the musicinslc Google account and turn on **2-Step Verification**.
2. Go to **Google Account → Security → App passwords**, create one named "Music in SLC", and copy the 16-character password.
3. The job reads mail from the last 14 days without marking anything read, and records each message it has handled, so nothing is processed twice.

To skip review for venues that email you regularly, set a repository variable `TRUSTED_SENDERS`, for example `booking@kilbycourt.com,@thestateroompresents.com` (a leading `@` trusts a whole domain).

### 3. API keys

| Key | Where | Used for | Required |
| --- | --- | --- | --- |
| Ticketmaster | [developer.ticketmaster.com](https://developer.ticketmaster.com) (free) | Arena, amphitheatre, Depot, Eccles and other Ticketmaster shows | Strongly recommended |
| Anthropic | [console.anthropic.com](https://console.anthropic.com) | Reading emails, flyers and venue pages without structured data | Yes, for the inbox |
| Last.fm | [last.fm/api/account/create](https://www.last.fm/api/account/create) (free) | Genre tags for shows, similar-artist recommendations, Pandora listeners | Recommended |
| SeatGeek | [seatgeek.com/account/develop](https://seatgeek.com/account/develop) (free client ID) | Backstop for touring shows when a venue's own source breaks; unknown venues wait for review | Optional |

The Claude model defaults to `claude-haiku-5-5`. Override it with an `ANTHROPIC_MODEL` secret if you like. Venue pages are only sent to Claude when their text has changed since the last run, which keeps costs low.

### 4. GitHub repository

1. Create a repository (public, so GitHub Pages and Actions are free) and push this folder to it.
2. **Settings → Secrets and variables → Actions → Secrets**: add `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TICKETMASTER_API_KEY`, `ANTHROPIC_API_KEY`, `LASTFM_API_KEY`, `INBOX_APP_PASSWORD`, and optionally `SEATGEEK_CLIENT_ID`.
3. **Variables** tab: add `SITE_URL` (your site address), `CONTACT_EMAIL` (shown to venues in the scraper's user agent), and optionally `TRUSTED_SENDERS` and `DIGEST_TO` (where the weekly digest goes; the inbox by default).
4. **Settings → Pages**: set Source to **GitHub Actions**.

### 5. Site settings

Edit `web/config.js` with the Supabase URL and anon key, plus the Last.fm key if you have one. These values are safe to publish. Commit and push; the **Publish website** workflow deploys the `web/` folder.

### 6. First run

1. **Actions → Scrape venues → Run workflow**. Then **Read musicinslc inbox → Run workflow**.
2. Open `/admin.html` on your site, enter your email, and click the sign-in link you receive.
3. Make yourself an admin by running this in the Supabase SQL editor with your email:

   ```sql
   insert into admins (user_id, email)
   select id, email from auth.users where email = 'you@example.com';
   ```

4. Reload the admin page. The **Source health** table shows which venues scraped cleanly.

### 7. Check the venue list

`ingest/config/venues.yaml` lists 48 Salt Lake County venues with their best-known calendar pages. Open each URL in a browser before launch; venue sites move often. Anything that fails shows up red in **Source health** with the error. To add a venue, copy an entry, give it a unique `slug`, and add any alternate spellings ticket sites use under `aliases` so duplicates merge.

Strategies:
- `auto` uses the venue's layout parser if it has one (`parser:`), then JSON-LD event data from the page (most ticketing widgets publish it), then links to 24tix event pages, then an iCal feed if you set `ics_url`, then falls back to Claude reading the page.
- `render` does the same on the page as a browser draws it, for calendars built with JavaScript.
- `feeds_only` doesn't scrape a page; shows come from Ticketmaster, feeds, email and submissions.
- `ticketsauce_partner:` reads a Ticketsauce seller's event list directly (Liquid Joe's).
- `mato_venue:` the venue's page slug on ma.to, read by the Mato source.
- `music_only: true` for mixed-use rooms: only events that clearly say music are kept, so drag shows, screenings, trivia and food trucks stay off the calendar.
- `recurring:` standing weekly nights for venues that post no dated calendar, listed four weeks ahead with a note to check with the venue. Each entry takes `title`, `day`, `time`, and optionally `genres`, `free`, `url` and `description`.

Venues page: each venue's `kind`, `capacity` (approximate) and `website` show on the Venues page. The picture comes from `image:` if set, else the website's preview image, the `wikipedia:` article's photo, or the first photo on the site. The **Venue directory** workflow rebuilds `web/venues.json` every Monday and whenever the venue list changes, then republishes the site.

Coverage watchdog: give a venue `expect_shows_within_days: N` and it is flagged when nothing is published in the next N days. Add `seasonal: true` for venues that go quiet October through March.

When a source misbehaves, **Actions → Diagnose sources → Run workflow** with arguments such as `--scrape soundwell`, `--db`, or `--render --url https://...` shows what the scraper sees, as annotations on the run.

Breweries, coffee shops and bars that only post on Instagram are what the inbox and the submit form are for. Ask them to email flyers to musicinslc@gmail.com.

## Flyers and band links

**Flyers.** Every source that publishes a show image keeps it: venue calendars and 24tix event pages (usually the flyer), Ticketsauce, Soundwell's listing cards, and the Hog Wallow's band photos. Ticketmaster and SeatGeek supply artist press photos, which a flyer from any other source replaces. After each scrape, the **flyers** job reads the event page of up to 60 upcoming shows that still have no image and keeps the page's preview image (`og:image`) or event-data image. Each page is read once. An image that turns up for three or more different bands is a venue logo and is ignored.

Emailed flyers: the inbox reader picks which attached image belongs to which show and stores it in the public `flyers` bucket in Supabase. An email from an untrusted sender can add a flyer to a show waiting for review but can't change the picture on a show that is already public.

The site shows a square thumbnail on each card (initials on a color tile when there's no image), a 4:3 image on the week view, and the full flyer in the detail view with a credit link to the page it came from.

**Band links.** Links live in the `artists` table, one row per band, matched to shows by a normalized name. They come from:

1. Ticketmaster's performer data (official site, Instagram, YouTube, Spotify and so on), on every scrape.
2. MusicBrainz, for performers on upcoming shows that have none. The **artist-links** job looks up 50 a run, soonest shows first. Many bands share a name, so a match is used only if the band is from Utah, or it is the only active band by that exact name and its tags fit the show's genres. Otherwise the band stays blank and is checked again in 45 days.
3. Emails: links from trusted senders are saved directly; otherwise the headliner's link waits on the show for review.
4. The submit form's optional "Headliner's website or music page" field, also checked on review.

On the admin page, each queue item has **Headliner's link** and **Flyer image link** fields, and the **Band links** section edits any band's links. A band an admin saves is locked so the jobs never change it; **Let the robots fill it in again** unlocks it.

Both jobs run automatically at the end of every calendar update: every scrape, including a single source run by hand, and every hourly inbox read (a smaller batch, which also covers shows you approved in the last hour). They report in **Source health** as `flyers` and `artist-links`; a failure there never stops the calendar update itself.

## Recommendations: what works and what doesn't

- **Typed-in artists and genres** work for everyone with no setup.
- **Last.fm** works for anyone with a public Last.fm profile. Spotify can scrobble to Last.fm natively, and Pandora listeners can scrobble with a browser extension such as Web Scrobbler. This is the realistic way to support Pandora, which has no public developer API.
- **Spotify** sign-in is not offered. Spotify limits non-commercial developer apps to a handful of allowlisted users, so Spotify listeners scrobble to Last.fm instead.

Profiles are stored only in the visitor's browser. Nothing about a visitor's listening is sent to the database.

## You: taste, plans and friends

**You** is its own page (`you.html`). It opens with the shows the visitor marked Going and Maybe, by night, with All, Going and Maybe tabs. Below that, Settings (sign-in, friends, who sees your plans, and Last.fm or typed-in artists) stays open until it has been set up once, then folds to one line with **Edit**. It is the only place the Last.fm connection appears. On the calendar, **My matches** and **My plans** filters appear once there's something to filter by.

- **Maybe and Going** buttons sit on every show card, the week view and the show detail view. Signed out, picks are kept in the browser. Signing in (an emailed link, no password) moves them to the visitor's account.
- **Who can see them** is set per person: *Friends* (the default), *Everyone*, or *Just me*. Totals such as "12 going" count everyone and never name anyone.
- **Friends** are two-way. Each person has a page at `you.html?u=<handle>`. Opening someone's page and tapping **Add friend** sends a request; they see it under You and tap **Add back**. Friends' names then show on the shows they picked.
- The rules live in the database (`supabase/migrations/003_you_plans_and_friends.sql`), so a visitor can only read plans the owner allows, whatever the page code does.

Setup: run migration 003 in the Supabase SQL editor, and under **Authentication → URL Configuration → Redirect URLs** add `https://musicinslc-afk.github.io/music-in-slc/**` so sign-in links return to the site.

## Being a good neighbor

The scraper identifies itself with your site and contact email, obeys `robots.txt`, waits two seconds between requests to the same site, and links every listing back to the venue's or seller's ticket page. If a venue asks you to stop, set its strategy to `feeds_only`. Event facts (who, where, when) are generally fine to list; don't copy long descriptions or artwork you don't have permission to use.

## Running locally

```bash
cd ingest
pip install -r requirements.txt
python -m unittest discover -s tests              # 63 tests, no network needed
DRY_RUN=1 python run_scrapers.py --only kilby-court   # print shows without writing
```

For the website, serve the `web/` folder with any static server (`python -m http.server -d web 8000`). With `supabaseUrl` blank it runs on sample listings with made-up posters and band links, so you can work on the design without a database.

## Files

```
supabase/schema.sql          tables, row-level security, admin role, health view
supabase/migrations/         changes to run on an existing database
ingest/config/venues.yaml    venues, aliases and calendar URLs
ingest/run_scrapers.py       venue pages, Ticketmaster, 24tix, State Room Presents, KRCL → database
ingest/run_email.py          musicinslc inbox → database
ingest/build_venues.py       venues.yaml → web/venues.json for the Venues page (links checked, pictures found)
ingest/run_digest.py         weekly coverage and health email to the inbox
ingest/diagnose.py           source diagnostics for the Diagnose sources workflow
ingest/slclive/              parsing, normalizing, dedupe, AI reader, Last.fm genres,
                             flyer finder (flyers.py), band links (links.py, musicbrainz.py)
web/                         the site (no build step)
web/details.js               the show detail view: flyer, band links, share, add to calendar
web/you.html, you.js         the You page: your Going and Maybe shows, then settings
web/cards.js                 show cards and nights, shared by the calendar and the You page
web/plans.js                 Maybe and Going, sign-in, friends, and people's pages (?u=handle)
web/genres.json              genre list shared by the site and the ingest jobs
.github/workflows/           schedules and deployment
```

## Keeping it running

- GitHub pauses scheduled workflows in repositories with no commits for 60 days. Commit something (a venue update counts) at least every couple of months, or re-enable the workflows when GitHub emails you.
- Supabase pauses free projects after a week without activity; the scheduled jobs keep it active.
- The weekly digest lists venues with no upcoming shows and sources that failed. A venue that keeps failing usually changed its website.
