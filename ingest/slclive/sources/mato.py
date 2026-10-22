"""Mato (ma.to), the events app many small Salt Lake bars, lounges and markets post to.

Mato's public listing pages show the next few days of events, so each run collects the
event links from the Salt Lake live-music and this-week listings, plus the pages of Mato
venues named in venues.yaml (`mato_venue:`), and reads each event page's schema.org data.
Running every six hours, the rolling window picks up events as they come within reach.

Mato also lists talks, markets, sports and workshops, so the live-music filter applies:
events from the live-music listing are kept unless they are clearly not music; from the
general listings, and from the pages of mixed-use venues (`music_only: true`), only clear
music is kept. Shows at venues not in venues.yaml wait for review."""
from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta
from typing import Callable, Iterable, Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from .. import fetch, music_filter
from ..models import Show
from ..normalize import TZ
from . import jsonld
from .venue_parsers import MONTHS

SITE = "https://ma.to"
MUSIC_LISTINGS = ["/events/salt-lake-city/anytime/live-music"]
OTHER_LISTINGS = ["/events/salt-lake-city", "/events/salt-lake-city/today", "/events/salt-lake-city/this-weekend"]
MAX_EVENT_PAGES = 120
SOURCE = "mato"


def event_links(html: str, base: str = SITE) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    links: list[str] = []
    for a in soup.find_all("a", href=True):
        href = urljoin(base, a["href"]).split("?")[0].split("#")[0]
        if re.match(r"^https://ma\.to/event/[^/]+$", href) and href not in links:
            links.append(href)
    return links


_SLUG_DATE = [
    (re.compile(r"(20\d\d)-(\d{2})-(\d{2})"), lambda m: (int(m[1]), int(m[2]), int(m[3]))),
    (re.compile(r"(\d{1,2})-([a-z]{3})[a-z]*-(20\d\d)"), lambda m: (int(m[3]), MONTHS.get(m[2], 0), int(m[1]))),
    (re.compile(r"([a-z]{3})[a-z]*-(\d{1,2})-(20\d\d)"), lambda m: (int(m[3]), MONTHS.get(m[1], 0), int(m[2]))),
]


def slug_date(url: str) -> Optional[date]:
    """The date many Mato event addresses carry ('...-24-oct-2026', '...-2026-10-24')."""
    slug = url.rsplit("/", 1)[-1].lower()
    for pattern, parts in _SLUG_DATE:
        for m in pattern.finditer(slug):
            try:
                return date(*parts(m))
            except ValueError:
                continue
    return None


def collect(venue_slugs: Iterable[str], get: Callable[[str], str]) -> dict[str, str]:
    """Event URL -> where it was found: 'music' (live-music listing), 'venue:<slug>' (a listed
    venue's Mato page) or 'general' (Salt Lake listings of every kind)."""
    found: dict[str, str] = {}
    pages = [(p, "music") for p in MUSIC_LISTINGS] + [(f"/venue/{s}", f"venue:{s}") for s in venue_slugs] \
        + [(p, "general") for p in OTHER_LISTINGS]
    for path, origin in pages:
        try:
            html = get(SITE + path)
        except Exception:
            if origin == "music":
                raise
            continue   # one dead venue page shouldn't sink the source
        for link in event_links(html):
            found.setdefault(link, origin)
    today = datetime.now(TZ).date()
    # Skip pages already past. Event addresses sometimes carry the UTC date, so allow a day.
    upcoming = {u: m for u, m in found.items() if (slug_date(u) or today) >= today - timedelta(days=1)}
    return dict(list(upcoming.items())[:MAX_EVENT_PAGES])


def fetch_shows(venue_slugs: Iterable[str], get: Optional[Callable[[str], str]] = None,
                now: Optional[datetime] = None, mixed_use: Iterable[str] = ()) -> list[Show]:
    """`mixed_use`: Mato venue slugs whose pages also carry non-music events; from those,
    only clear music is kept. Other venue pages keep everything that isn't clearly non-music."""
    mixed = set(mixed_use)
    get = get or (lambda u: fetch.get(u).text)
    cutoff = datetime.combine((now or datetime.now(TZ)).date(), time(0, 0), TZ)
    shows: list[Show] = []
    for url, origin in collect(venue_slugs, get).items():
        try:
            page = get(url)
        except Exception:
            continue
        for show in jsonld.parse(page, url, source=SOURCE):
            if show.starts_at < cutoff:
                continue
            kind = music_filter.classify(show)
            if origin == "general" and not music_filter.title_is_music(show.title):
                continue   # general listings carry markets, talks and sports: keep titles that say music
            if kind == "not_music":
                continue
            if kind == "unclear" and origin.startswith("venue:") and origin[6:] in mixed:
                continue
            music_filter.add_genre_words(show)
            show.source_url = url
            shows.append(show)
    return shows
