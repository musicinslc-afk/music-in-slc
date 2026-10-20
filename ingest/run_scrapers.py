"""Scrape every configured source and sync shows to the database.

Usage:
    python run_scrapers.py                  # all sources
    python run_scrapers.py --only kilby-court --only ticketmaster
    DRY_RUN=1 python run_scrapers.py        # print what would be stored, write nothing
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback

from slclive import enrich, settings
from slclive.db import DB
from slclive.normalize import load_venues, resolve
from slclive.sources import ticketmaster, venue_page


def store(db: DB, shows, venues, source: str, dry_run: bool) -> tuple[int, int, int]:
    found = inserted = updated = 0
    for raw in shows:
        show = resolve(raw, venues)
        if not show:
            continue
        found += 1
        enrich.fill_genres(show)
        if dry_run:
            print(json.dumps({k: v for k, v in show.to_row().items() if v not in (None, [], "")}, default=str))
            continue
        outcome = db.upsert_show(show)
        inserted += outcome == "inserted"
        updated += outcome == "updated"
    return found, inserted, updated


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", action="append", help="venue slug or 'ticketmaster' (repeatable)")
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
    if not wanted or "ticketmaster" in wanted:
        jobs.append(("ticketmaster", lambda: (ticketmaster.fetch_shows(), None, "api")))
    for v in venues:
        if v.strategy == "feeds_only" or not v.calendar_urls:
            continue
        if wanted and v.slug not in wanted:
            continue
        def job(v=v):
            res = venue_page.scrape(v, db.last_hash)
            return res.shows, res.content_hash, res.method
        jobs.append((f"venue:{v.slug}", job))

    for source, job in jobs:
        try:
            shows, content_hash, method = job()
            found, inserted, updated = store(db, shows, venues, source, dry_run)
            db.log_run(source, True, found, inserted, updated, content_hash=content_hash)
            print(f"ok   {source:38} {method:28} found={found} new={inserted} updated={updated}", file=sys.stderr)
        except Exception as e:  # one broken venue must not stop the rest
            failures += 1
            db.log_run(source, False, error=f"{type(e).__name__}: {e}")
            print(f"FAIL {source:38} {type(e).__name__}: {e}", file=sys.stderr)
            if settings.DRY_RUN:
                traceback.print_exc()

    print(f"done: {db.stats['inserted']} new, {db.stats['updated']} updated, {failures} failed sources", file=sys.stderr)
    # Fail the workflow only if everything failed, so one dead venue doesn't spam alerts
    return 1 if failures and failures == len(jobs) else 0


if __name__ == "__main__":
    sys.exit(main())
