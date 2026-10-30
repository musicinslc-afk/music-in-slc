"""Scrape every configured source and sync shows to the database.

Usage:
    python run_scrapers.py                  # all sources
    python run_scrapers.py --only kilby-court --only ticketmaster --only stateroom --only krcl --only seatgeek
    DRY_RUN=1 python run_scrapers.py        # print what would be stored, write nothing
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import traceback
from collections import defaultdict
from datetime import datetime

from slclive import coverage, enrich, flyers, listing_extras, settings
from slclive.db import DB
from slclive import fetch
from slclive.links import artist_key
from slclive.normalize import TZ, load_feeds, load_venues, resolve
from slclive.sources import ics, krcl, mato, seatgeek, stateroom, ticketmaster, venue_page


def drop_shared_images(shows) -> None:
    """A source that gives the same image to several different bands is sending its logo."""
    bands = defaultdict(set)
    for s in shows:
        if s.image_url:
            bands[s.image_url].add(artist_key((s.artists or [s.title])[0]))
    for s in shows:
        if s.image_url and len(bands[s.image_url]) >= flyers.SHARED_IMAGE_LIMIT:
            s.image_url = s.image_kind = None


def store(db: DB, shows, venues, source: str, dry_run: bool, review_unknown_venues: bool = False) -> tuple[int, int, int]:
    found = inserted = updated = 0
    shows = list(shows)
    drop_shared_images(shows)
    for raw in shows:
        show = resolve(raw, venues)
        if not show:
            continue
        if review_unknown_venues and not show.venue_slug:
            show.status = "pending"  # a venue we don't list yet, possibly outside the county
        found += 1
        enrich.fill_genres(show)
        for name, links in show.artist_links.items():
            if not dry_run:
                db.save_artist(name, links, source.split(":")[0])
        if dry_run:
            print(json.dumps({k: v for k, v in show.to_row().items() if v not in (None, [], "")}, default=str))
            continue
        outcome = db.upsert_show(show)
        inserted += outcome == "inserted"
        updated += outcome == "updated"
    return found, inserted, updated


COMPLETE_METHODS = ("parser:", "ticketsauce", "weekly schedule")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", action="append",
                    help="venue slug, feed name, 'ticketmaster', 'stateroom', 'krcl', 'mato' or 'seatgeek' (repeatable); "
                         "flyers and band links always run afterwards")
    args = ap.parse_args()

    db = DB()
    dry_run = db.dry_run
    if dry_run:
        print("DRY RUN: nothing will be written", file=sys.stderr)
    venues = list(load_venues())
    db.sync_venues(venues)
    wanted = set(args.only or [])
    failures = 0

    jobs = []
    review = set()
    if not wanted or "ticketmaster" in wanted:
        jobs.append(("ticketmaster", lambda: (ticketmaster.fetch_shows(), None, "api")))
    if not wanted or "stateroom" in wanted:
        # The State Room Presents calendar: State Room, Commonwealth Room and Eccles shows sold on AXS
        jobs.append(("stateroom", lambda: (stateroom.fetch_shows(), None, "promoter calendar (AXS)")))
        review.add("stateroom")
    if not wanted or "mato" in wanted:
        # Mato: small bars, lounges and markets; unknown venues and unclear events wait for review
        slugs = [v.mato_venue for v in venues if v.mato_venue]
        mixed = [v.mato_venue for v in venues if v.mato_venue and v.music_only]
        jobs.append(("mato", lambda: (mato.fetch_shows(slugs, mixed_use=mixed), None, "Mato listings")))
        review.add("mato")
    if not wanted or "krcl" in wanted:
        jobs.append(("krcl", lambda: (krcl.fetch_shows(venues), None, "KRCL live music calendar")))
        review.add("krcl")
    for feed in load_feeds():
        name = f"feed:{feed['name']}"
        if wanted and feed["name"] not in wanted and name not in wanted:
            continue
        def feed_job(feed=feed, name=name):
            return ics.parse(fetch.get(feed["url"]).text, source=name), None, "calendar feed"
        jobs.append((name, feed_job))
        review.add(name)
    for v in venues:
        if not v.recurring and (v.strategy == "feeds_only" or not v.calendar_urls):
            continue
        if wanted and v.slug not in wanted:
            continue
        def job(v=v):
            res = venue_page.scrape(v, db.last_hash)
            return res.shows, res.content_hash, res.method
        jobs.append((f"venue:{v.slug}", job))
    # Backstop last, so shows the venues and primary sellers already listed only gain a confirmation
    if (not wanted or "seatgeek" in wanted) and seatgeek.available():
        jobs.append(("seatgeek", lambda: (seatgeek.fetch_shows(), None, "api (backstop)")))
        review.add("seatgeek")

    for source, job in jobs:
        try:
            started = datetime.now(TZ)
            shows, content_hash, method = job()
            found, inserted, updated = store(db, shows, venues, source, dry_run, source in review)
            # A parser or Ticketsauce read is the venue's complete list, so shows only this source
            # reported that it no longer lists (removed, or superseded duplicates) are removed
            retired = db.retire_unseen(source, started) if found and method.startswith(COMPLETE_METHODS) else 0
            db.log_run(source, True, found, inserted, updated, content_hash=content_hash)
            print(f"ok   {source:38} {method:28} found={found} new={inserted} updated={updated}"
                  + (f" removed={retired}" if retired else ""), file=sys.stderr)
        except Exception as e:  # one broken venue must not stop the rest
            failures += 1
            # Strip query strings so API keys in request URLs never reach the database or logs
            msg = re.sub(r"\?\S*", "?…", f"{type(e).__name__}: {e}")
            db.log_run(source, False, error=msg)
            print(f"FAIL {source:38} {msg}", file=sys.stderr)
            if settings.DRY_RUN:
                traceback.print_exc()

    # Listings stored twice for one show (sources that order the bill differently) become one
    try:
        merged = db.merge_duplicates(venues)
        if merged:
            print(f"ok   {'duplicates':38} merged={merged}", file=sys.stderr)
    except Exception as e:
        print(f"FAIL {'duplicates':38} {type(e).__name__}: {e}", file=sys.stderr)

    # Every update ends by finding flyers and band links for anything new
    listing_extras.run(db)

    gaps = 0
    if not dry_run and not wanted:
        try:
            gaps = coverage.log(db, coverage.check(db, venues))
        except Exception as e:
            print(f"FAIL coverage check: {type(e).__name__}: {e}", file=sys.stderr)
    print(f"done: {db.stats['inserted']} new, {db.stats['updated']} updated, {failures} failed sources, "
          f"{gaps} venues with no upcoming shows", file=sys.stderr)
    # Fail the workflow only if everything failed, so one dead venue doesn't spam alerts
    return 1 if failures and failures == len(jobs) else 0


if __name__ == "__main__":
    sys.exit(main())
