"""Parsers for venue calendars with a known, stable layout. They read the page directly, so
there is no AI cost and every listed show is captured. A venue uses one by setting `parser:`
in venues.yaml; if the parser finds nothing (the site was redesigned), the usual JSON-LD,
iCal and AI steps run instead and Source health shows which method was used."""
from __future__ import annotations

import re
from dataclasses import replace
from datetime import date, datetime, time
from typing import Callable, Optional
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, Tag

from ..models import Show
from ..normalize import TZ, clean

MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def next_date(month: int, day: int, today: Optional[date] = None) -> Optional[date]:
    """Listings without a year: the next occurrence, allowing shows from the last few days."""
    today = today or datetime.now(TZ).date()
    for year in (today.year, today.year + 1):
        try:
            d = date(year, month, day)
        except ValueError:
            return None
        if (d - today).days >= -7:
            return d
    return None


def parse_clock(text: str) -> Optional[time]:
    m = re.search(r"(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m", text or "", re.I)
    if not m:
        return None
    hour = int(m.group(1)) % 12 + (12 if m.group(3).lower() == "p" else 0)
    return time(hour, int(m.group(2) or 0))


def _text(el: Optional[Tag]) -> str:
    return clean(el.get_text(" ")) or "" if el else ""


def _artist_list(text: str) -> list[str]:
    """'FEBUARY, KNUMEARS, SOAP BOX DERBY' or 'WITH SPECIAL GUESTS: A & B' into names."""
    text = re.sub(r"^\s*(with\s+)?(special\s+guests?|support|w/)\s*:?\s*", "", text or "", flags=re.I)
    parts = [p.strip() for p in re.split(r",|\s+&\s+|\s+and\s+", text) if p.strip()]
    return [p.title() if p.isupper() else p for p in parts]


_NOT_FLYER = re.compile(r"logo|icon|favicon|placeholder|default|spacer|pixel|\.svg(\?|$)", re.I)


def card_image(el: Optional[Tag], base: str) -> Optional[str]:
    """The first real image in a listing card: src, a lazy-load attribute, or the first srcset entry."""
    if el is None:
        return None
    for img in el.select("img"):
        src = img.get("data-src") or img.get("data-lazy-src") or img.get("src") or ""
        if not src and img.get("srcset"):
            src = img["srcset"].split(",")[0].split()[0]
        src = src.strip()
        if src and not src.startswith("data:") and not _NOT_FLYER.search(src):
            return urljoin(base, src)
    return None


def billed_headliner(title: str) -> str:
    """The headlining act in a marketing title, so the show merges with ticket-site listings:
    'Shwayze – The Nostalgia Tour', 'Amtrac (Live Set)', 'Medium Build Presents The King of
    Having Fun on Tour', 'Raynes and David Wimbish & The Collection', 'Yheti b2b Toadface'."""
    t = re.sub(r"\s*\([^)]*\)", "", title)
    t = re.sub(r"\s*[-–—]\s*ages?\s*\d+\+?.*$", "", t, flags=re.I)
    m = re.match(r"(.+?)\s+presents?\b:?\s+", t, re.I)
    if m:
        return m.group(1).strip()
    t = re.split(r"\s*:\s+|\s+[-–—|]\s+", t, maxsplit=1)[0]
    t = re.split(r"\s+b2b\s+|\s+and\s+|\s+&\s+(?!the\b)|\s+w/\s+|\s+with\s+", t, maxsplit=1, flags=re.I)[0]
    return t.strip() or title


# ---------------------------------------------------------------------------
# Soundwell (soundwellslc.com/events/): WordPress list, one <li> per show, no year shown
# ---------------------------------------------------------------------------
def soundwell(html: str, url: str, venue_name: str, source: str, today: Optional[date] = None) -> list[Show]:
    soup = BeautifulSoup(html, "html.parser")
    shows: list[Show] = []
    for card in soup.select(".event-wrapper"):
        month = MONTHS.get(_text(card.select_one(".date.month"))[:3].lower())
        day = _text(card.select_one(".date.number"))
        name = _text(card.select_one(".event-name"))
        if not (month and day.isdigit() and name):
            continue
        if re.match(r"\s*(new venue|moved to|venue change)\b", name, re.I):
            continue   # moved to another room; that venue's own source lists it
        d = next_date(month, int(day), today)
        if not d:
            continue
        doors = parse_clock(_text(card.select_one(".event-time")))
        support_el = card.select_one("h4.event-feature")
        support = _text(support_el) if support_el and not support_el.select_one(".event-time") else ""
        link = card.select_one("a.event-link") or card.select_one("a[href]")
        ticket = urljoin(url, link["href"]) if link and link.get("href") else None
        sold_out = bool(re.match(r"\s*sold\s*out", name, re.I)) or bool(card.select_one(".sold-out"))
        title = re.sub(r"^\s*sold\s*out\s*[:!-]*\s*", "", name, flags=re.I)
        headliner = billed_headliner(title)
        flyer = card_image(card, url)
        doors_at = datetime.combine(d, doors, TZ) if doors else None
        shows.append(Show(
            title=title,
            # The page gives doors only; the listing uses that as the start time
            starts_at=doors_at or datetime.combine(d, time(19, 0), TZ),
            doors_at=doors_at,
            venue_name=venue_name,
            artists=[headliner, *_artist_list(support)],
            description="Sold out." if sold_out else None,
            ticket_url=ticket,
            image_url=flyer,
            image_kind="flyer" if flyer else None,
            source_url=url,
            source=source,
        ))
    return shows


# ---------------------------------------------------------------------------
# The Hog Wallow Pub (thehogwallow.com/music/all-upcoming-live-music/): local bands, no tickets
# ---------------------------------------------------------------------------
def hogwallow(html: str, url: str, venue_name: str, source: str, today: Optional[date] = None) -> list[Show]:
    soup = BeautifulSoup(html, "html.parser")
    base = (soup.find("base") or {}).get("href") or url
    shows: list[Show] = []
    seen: set[tuple[str, date]] = set()
    for heading in soup.select("h3 a[href*='music/live/']"):
        block = heading.find_parent("div") or heading.parent
        when = _text(block.select_one(".text-secondary.bold")) if block else ""
        m = re.search(r"([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})", when)
        if not m or m.group(1).lower() not in MONTHS:
            continue
        d = next_date(MONTHS[m.group(1).lower()], int(m.group(2)), today)
        name = _text(heading)
        href = urljoin(base, heading["href"])
        if not d or not name or (href, d) in seen:
            continue
        seen.add((href, d))
        start = parse_clock(_text(block.select_one(".text-secondary.small"))) or time(21, 0)
        genre = _text(block.select_one(".text-primary"))
        photo = card_image(block, base)
        shows.append(Show(
            title=name.title() if name.isupper() else name,
            starts_at=datetime.combine(d, start, TZ),
            venue_name=venue_name,
            raw_genres=[g.strip() for g in re.split(r",|/|\s+&\s+|\s+and\s+", genre) if g.strip()][:6],
            ticket_url=None,
            source_url=href,
            age_restriction="21_plus",
            image_url=photo,
            image_kind="photo" if photo else None,   # the pub shows a round band photo, not a flyer
            source=source,
        ))
    return shows


PARSERS: dict[str, Callable[..., list[Show]]] = {
    "soundwell": soundwell,
    "hogwallow": hogwallow,
}


# ---------------------------------------------------------------------------
# Wix Events sites (Drift Lounge and others): the event list links to /event-details/ pages,
# each carrying schema.org Event data. A recurring series lists only its next date on the list
# and its later dates under "Other dates" on the event page, so those are added too.
# ---------------------------------------------------------------------------
MAX_WIX_EVENTS = 60
_OTHER_DATE = re.compile(r"([A-Z][a-z]{2}),\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{1,2}:\d{2}\s*[AP]M)")


def wix_event_links(html: str, url: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    host = urlparse(url).netloc
    links: list[str] = []
    for a in soup.find_all("a", href=True):
        href = urljoin(url, a["href"]).split("?")[0]
        if urlparse(href).netloc == host and "/event-details/" in href and href not in links:
            links.append(href)
    return links[:MAX_WIX_EVENTS]


def other_dates(html: str, today: Optional[date] = None) -> list[datetime]:
    text = BeautifulSoup(html, "html.parser").get_text(" ")
    if "Other dates" not in text:
        return []
    section = text.split("Other dates", 1)[1][:1500]
    found = []
    for _dow, mon, day, clock in _OTHER_DATE.findall(section):
        d = next_date(MONTHS.get(mon.lower(), 0), int(day), today) if mon.lower() in MONTHS else None
        t = parse_clock(clock)
        if d and t:
            found.append(datetime.combine(d, t, TZ))
    return found


def wix_events(html: str, url: str, venue_name: str, source: str, today: Optional[date] = None,
               get: Optional[Callable[[str], str]] = None) -> list[Show]:
    from .. import fetch
    from . import jsonld
    get = get or (lambda u: fetch.get(u).text)
    shows: list[Show] = []
    seen: set[tuple[str, str]] = set()
    for link in wix_event_links(html, url):
        try:
            page = get(link)
        except Exception:
            continue   # one dead event page shouldn't sink the venue
        for show in jsonld.parse(page, link, source=source, default_venue=venue_name):
            show.venue_name = venue_name   # Wix gives the room name ("Drift Lounge at Woodbine")
            for starts in [show.starts_at, *other_dates(page, today)]:
                key = (show.title, starts.isoformat())
                if key not in seen:
                    seen.add(key)
                    shows.append(replace(show, starts_at=starts, doors_at=None,
                                         source_url=link, ticket_url=show.ticket_url or link))
    return shows


PARSERS["wix_events"] = wix_events
