"""Coverage watchdog: notices when a venue that should have shows has none coming up.

Venues opt in with `expect_shows_within_days: N` in venues.yaml. After each scrape, any such
venue with no published show in the next N days is logged as a failed `coverage:<slug>` source,
so it turns red in Source health and appears in the weekly digest. Venues marked `seasonal`
are not flagged from October through March."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Iterable

from .normalize import TZ, Venue

OFF_SEASON_MONTHS = {10, 11, 12, 1, 2, 3}


def watched(venues: Iterable[Venue]) -> list[Venue]:
    return [v for v in venues if v.expect_shows_within_days]


def check(db, venues: Iterable[Venue], now: datetime | None = None) -> list[tuple[Venue, int, str | None]]:
    """(venue, upcoming count within its window, problem or None) for each watched venue."""
    now = now or datetime.now(TZ)
    venues = watched(venues)
    if not venues:
        return []
    horizon = max(v.expect_shows_within_days for v in venues)
    starts = [(r["venue_id"], datetime.fromisoformat(r["starts_at"]))
              for r in db.upcoming_venue_dates(now + timedelta(days=horizon)) if r.get("venue_id")]
    results = []
    for v in venues:
        until = now + timedelta(days=v.expect_shows_within_days)
        n = sum(1 for vid, s in starts if vid == v.id and s <= until)
        problem = None
        if n == 0 and not (v.seasonal and now.month in OFF_SEASON_MONTHS):
            problem = (f"No published shows in the next {v.expect_shows_within_days} days. "
                       "The venue's calendar, its source or its name matching may have changed.")
        results.append((v, n, problem))
    return results


def log(db, results) -> int:
    gaps = 0
    for v, n, problem in results:
        db.log_run(f"coverage:{v.slug}", problem is None, found=n, error=problem)
        gaps += problem is not None
    return gaps
