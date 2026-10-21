"""The State Room Presents calendar (thestateroompresents.com), the main AXS seller in Salt Lake.

AXS itself blocks automated visitors, so its Salt Lake shows come from the promoter's own
calendar. That calendar is a Joomla DPCalendar whose month view loads its events as JSON from
index.php; we ask for the next twelve months in one request. Each event page links to AXS.

Calendars: 15 The State Room, 16 The Commonwealth Room, 17 Eccles Theater ("Live at the Eccles",
which mixes concerts with comedy and talks, so those wait for review unless Ticketmaster, which
only sends music, confirms them), 20 other rooms."""
from __future__ import annotations

import html as htmllib
import re
from datetime import datetime, timedelta
from typing import Optional
from urllib.parse import urljoin

from .. import fetch
from ..models import Show
from ..normalize import TZ, clean, parse_dt

SITE = "https://thestateroompresents.com/"
CALENDARS = {15: "The State Room", 16: "The Commonwealth Room", 17: "Eccles Theater", 20: ""}
REVIEW_CALENDARS = {17}


def _calendar_id(event: dict) -> Optional[int]:
    for c in event.get("classNames") or []:
        m = re.fullmatch(r"dp-event-calendar-(\d+)", c)
        if m:
            return int(m.group(1))
    return None


def _blurb(description: str) -> Optional[str]:
    m = re.search(r'tooltip__description">(.*?)</div>', description or "", re.S)
    if not m:
        return None
    text = re.sub(r"<[^>]+>", " ", m.group(1))
    return clean(htmllib.unescape(text))


def parse(data: dict) -> list[Show]:
    cutoff = datetime.now(TZ) - timedelta(days=1)
    shows = []
    for ev in (data.get("data") or {}).get("events") or []:
        cal = _calendar_id(ev)
        if cal not in CALENDARS:
            continue
        title = clean(htmllib.unescape(ev.get("title") or ""))
        starts = parse_dt(ev.get("start"))
        if not title or not starts or starts < cutoff:
            continue
        cancelled = bool(re.match(r"^\[?\s*(cancell?ed|canceled)\s*\]?\s*:?\s*", title, re.I))
        title = re.sub(r"^\[?\s*(cancell?ed|canceled|postponed)\s*\]?\s*:?\s*", "", title, flags=re.I)
        page = urljoin(SITE, ev.get("url") or "")
        shows.append(Show(
            title=title,
            starts_at=starts,
            venue_name=CALENDARS[cal],
            city="Salt Lake City" if cal in (15, 17) else ("South Salt Lake" if cal == 16 else None),
            description=_blurb(ev.get("description") or ""),
            ticket_url=page or None,
            source_url=page or None,
            cancelled=cancelled,
            status="pending" if cal in REVIEW_CALENDARS else "published",
            source="stateroom",
        ))
    return shows


def fetch_shows(months_ahead: int = 12) -> list[Show]:
    today = datetime.now(TZ).date()
    end = today + timedelta(days=31 * months_ahead)
    params = [("option", "com_dpcalendar"), ("view", "events"), ("format", "raw"), ("limit", "0"),
              ("list[start-date]", f"{today}T00:00:00"), ("list[end-date]", f"{end}T00:00:00")]
    params += [("filter[calendars][]", str(c)) for c in CALENDARS]
    r = fetch.get(urljoin(SITE, "index.php"), params=params)
    return parse(r.json())
