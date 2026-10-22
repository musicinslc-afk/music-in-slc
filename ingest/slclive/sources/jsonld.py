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


# ---------------------------------------------------------------------------
# Microdata (itemscope / itemprop attributes), used by 24tix and many older sites.
# Each item is converted into the same dict shape as JSON-LD so one code path handles both.
# ---------------------------------------------------------------------------
def _owner(el):
    p = el.parent
    while p is not None and not p.has_attr("itemscope"):
        p = p.parent
    return p


def _md_value(el):
    if el.has_attr("itemscope"):
        return _md_item(el)
    if el.name == "meta":
        return el.get("content")
    if el.name in ("a", "link"):
        return el.get("href")
    if el.name in ("img", "source"):
        return el.get("src")
    if el.name == "time" and el.get("datetime"):
        return el.get("datetime")
    return el.get_text(" ", strip=True)


def _md_item(scope) -> dict:
    item: dict = {"@type": (scope.get("itemtype") or "").rstrip("/").rsplit("/", 1)[-1]}
    for el in scope.find_all(attrs={"itemprop": True}):
        if _owner(el) is not scope:
            continue
        for prop in el["itemprop"].split():
            item.setdefault(prop, []).append(_md_value(el))
    return item


# Venue rules that ticket sites put in the description field; not useful as a show blurb
_POLICY = re.compile(r"no weapons|valid tickets are sold|no outside (food|beverages)|bag policy", re.I)


def _microdata_events(soup) -> list[dict]:
    events = []
    for scope in soup.find_all(attrs={"itemscope": True, "itemtype": re.compile(r"event/?$", re.I)}):
        raw = _md_item(scope)
        start = next((v for v in raw.get("startDate", []) if v), None)
        name = next((v for v in raw.get("name", []) if isinstance(v, str) and v), None)
        if not start or not name:
            continue  # sidebar teasers and lists of other shows have no start time
        locations = [v for v in raw.get("location", []) if isinstance(v, dict)]
        loc = next((v for v in locations if v.get("address")), locations[0] if locations else None)
        location = None
        if loc:
            addr = next((a for a in loc.get("address", []) if isinstance(a, dict)), {})
            location = {
                "name": next((v for v in loc.get("name", []) if isinstance(v, str) and v), None),
                "address": {"addressLocality": next(iter(addr.get("addressLocality", [])), None)},
            }
        performers = []
        for p in raw.get("performer", []):
            text = p.get("name", [""])[0] if isinstance(p, dict) else p
            performers += [s.strip() for s in re.split(r",|\s+/\s+", text or "") if s.strip()]
        if name.lower() not in (p.lower() for p in performers):
            performers.insert(0, name)
        offers = [{"price": (o.get("price") or [None])[0]} for o in raw.get("offers", []) if isinstance(o, dict)]
        ages = [a for o in raw.get("offers", []) if isinstance(o, dict) for a in o.get("typicalAgeRange", [])]
        ages += raw.get("typicalAgeRange", [])
        events.append({
            "@type": "Event",
            "name": name,
            "startDate": start,
            "doorTime": next(iter(raw.get("doorTime", [])), None),
            "location": location,
            "performer": performers,
            "offers": offers,
            "typicalAgeRange": next((a for a in ages if a), None),
            "image": next(iter(raw.get("image", [])), None),
            "url": next((u for u in raw.get("url", []) if isinstance(u, str)), None),
            "description": next((d for d in raw.get("description", [])
                                 if isinstance(d, str) and d and not _POLICY.search(d)), None),
            "eventStatus": next(iter(raw.get("eventStatus", [])), None),
        })
    return events


def parse(html: str, page_url: str, source: str, default_venue: Optional[str] = None) -> list[Show]:
    soup = BeautifulSoup(html, "html.parser")
    shows: list[Show] = []
    seen: set[tuple] = set()
    blocks = [_loads(tag.string or tag.get_text() or "")
              for tag in soup.find_all("script", type=lambda t: t and "ld+json" in t)]
    blocks.append(_microdata_events(soup))
    for data in blocks:
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
                image_url=urljoin(page_url, image) if isinstance(image, str) and image.strip() else None,
                image_kind="flyer" if isinstance(image, str) and image.strip() else None,
                source_url=urljoin(page_url, event_url) if event_url else page_url,
                cancelled="Cancelled" in status,
                source=source,
            ))
    return shows
