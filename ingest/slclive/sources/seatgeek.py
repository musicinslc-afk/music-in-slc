"""SeatGeek Platform API, a backstop for touring shows whose venue sites break or go quiet.

SeatGeek lists nearly every ticketed concert, primary or resale, so it catches what the
venue scrapers miss. It runs after every other source, so a show already listed only gains
SeatGeek as a confirming source (merging fills blanks and never replaces the venue's own
ticket link). Shows at venues not in venues.yaml wait for review.

Needs a free client ID: seatgeek.com/account/develop, saved as the SEATGEEK_CLIENT_ID secret."""
from __future__ import annotations

from datetime import datetime, timezone

from .. import fetch, settings
from ..models import Show
from ..normalize import clean, parse_dt

API = "https://api.seatgeek.com/2/events"
PER_PAGE = 100
MAX_PAGES = 15


def available() -> bool:
    return bool(settings.SEATGEEK_CLIENT_ID)


def fetch_shows() -> list[Show]:
    if not available():
        raise RuntimeError("SEATGEEK_CLIENT_ID is not set")
    shows: list[Show] = []
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    for page in range(1, MAX_PAGES + 1):
        params = {
            "client_id": settings.SEATGEEK_CLIENT_ID,
            "lat": settings.GEO_LAT, "lon": settings.GEO_LNG, "range": f"{settings.GEO_RADIUS_MILES}mi",
            "taxonomies.name": "concert",
            "datetime_utc.gte": now,
            "sort": "datetime_utc.asc",
            "per_page": PER_PAGE, "page": page,
        }
        data = fetch.get(API, params=params, check_robots=False).json()
        events = data.get("events") or []
        shows.extend(s for s in (to_show(e) for e in events) if s)
        total = (data.get("meta") or {}).get("total") or 0
        if page * PER_PAGE >= total or not events:
            break
    return shows


def to_show(e: dict) -> Show | None:
    if e.get("date_tbd") or e.get("datetime_tbd"):
        return None
    local = e.get("datetime_local") or ""
    # With the time not yet announced, use the date and the usual evening start
    starts = parse_dt(local[:10] if e.get("time_tbd") else local)
    title = clean(e.get("short_title") or e.get("title"))
    if not starts or not title:
        return None
    venue = e.get("venue") or {}
    performers = sorted(e.get("performers") or [], key=lambda p: not p.get("primary"))
    image = next((p.get("image") for p in performers if p.get("image")), None)
    return Show(
        title=title,
        starts_at=starts,
        venue_name=clean(venue.get("name")) or "",
        city=clean(venue.get("city")),
        artists=[p["name"] for p in performers if p.get("name")][:12],
        image_url=image,
        image_kind="photo" if image else None,
        ticket_url=e.get("url"),
        source_url=e.get("url"),
        source="seatgeek",
    )
