"""Map free-form genre strings and tags onto the site's genre taxonomy (web/genres.json)."""
from __future__ import annotations

import json
import re
from functools import lru_cache

from . import settings


@lru_cache(maxsize=1)
def _rules() -> list[tuple[str, list[re.Pattern]]]:
    data = json.loads(settings.GENRES_FILE.read_text())
    rules = []
    for g in data["genres"]:
        pats = []
        for kw in g["keywords"]:
            kw = kw.lower()
            # Whole-word matches only, so "dance" doesn't claim "dancehall"
            pats.append(re.compile(r"(?<![a-z0-9])" + re.escape(kw) + r"(?![a-z0-9])"))
        rules.append((g["id"], pats))
    return rules


def genre_ids() -> list[str]:
    return [gid for gid, _ in _rules()]


def map_genres(raw: list[str] | None, limit: int = 4) -> list[str]:
    """Return site genre ids for a list of raw genre strings, most specific first."""
    if not raw:
        return []
    hits: dict[str, int] = {}
    for position, value in enumerate(raw):
        text = (value or "").lower().strip()
        if not text or text in ("undefined", "other", "music", "miscellaneous", "seen live"):
            continue
        for gid, pats in _rules():
            if any(p.search(text) for p in pats):
                # earlier raw tags are stronger signals
                hits[gid] = min(hits.get(gid, 999), position)
    ordered = sorted(hits, key=lambda g: hits[g])
    # "rock" is a catch-all; drop it when a more specific rock-family genre is present
    if "rock" in ordered and any(g in ordered for g in ("indie", "punk", "metal")) and len(ordered) > 1:
        ordered.remove("rock")
        ordered.append("rock")
    return ordered[:limit]
