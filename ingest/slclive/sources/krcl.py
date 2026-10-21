"""KRCL 90.9 FM community events calendar, Live Music category (krcl.org/events).

The calendar is server-rendered HTML, ten events a page. Each event has a title such as
"The Wildwoods Live at Urban Lounge", a date line ("October 20th, 2026 at 7 p.m."), a
location line (venue and street address in many formats) and a description with a ticket link.
Listings are community-submitted, so shows at venues we don't list go to the review queue."""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Iterable, Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from .. import fetch, settings
from ..models import Show
from ..normalize import TZ, Venue, clean, match_venue, parse_dt

BASE = "https://krcl.org/events/"
CATEGORY = "live-music"
MAX_PAGES = 15

_CITY_ALIASES = {"slc": "Salt Lake City", "s.l.c.": "Salt Lake City", "ssl": "South Salt Lake"}


def _when(text: str) -> Optional[datetime]:
    s = clean(text) or ""
    s = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", s)
    s = re.sub(r"\bnoon\b", "12 PM", s, flags=re.I)
    s = re.sub(r"\bmidnight\b", "12 AM", s, flags=re.I)
    s = re.sub(r"\bp\.?\s?m\.?", "PM", s, flags=re.I)
    s = re.sub(r"\ba\.?\s?m\.?", "AM", s, flags=re.I)
    s = s.replace(" at ", " ")
    return parse_dt(s)


def _city(location: str) -> Optional[str]:
    """Pull the city out of "Venue - 123 Street, Salt Lake City, UT 84102" style text."""
    for m in re.finditer(r"([A-Za-z][A-Za-z. ]*?)\s*,?\s*(?:UT|Utah)\b", location):
        words = m.group(1).strip(" .").split()
        # Try the longest trailing run of words that names a known city
        for i in range(len(words)):
            cand = " ".join(words[i:])
            low = cand.lower()
            if low in _CITY_ALIASES:
                return _CITY_ALIASES[low]
            if low in settings.SALT_LAKE_COUNTY_CITIES:
                return cand
        if words:
            # An address outside the county ("Eagle Mountain, UT") still tells us to skip it
            return " ".join(words[-2:]) if len(words) > 1 else words[0]
    return None


def _venue(location: str, title: str, venues: Iterable[Venue]) -> str:
    venues = list(venues)
    for text in (location, title):
        v = match_venue(text, venues)
        if v:
            return v.name
    # Unknown venue: keep the part before the address
    name = re.split(r"\s+-\s+|,|\s+\d", location, maxsplit=1)[0].strip()
    if not name:
        m = re.search(r"\s(?:at|@)\s+(.+)$", title)
        name = m.group(1).strip() if m else ""
    return name


def _headline(title: str) -> str:
    t = re.sub(r"^\s*KRCL\s+(?:Presents|Welcomes)\s*:?\s*", "", title, flags=re.I)
    # "The Wildwoods Live at Urban Lounge", "Gorillaz at Delta Center", "Clejan Live at 5 The DLC"
    t = re.sub(r"\s+(?:[Ll]ive\s+)?(?:at|@)\s+(?:[Tt]he\s+)?[A-Z0-9].*$", "", t)
    return t.strip(" -:") or title


def _ticket_link(block) -> Optional[str]:
    links = block.select("div.content a[href]")
    for a in links:
        around = (a.get_text(" ") + " " + (a.parent.get_text(" ") if a.parent else "")).lower()
        if any(w in around for w in ("ticket", "details", "rsvp", "register")):
            return urljoin(BASE, a["href"])
    return urljoin(BASE, links[0]["href"]) if links else None


def parse_page(html: str, venues: Iterable[Venue]) -> list[Show]:
    venues = list(venues)
    soup = BeautifulSoup(html, "html.parser")
    cutoff = datetime.now(TZ) - timedelta(days=1)
    shows = []
    for block in soup.select("div.event-content"):
        h = block.find("h2")
        when = block.find("span", class_="post-date")
        where = block.find("p", class_="post-date")
        title = clean(h.get_text(" ")) if h else None
        starts = _when(when.get_text(" ")) if when else None
        if not title or not starts or starts < cutoff:
            continue
        location = clean(where.get_text(" ")) if where else ""
        content = block.find("div", class_="content")
        desc = clean(content.get_text(" ")) if content else None
        if desc:
            desc = re.sub(r"\s*(?:Details and )?tickets?\s+here\s*\.?\s*$", "", desc, flags=re.I) or None
        ticket = _ticket_link(block)
        shows.append(Show(
            title=_headline(title),
            starts_at=starts,
            venue_name=_venue(location or "", title, venues),
            city=_city(location or ""),
            description=desc[:1500] if desc else None,
            ticket_url=ticket,
            source_url=f"{BASE}?category={CATEGORY}",
            raw_genres=[],
            source="krcl",
        ))
    return shows


def fetch_shows(venues: Iterable[Venue]) -> list[Show]:
    venues = list(venues)
    shows: list[Show] = []
    for page in range(1, MAX_PAGES + 1):
        try:
            r = fetch.get(BASE, params={"category": CATEGORY, "page": page})
        except Exception:
            if page == 1:
                raise
            break  # KRCL answers past the last page with an error
        found = parse_page(r.text, venues)
        if not found and "event-content" not in r.text:
            break
        shows.extend(found)
    return shows
