"""Flyers and band links, run after every calendar update: each scrape (every 6 hours, or a
single source run by hand) and each inbox read (hourly). The hourly pass also picks up shows
an admin approved since the last run. Each job reports to Source health as 'flyers' and
'artist-links'."""
from __future__ import annotations

import re
import sys

from . import flyers, musicbrainz

JOBS = (
    ("flyers", flyers.backfill, "event pages read={} flyers found={}"),
    ("artist-links", musicbrainz.enrich_upcoming, "artists looked up={} with links={}"),
)


def run(db, *, flyer_limit: int = flyers.MAX_PAGES_PER_RUN,
        link_limit: int = musicbrainz.MAX_LOOKUPS_PER_RUN) -> None:
    if db.dry_run:
        return
    limits = {"flyers": flyer_limit, "artist-links": link_limit}
    for name, task, label in JOBS:
        try:
            checked, hits = task(db, limit=limits[name])
            db.log_run(name, True, found=checked, inserted=hits)
            print(f"ok   {name:38} {label.format(checked, hits)}", file=sys.stderr)
        except Exception as e:  # never let enrichment fail the calendar update itself
            msg = re.sub(r"\?\S*", "?…", f"{type(e).__name__}: {e}")
            db.log_run(name, False, error=msg)
            print(f"FAIL {name:38} {msg}", file=sys.stderr)
