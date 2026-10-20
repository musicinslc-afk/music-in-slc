# Music in SLC

A concert calendar for every live music show in Salt Lake County.

- **Scrapes** venue calendars and the Ticketmaster feed every 6 hours.
- **Reads the musicinslc@gmail.com inbox** every hour, including flyer images, and turns show announcements into listings.
- **Takes submissions** from the public through a form, with an admin review queue.
- **Filters** by genre, date, venue, all ages and free shows.
- **Recommends** shows from Spotify, Last.fm (which covers Pandora), or artists a visitor types in.

Hosting is free or nearly free: a static site on GitHub Pages, a free Supabase database, and scheduled GitHub Actions. The only metered cost is the Claude API used to read emails and venue pages that have no structured data.

## How it fits together

```
 venue websites ─┐
 Ticketmaster  ──┼─► ingest/run_scrapers.py ─┐                       ┌─► web/index.html  (calendar, filters, For you)
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
- Secrets TICKETMASTER_API_KEY, ANTHROPIC_API_KEY and INBOX_APP_PASSWORD are set. Ticketmaster, the inbox reader and the AI venue reader all run cleanly; the calendar held 458 upcoming published shows after the first full run.
- musicinslc@gmail.com is an admin.
- Still to do: Last.fm key (genre tags and similar-artist recommendations), optional Spotify client ID, and venue entries for Kingsbury Hall, Sandy Amphitheater, Rice-Eccles Stadium, Capitol Theatre and Granary Live.

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
| Spotify | [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) | "Connect Spotify" button | Optional, see limits below |

The Claude model defaults to `claude-haiku-5-5`. Override it with an `ANTHROPIC_MODEL` secret if you like. Venue pages are only sent to Claude when their text has changed since the last run, which keeps costs low.

### 4. GitHub repository

1. Create a repository (public, so GitHub Pages and Actions are free) and push this folder to it.
2. **Settings → Secrets and variables → Actions → Secrets**: add `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TICKETMASTER_API_KEY`, `ANTHROPIC_API_KEY`, `LASTFM_API_KEY`, `INBOX_APP_PASSWORD`.
3. **Variables** tab: add `SITE_URL` (your site address), `CONTACT_EMAIL` (shown to venues in the scraper's user agent), and optionally `TRUSTED_SENDERS`.
4. **Settings → Pages**: set Source to **GitHub Actions**.

### 5. Site settings

Edit `web/config.js` with the Supabase URL and anon key, plus the Spotify client ID and Last.fm key if you have them. These values are safe to publish. Commit and push; the **Publish website** workflow deploys the `web/` folder.

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

`ingest/config/venues.yaml` lists 24 Salt Lake County venues with their best-known calendar pages. Open each URL in a browser before launch; venue sites move often. Anything that fails shows up red in **Source health** with the error. To add a venue, copy an entry, give it a unique `slug`, and add any alternate spellings ticket sites use under `aliases` so duplicates merge.

Strategies:
- `auto` reads JSON-LD event data from the page (most ticketing widgets publish it), then an iCal feed if you set `ics_url`, then falls back to Claude reading the page.
- `feeds_only` doesn't scrape a page; shows come from Ticketmaster, email and submissions.

Breweries, coffee shops and bars that only post on Instagram are what the inbox and the submit form are for. Ask them to email flyers to musicinslc@gmail.com.

## Recommendations: what works and what doesn't

- **Typed-in artists and genres** work for everyone with no setup.
- **Last.fm** works for anyone with a public Last.fm profile. Spotify can scrobble to Last.fm natively, and Pandora listeners can scrobble with a browser extension such as Web Scrobbler. This is the realistic way to support Pandora, which has no public developer API.
- **Spotify** sign-in works only for a few people. In 2026 Spotify limited non-commercial developer apps to a short allowlist of users (around five), and the app owner needs Spotify Premium. Wider access requires an organization with roughly 250,000 monthly users. Add yourself and a few friends under **User Management** in the Spotify dashboard, and add both `https://your-site/` and `https://your-site/index.html` as Redirect URIs. Everyone else should use Last.fm or type their favorites. Spotify also removed its related-artists and recommendations endpoints, so similar-artist matching comes from Last.fm.

Profiles are stored only in the visitor's browser. Nothing about a visitor's listening is sent to the database.

## Being a good neighbor

The scraper identifies itself with your site and contact email, obeys `robots.txt`, waits two seconds between requests to the same site, and links every listing back to the venue's or seller's ticket page. If a venue asks you to stop, set its strategy to `feeds_only`. Event facts (who, where, when) are generally fine to list; don't copy long descriptions or artwork you don't have permission to use.

## Running locally

```bash
cd ingest
pip install -r requirements.txt
python -m unittest discover -s tests              # 25 tests, no network needed
DRY_RUN=1 python run_scrapers.py --only kilby-court   # print shows without writing
```

For the website, serve the `web/` folder with any static server (`python -m http.server -d web 8000`). With `supabaseUrl` blank it runs on sample listings, so you can work on the design without a database.

## Files

```
supabase/schema.sql          tables, row-level security, admin role, health view
ingest/config/venues.yaml    venues, aliases and calendar URLs
ingest/run_scrapers.py       venue pages + Ticketmaster → database
ingest/run_email.py          musicinslc inbox → database
ingest/slclive/              parsing, normalizing, dedupe, AI reader, Last.fm genres
web/                         the site (no build step)
web/genres.json              genre list shared by the site and the ingest jobs
.github/workflows/           schedules and deployment
```

## Keeping it running

- GitHub pauses scheduled workflows in repositories with no commits for 60 days. Commit something (a venue update counts) at least every couple of months, or re-enable the workflows when GitHub emails you.
- Supabase pauses free projects after a week without activity; the scheduled jobs keep it active.
- Check **Source health** weekly. A venue that keeps failing usually changed its website.
