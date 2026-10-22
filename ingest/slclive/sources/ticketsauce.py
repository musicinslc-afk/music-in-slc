"""Ticketsauce, the ticketing platform behind Liquid Joe's (and other small rooms).

A venue's calendar widget loads every upcoming event as JSON from one public endpoint, keyed by
the seller's partner ID. Set `ticketsauce_partner:` on a venue in venues.yaml to use it; the ID
appears in the widget's request to events.ticketsauce.com/events/events_by_organization/<ID>/...

Events the seller files under a topic other than Concert (theme nights, parties) wait for review."""
from __future__ import annotations

from .. import fetch
from ..models import Show
from ..normalize import clean, parse_dt

API = "https://events.ticketsauce.com/events/events_by_organization/{}/0/0/0/0/false/false/true/true/0"


def parse(data: dict, venue_name: str, source: str) -> list[Show]:
    shows: list[Show] = []
    items = data.get("data") or {}
    for item in (items.values() if isinstance(items, dict) else items):
        e = item.get("Event") or {}
        if e.get("online_only") or e.get("is_dateless") or e.get("password_protected"):
            continue
        starts = parse_dt(e.get("start"))
        title = clean(e.get("name"))
        if not starts or not title:
            continue
        topic = ((item.get("EventTopic") or {}).get("name") or "").lower()
        url = e.get("url")
        image = (item.get("Logo") or {}).get("url") or e.get("thumb_url")
        shows.append(Show(
            title=title,
            starts_at=starts,
            venue_name=clean(e.get("location")) or venue_name,
            city=clean(e.get("city")),
            ticket_url=f"{url}/tickets" if url else None,
            source_url=url,
            image_url=image,
            image_kind="flyer" if image else None,
            status="published" if topic in ("", "concert", "music", "festival") else "pending",
            source=source,
        ))
    return shows


def fetch_shows(partner_id: str, venue_name: str, source: str) -> list[Show]:
    r = fetch.get(API.format(partner_id))
    return parse(r.json(), venue_name, source)
