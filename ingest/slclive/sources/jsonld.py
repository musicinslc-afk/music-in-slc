"""Read schema.org Event data embedded as JSON-LD. Most ticketing widgets (Ticketweb, Etix,
SeeTickets, DICE, Eventbrite, WordPress event plugins) publish it for search engines."""
from __future__ import annotations

import json
import re
from typing import Any, Iterable, Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from ..models import Show
from ..normalize import clean, parse_dt


def _as_list(x) -> list:
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


def _walk(node: Any) -> Iterable[dict]:
    if isinstance(node, list):
        for n in node:
            yield from _walk(n)
    elif isinstance(node, dict):
        types = [str(t) for t in _as_list(node.get("@type"))]
        if any(t.endswith("Event") for t in types):
            yield node
        for key in ("@graph", "itemListElement", "item", "subEvent", "event", "events"):
            if key in node:
                yield from _walk(node[key])


def _loads(raw: str):
    raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Common breakage: trailing commas and raw newlines inside strings
        fixed = re.sub(r",\s*([}\]])", r"\1", raw).replace("\n", " ")
        try:
            return json.loads(fixed)
        except json.JSONDecodeError:
            return None


def _name(x) -> Optional[str]:
    if isinstance(x, dict):
        return clean(x.get("name"))
    return clean(x) if isinstance(x, str) else None


def _price(offers) -> tuple[Optional[float], Optional[float], Optional[str]]:
    lows, highs, url = [], [], None
    for o in _as_list(offers):
        if not isinstance(o, dict):
            continue
        url = url or o.get("url")
        for key, bucket in (("lowPrice", lows), ("price", lows), ("highPrice", highs)):
            v = o.get(key)
            try:
                if v not in (None, ""):
                    bucket.append(float(str(v).replace("$", "").replace(",", "")))
            except ValueError:
                pass
    lo = min(lows) if lows else None
    hi = max(highs + lows) if (highs or lows) else None
    return lo, hi if hi != lo else None, url


def _age(text: Optional[str]) -> Optional[str]:
    t = (text or "").lower()
    if "21" in t:
        return "21_plus"
    if "18" in t:
        return "18_plus"
    if "all" in t:
        return "all_ages"
    return None


def parse(html: str, page_url: str, source: str, default_venue: Optional[str] = None) -> list[Show]:
    soup = BeautifulSoup(html, "html.parser")
    shows: list[Show] = []
    seen: set[tuple] = set()
    for tag in soup.find_all("script", type=lambda t: t and "ld+json" in t):
        data = _loads(tag.string or tag.get_text() or "")
        if data is None:
            continue
        for ev in _walk(data):
            starts = parse_dt(ev.get("startDate"))
            title = clean(ev.get("name"))
            if not starts or not title:
                continue
            loc = (_as_list(ev.get("location")) or [None])[0]
            venue_name, city = default_venue, None
            if isinstance(loc, dict):
                venue_name = clean(loc.get("name")) or default_venue
                addr = loc.get("address")
                if isinstance(addr, dict):
                    city = clean(addr.get("addressLocality"))
            elif isinstance(loc, str):
                venue_name = clean(loc) or default_venue
            if not venue_name:
                continue
            performers = [n for n in (_name(p) for p in _as_list(ev.get("performer"))) if n]
            lo, hi, offer_url = _price(ev.get("offers"))
            image = (_as_list(ev.get("image")) or [None])[0]
            if isinstance(image, dict):
                image = image.get("url")
            status = str(ev.get("eventStatus") or "")
            raw_genres = [clean(g) for g in _as_list(ev.get("genre")) if clean(g)]
            key = (title.lower(), starts.isoformat(), (venue_name or "").lower())
            if key in seen:
                continue
            seen.add(key)
            event_url = ev.get("url")
            shows.append(Show(
                title=title,
                starts_at=starts,
                doors_at=parse_dt(ev.get("doorTime"), default_time=None),
                venue_name=venue_name,
                city=city,
                artists=performers,
                price_min=lo,
                price_max=hi,
                is_free=bool(ev.get("isAccessibleForFree")) or lo == 0,
                age_restriction=_age(ev.get("typicalAgeRange")),
                raw_genres=raw_genres,
                description=clean(ev.get("description"))[:1500] if ev.get("description") else None,
                ticket_url=urljoin(page_url, offer_url or event_url) if (offer_url or event_url) else page_url,
                image_url=urljoin(page_url, image) if isinstance(image, str) else None,
                source_url=urljoin(page_url, event_url) if event_url else page_url,
                cancelled="Cancelled" in status,
                source=source,
            ))
    return shows
