"""Fill in genres for shows whose source didn't give any, using Last.fm artist tags."""
from __future__ import annotations

from functools import lru_cache

from . import fetch, settings
from .genres import map_genres
from .models import Show

API = "https://ws.audioscrobbler.com/2.0/"
MAX_LOOKUPS_PER_RUN = 250
_lookups = 0


@lru_cache(maxsize=4096)
def artist_tags(artist: str) -> tuple[str, ...]:
    global _lookups
    if not settings.LASTFM_API_KEY or _lookups >= MAX_LOOKUPS_PER_RUN:
        return ()
    _lookups += 1
    try:
        data = fetch.get(API, check_robots=False, params={
            "method": "artist.gettoptags", "artist": artist, "api_key": settings.LASTFM_API_KEY,
            "format": "json", "autocorrect": 1,
        }).json()
    except Exception:
        return ()
    tags = data.get("toptags", {}).get("tag", [])
    # Keep tags with real weight; low counts are noise
    return tuple(t["name"] for t in tags if int(t.get("count", 0)) >= 10)[:10]


def fill_genres(show: Show) -> None:
    if show.genres:
        return
    for artist in show.artists[:2]:
        tags = artist_tags(artist)
        if tags:
            show.raw_genres = list(dict.fromkeys([*show.raw_genres, *tags]))
            show.genres = map_genres(list(tags))
            if show.genres:
                return
