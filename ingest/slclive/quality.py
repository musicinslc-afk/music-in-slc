"""Weekly listing check for the digest: the kinds of mistakes a visitor would notice.

- the same show listed more than once at one venue on one night
- one headliner listed at two different venues on the same night
- published listings whose titles say they aren't music (sports, comedy, trivia...)
- runaway fingerprints (a show re-suffixed on every run, the old SAP bug)

Each finding is one line naming the night, the venue and the titles, so it can be fixed from
the admin page."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime

from .db import same_show
from .music_filter import MUSIC, NOT_MUSIC
from .normalize import TZ, _NOT_A_SHOW, headliner_key


def _night(row: dict) -> str:
    return (row.get("fingerprint") or "").split("|")[1] if (row.get("fingerprint") or "").count("|") >= 2 else ""


def _day(row: dict) -> str:
    try:
        return datetime.fromisoformat(str(row["starts_at"])).astimezone(TZ).strftime("%a %b %-d")
    except (KeyError, ValueError):
        return _night(row)


def check(rows: list[dict]) -> dict[str, list[str]]:
    rows = [r for r in rows if r.get("status") == "published"]
    found: dict[str, list[str]] = {"duplicates": [], "two_venues": [], "not_music": [], "runaway": []}

    by_room = defaultdict(list)
    for r in rows:
        by_room[(r.get("venue_name"), _night(r))].append(r)
    for (venue, _), group in sorted(by_room.items(), key=lambda kv: kv[0][1]):
        seen: list[dict] = []
        for r in group:
            if any(same_show(s, r) for s in seen):
                copies = sum(1 for g in group if same_show(g, r))
                line = f"{_day(r)}: {r['title']} at {venue} ({copies} listings)"
                if line not in found["duplicates"]:
                    found["duplicates"].append(line)
            else:
                seen.append(r)

    by_act = defaultdict(set)
    titles = {}
    for r in rows:
        fp = r.get("fingerprint") or ""
        # The fingerprint's headliner part already drops tour names ("Todd Rundgren: Damned If I Do Tour")
        key = fp.split("|", 2)[2].split("~")[0] if fp.count("|") >= 2 else headliner_key(r.get("title") or "", r.get("artists"))
        if len(key) >= 4:
            by_act[(key, _night(r))].add(r.get("venue_name"))
            titles[(key, _night(r))] = r
    for (key, night), venues in sorted(by_act.items(), key=lambda kv: kv[0][1]):
        if len(venues) > 1:
            r = titles[(key, night)]
            found["two_venues"].append(f"{_day(r)}: {r['title']} at {' and '.join(sorted(v or '?' for v in venues))}")

    for r in rows:
        t = r.get("title") or ""
        if _NOT_A_SHOW.search(t) or (NOT_MUSIC.search(t) and not MUSIC.search(t)):
            found["not_music"].append(f"{_day(r)}: {t} at {r.get('venue_name')}")
        if (r.get("fingerprint") or "").count("~") > 1:
            found["runaway"].append(f"{_day(r)}: {t} at {r.get('venue_name')}")
    found["runaway"] = sorted(set(found["runaway"]))
    return found


HEADINGS = {
    "duplicates": "Shows listed more than once at the same venue:",
    "two_venues": "Acts listed at two venues on the same night (one is probably wrong):",
    "not_music": "Published listings that don't look like music:",
    "runaway": "Listings with runaway duplicate keys (a merge bug):",
}
