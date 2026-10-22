"""Ticketmaster Discovery API (free key at developer.ticketmaster.com).
Covers Live Nation and Ticketmaster venues: Delta Center, Maverik Center, the amphitheatre,
The Depot, Eccles Theater and many smaller rooms."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .. import fetch, settings
from ..links import clean_links
from ..models import Show
from ..normalize import clean, parse_dt

API = "https://app.ticketmaster.com/discovery/v2/events.json"
PAGE_SIZE = 199  # Discovery API caps page * size at 1000 results


def _window_pages():
    """Query in 60-day windows so no window exceeds the 1000-result deep-paging cap."""
    now = datetime.now(timezone.utc).replace(microsecond=0)
    for i in range(0, 12):
        start = now + timedelta(days=60 * i)
        yield start, start + timedelta(days=60)


def fetch_shows() -> list[Show]:
    if not settings.TICKETMASTER_API_KEY:
        raise RuntimeError("TICKETMASTER_API_KEY is not set")
    shows: list[Show] = []
    for start, end in _window_pages():
        page = 0
        while True:
            params = {
                "apikey": settings.TICKETMASTER_API_KEY,
                "classificationName": "music",
                "latlong": f"{settings.GEO_LAT},{settings.GEO_LNG}",
                "radius": settings.GEO_RADIUS_MILES,
                "unit": "miles",
                "size": PAGE_SIZE,
                "page": page,
                "sort": "date,asc",
                "startDateTime": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "endDateTime": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            data = fetch.get(API, params=params, check_robots=False).json()
            events = data.get("_embedded", {}).get("events", [])
            shows.extend(s for s in (_to_show(e) for e in events) if s)
            info = data.get("page", {})
            page += 1
            if page >= info.get("totalPages", 0) or (page + 1) * PAGE_SIZE > 1000:
                break
    return shows


def _to_show(e: dict) -> Show | None:
    dates = e.get("dates", {})
    start = dates.get("start", {})
    starts = parse_dt(start.get("dateTime") or start.get("localDate"))
    if not starts:
        return None
    venues = e.get("_embedded", {}).get("venues", [])
    venue = venues[0] if venues else {}
    raw_genres = []
    for c in e.get("classifications", []):
        for k in ("genre", "subGenre"):
            name = (c.get(k) or {}).get("name")
            if name and name.lower() not in ("undefined", "other"):
                raw_genres.append(name)
    prices = e.get("priceRanges") or []
    lows = [p["min"] for p in prices if p.get("min") is not None]
    highs = [p["max"] for p in prices if p.get("max") is not None]
    image = pick_image(e.get("images") or [])
    attractions = e.get("_embedded", {}).get("attractions", [])
    age = (e.get("ageRestrictions") or {})
    status = (dates.get("status") or {}).get("code", "")
    return Show(
        title=clean(e.get("name")) or "",
        starts_at=starts,
        venue_name=clean(venue.get("name")) or "",
        city=clean((venue.get("city") or {}).get("name")),
        artists=[a["name"] for a in attractions if a.get("name")],
        artist_links={a["name"]: band_links(a) for a in attractions if a.get("name") and band_links(a)},
        raw_genres=raw_genres,
        price_min=min(lows) if lows else None,
        price_max=max(highs) if highs else None,
        age_restriction="21_plus" if age.get("legalAgeEnforced") else None,
        ticket_url=e.get("url"),
        image_url=image,
        image_kind="photo" if image else None,
        source_url=e.get("url"),
        cancelled=status == "cancelled",
        source="ticketmaster",
    )


def pick_image(images: list[dict]) -> str | None:
    """A 16:9 artist photo big enough for the detail view without sending the 2048px original."""
    wide = sorted((i for i in images if i.get("url") and i.get("ratio") == "16_9"), key=lambda i: i.get("width", 0))
    big = [i for i in wide if i.get("width", 0) >= 640]
    if big:
        return big[0]["url"]
    if wide:
        return wide[-1]["url"]
    rest = sorted((i for i in images if i.get("url")), key=lambda i: -i.get("width", 0))
    return rest[0]["url"] if rest else None


def band_links(attraction: dict) -> dict[str, str]:
    """The performer's own pages from Ticketmaster's externalLinks: {"homepage": [{"url": ...}], ...}."""
    ext = attraction.get("externalLinks") or {}
    urls, homepage = [], None
    for kind, entries in ext.items():
        for entry in entries or []:
            url = (entry or {}).get("url")
            if not url:
                continue
            if kind == "homepage" and not homepage:
                homepage = url
            elif kind != "homepage":
                urls.append(url)
    return clean_links(urls, homepage=homepage)
