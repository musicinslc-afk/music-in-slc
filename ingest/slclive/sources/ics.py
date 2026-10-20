"""iCal (.ics) feeds, which many WordPress and Squarespace venue calendars expose."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from ..models import Show
from ..normalize import clean, parse_dt, TZ


def parse(ics_text: str, source: str, default_venue: Optional[str] = None) -> list[Show]:
    from icalendar import Calendar  # only needed for venues with an ics_url

    cal = Calendar.from_ical(ics_text)
    cutoff = datetime.now(TZ) - timedelta(days=1)
    shows = []
    for comp in cal.walk("VEVENT"):
        dt = comp.get("DTSTART")
        starts = parse_dt(dt.dt if dt else None)
        title = clean(str(comp.get("SUMMARY") or ""))
        if not starts or not title or starts < cutoff:
            continue
        location = clean(str(comp.get("LOCATION") or "")) or default_venue
        # LOCATION is often "Venue Name, 123 Street, City, UT"; keep the venue part
        venue = location.split(",")[0].strip() if location else default_venue
        url = str(comp.get("URL")) if comp.get("URL") else None
        status = str(comp.get("STATUS") or "").upper()
        desc = clean(str(comp.get("DESCRIPTION") or ""))
        shows.append(Show(
            title=title,
            starts_at=starts,
            venue_name=venue or default_venue or "",
            ticket_url=url,
            source_url=url,
            description=desc[:1500] if desc else None,
            cancelled=status == "CANCELLED",
            source=source,
        ))
    return shows
