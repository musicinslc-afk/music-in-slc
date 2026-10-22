"""Band links from MusicBrainz, the open music encyclopedia (no key needed; one request per
second, and a contact address in the user agent, both of which fetch.py already does).

Many bands share a name, so a match is accepted only with corroboration:
  - the artist is from Utah, or
  - it is the only active artist with exactly that name and its MusicBrainz tags fit the show's genres.
Anything less certain is left blank rather than linking the wrong band."""
from __future__ import annotations

import re
from datetime import datetime
from typing import Iterable, Optional

from . import fetch
from .genres import map_genres
from .links import artist_key, clean_links
from .normalize import TZ, parse_dt

API = "https://musicbrainz.org/ws/2/"
MIN_SCORE = 90

UTAH_PLACES = {
    "utah", "salt lake city", "salt lake county", "provo", "orem", "ogden", "logan", "st. george",
    "saint george", "west valley city", "murray", "sandy", "layton", "lehi", "bountiful",
    "south salt lake", "millcreek", "draper", "west jordan", "south jordan", "taylorsville",
    "holladay", "cottonwood heights", "midvale", "herriman", "riverton", "park city", "springville",
    "american fork", "pleasant grove", "kaysville", "farmington", "cedar city", "moab", "magna", "kearns",
}

# Relationship types MusicBrainz uses for official pages
_OFFICIAL_TYPES = {"official homepage", "bandcamp", "soundcloud", "social network", "youtube",
                   "video channel", "free streaming", "streaming", "myspace", "purchase for download"}


def _quote(name: str) -> str:
    return re.sub(r'([+\-&|!(){}\[\]^"~*?:\\/])', r"\\\1", name)


def _area_names(a: dict) -> set[str]:
    return {(a.get(k) or {}).get("name", "").lower() for k in ("area", "begin-area")} - {""}


def pick(candidates: list[dict], name: str, show_genres: Iterable[str]) -> Optional[dict]:
    """The candidate to trust for `name`, or None. `candidates` are MusicBrainz search results."""
    key = artist_key(name)
    exact = [a for a in candidates
             if int(a.get("score") or 0) >= MIN_SCORE
             and (artist_key(a.get("name")) == key
                  or any(artist_key(al.get("name")) == key for al in a.get("aliases") or []))
             and not (a.get("life-span") or {}).get("ended")]
    utah = [a for a in exact if _area_names(a) & UTAH_PLACES]
    if len(utah) == 1:
        return utah[0]
    if len(exact) != 1:
        return None
    wanted = set(show_genres) - {"local", "tribute"}
    tags = [t.get("name", "") for t in sorted(exact[0].get("tags") or [], key=lambda t: -int(t.get("count") or 0))]
    return exact[0] if wanted and wanted & set(map_genres(tags, limit=6)) else None


def links_for(mbid: str) -> dict[str, str]:
    data = fetch.get(f"{API}artist/{mbid}", params={"inc": "url-rels", "fmt": "json"}, check_robots=False).json()
    urls, homepage = [], None
    for rel in data.get("relations") or []:
        if rel.get("ended") or rel.get("type") not in _OFFICIAL_TYPES:
            continue
        url = (rel.get("url") or {}).get("resource")
        if rel.get("type") == "official homepage" and not homepage:
            homepage = url
        elif url:
            urls.append(url)
    return clean_links(urls, homepage=homepage)


def lookup(name: str, show_genres: Iterable[str]) -> Optional[dict[str, str]]:
    """Band links for `name`, {} when MusicBrainz has a match without links, None when there
    is no match we trust."""
    data = fetch.get(f"{API}artist/", check_robots=False, params={
        "query": f'artist:"{_quote(name)}"', "fmt": "json", "limit": 10}).json()
    match = pick(data.get("artists") or [], name, show_genres)
    if not match:
        return None
    return links_for(match["id"])


MAX_LOOKUPS_PER_RUN = 50
RECHECK_DAYS = 45


def needs_lookup(row: Optional[dict], now) -> bool:
    if not row:
        return True
    if row.get("locked") or row.get("homepage") or row.get("links"):
        return False
    checked = row.get("checked_at")
    if not checked:
        return True
    when = parse_dt(checked, default_time=None)
    return not when or (now - when).days >= RECHECK_DAYS


def enrich_upcoming(db, limit: int = MAX_LOOKUPS_PER_RUN) -> tuple[int, int]:
    """Look up band links for performers on upcoming published shows, soonest first.
    Returns (artists looked up, artists with links found)."""
    now = datetime.now(TZ)
    shows = []
    for row in db._load_existing().values():
        starts = parse_dt(row.get("starts_at"), default_time=None)
        if row.get("status") == "published" and starts and starts >= now:
            shows.append((starts, row))
    shows.sort(key=lambda x: x[0])
    known = db.artists()
    queue: dict[str, tuple[str, list[str]]] = {}
    for _, row in shows:
        for name in (row.get("artists") or [row.get("title")])[:3]:
            key = artist_key(name)
            if key and len(key) >= 3 and key not in queue and needs_lookup(known.get(key), now):
                queue[key] = (name, row.get("genres") or [])
    looked = hits = 0
    for name, genres in list(queue.values())[:limit]:
        try:
            links = lookup(name, genres)
        except Exception:
            continue    # MusicBrainz busy: try again next run
        looked += 1
        hits += bool(links)
        db.save_artist(name, links or {}, "musicbrainz", checked=True)
    return looked, hits
