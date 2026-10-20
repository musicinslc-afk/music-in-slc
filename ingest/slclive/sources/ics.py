"""iCal (.ics) calendar feeds, from ticket sites (24tix publishes one for every show it sells)
and from WordPress or Squarespace venue calendars.

A small, forgiving reader instead of a full iCal library: real feeds often have stray blank
lines or slightly malformed headers, and all a show listing needs is a handful of fields."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from ..models import Show
from ..normalize import TZ, clean, parse_dt


def _unfold(text: str) -> list[str]:
    """Join continuation lines (RFC 5545 folds long lines with a leading space or tab)."""
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        elif raw.strip():
            lines.append(raw)
    return lines


def _unescape(value: str) -> str:
    return (value.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",")
            .replace("\\;", ";").replace("\\\\", "\\")).strip()


def _events(text: str) -> list[dict]:
    events, current = [], None
    for line in _unfold(text):
        if line.upper() == "BEGIN:VEVENT":
            current = {}
        elif line.upper() == "END:VEVENT":
            if current is not None:
                events.append(current)
            current = None
        elif current is not None and ":" in line:
            head, value = line.split(":", 1)
            name, *params = head.split(";")
            current[name.upper()] = (value, [p.upper() for p in params])
    return events


def _when(field) -> Optional[datetime]:
    if not field:
        return None
    value, params = field
    value = value.strip()
    if re.fullmatch(r"\d{8}", value):                        # all-day: no show time given
        return parse_dt(f"{value[:4]}-{value[4:6]}-{value[6:]}")
    m = re.fullmatch(r"(\d{8})T(\d{6})(Z?)", value)
    if not m:
        return parse_dt(value)
    dt = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")
    if m.group(3):
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        tzid = next((p.split("=", 1)[1] for p in params if p.startswith("TZID=")), None)
        if tzid and tzid.upper() not in ("AMERICA/DENVER", "US/MOUNTAIN", "MST7MDT"):
            try:
                from zoneinfo import ZoneInfo
                dt = dt.replace(tzinfo=ZoneInfo(tzid))
            except Exception:
                dt = dt.replace(tzinfo=TZ)
        else:
            dt = dt.replace(tzinfo=TZ)
    return dt.astimezone(TZ)


def _age(location: str) -> Optional[str]:
    if re.search(r"\b21\s*\+", location):
        return "21_plus"
    if re.search(r"\b18\s*\+", location):
        return "18_plus"
    if re.search(r"all ages", location, re.I):
        return "all_ages"
    return None


def parse(ics_text: str, source: str, default_venue: Optional[str] = None) -> list[Show]:
    cutoff = datetime.now(TZ) - timedelta(days=1)
    shows = []
    for ev in _events(ics_text):
        starts = _when(ev.get("DTSTART"))
        title = clean(_unescape(ev.get("SUMMARY", ("", []))[0]))
        if not starts or not title or starts < cutoff:
            continue
        location = clean(_unescape(ev.get("LOCATION", ("", []))[0])) or default_venue or ""
        # LOCATION is often "Venue Name, 123 Street, City, UT"; keep the venue part.
        # 24tix adds the room's age rule: "Metro Music Hall - 21+".
        venue = location.split(",")[0].strip()
        age = _age(venue)
        venue = re.sub(r"\s+-\s+(21\s*\+|18\s*\+|all ages)\s*$", "", venue, flags=re.I)
        url = _unescape(ev.get("URL", ("", []))[0]) or None
        desc = clean(_unescape(ev.get("DESCRIPTION", ("", []))[0]))
        status = ev.get("STATUS", ("", []))[0].strip().upper()
        shows.append(Show(
            title=title,
            starts_at=starts,
            venue_name=venue or default_venue or "",
            age_restriction=age,
            ticket_url=url,
            source_url=url,
            description=desc[:1500] if desc and desc != title else None,
            cancelled=status == "CANCELLED",
            source=source,
        ))
    return shows
