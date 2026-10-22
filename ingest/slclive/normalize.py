"""Cleaning, venue matching, county filtering and duplicate fingerprints."""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, date, time
from difflib import SequenceMatcher
from functools import lru_cache
from typing import Iterable, Optional
from zoneinfo import ZoneInfo

import yaml
from dateutil import parser as dateparser

from . import settings
from .genres import map_genres
from .models import Show

TZ = ZoneInfo(settings.TIMEZONE)


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------
def clean(text: Optional[str]) -> Optional[str]:
    if text is None:
        return None
    text = unicodedata.normalize("NFKC", str(text))
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return text


_SUPPORT_SPLIT = re.compile(
    r"\s*,\s*|\s+/\s+|\s+(?:w/|with|feat\.?|ft\.?|featuring|plus|and special guests?|special guests?:?)\s*",
    re.I,
)
_PREFIX_NOISE = re.compile(
    r"^(?:.*?\bpresents?:?\s+|an evening with\s+|live:?\s+|in concert:?\s+|sold out[:!-]*\s*|"
    r"rescheduled[:!-]*\s*|postponed[:!-]*\s*|canceled[:!-]*\s*|cancelled[:!-]*\s*)",
    re.I,
)
_TOUR_SUFFIX = re.compile(r"\s+(?:[-–—:|]\s+.*\btour\b.*|[-–—:|]\s+.*\b20\d\d\b.*|\(.*\btour\b.*\))$", re.I)


def split_artists(title: str) -> list[str]:
    """Best-effort split of 'Headliner w/ Opener, Opener 2' into artist names."""
    t = clean(title) or ""
    t = _PREFIX_NOISE.sub("", t)
    t = _TOUR_SUFFIX.sub("", t)
    parts = [p.strip(" -–—:|") for p in _SUPPORT_SPLIT.split(t)]
    # Don't trust a split that leaves tiny fragments ("AC/DC" style names)
    parts = [p for p in parts if p]
    if len(parts) > 1 and any(len(p) <= 3 for p in parts):
        return [t.strip()]
    return parts[:12] or [t.strip()]


def headliner_key(title: str, artists: Iterable[str] | None = None) -> str:
    base = next(iter(artists), None) if artists else None
    base = base or split_artists(title)[0]
    base = base.lower()
    base = re.sub(r"^the\s+", "", base)
    base = re.sub(r"[^a-z0-9]+", "", unicodedata.normalize("NFKD", base).encode("ascii", "ignore").decode())
    return base[:40] or "show"


def similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------
def parse_dt(value, default_time: time | None = time(19, 0)) -> Optional[datetime]:
    """Parse many date formats into an aware datetime in Mountain time."""
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, date):
        dt = datetime.combine(value, default_time or time(0, 0))
    else:
        s = str(value).strip()
        try:
            dt = dateparser.parse(s, default=datetime.combine(datetime.now(TZ).date(), default_time or time(0, 0)))
        except (ValueError, OverflowError):
            return None
        # A bare date ("2026-11-02") parses to midnight; use the default show time instead
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s) and default_time:
            dt = datetime.combine(dt.date(), default_time)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return dt.astimezone(TZ)


# ---------------------------------------------------------------------------
# Venues
# ---------------------------------------------------------------------------
@dataclass
class Venue:
    slug: str
    name: str
    city: Optional[str] = None
    address: Optional[str] = None
    age_policy: Optional[str] = None
    default_genres: list[str] = field(default_factory=list)
    aliases: list[str] = field(default_factory=list)
    calendar_urls: list[str] = field(default_factory=list)
    ics_url: Optional[str] = None
    strategy: str = "auto"                  # auto | render | feeds_only
    parser: Optional[str] = None            # a layout parser in sources/venue_parsers.py
    ticketsauce_partner: Optional[str] = None
    expect_shows_within_days: Optional[int] = None   # coverage watchdog: flag if nothing upcoming
    music_only: bool = False                # mixed-use room: keep live music, drop the rest
    seasonal: bool = False                  # watchdog stays quiet in the off season (Oct through Mar)
    id: Optional[str] = None  # filled from the database

    @property
    def keys(self) -> set[str]:
        return {_venue_key(n) for n in [self.name, *self.aliases]}

    def to_row(self) -> dict:
        return {
            "slug": self.slug, "name": self.name, "city": self.city, "address": self.address,
            "age_policy": self.age_policy, "default_genres": self.default_genres,
            "aliases": self.aliases,
            "website": self.calendar_urls[0] if self.calendar_urls else None,
        }


def _venue_key(name: str) -> str:
    n = name.lower()
    n = re.sub(r"\b(salt lake city|slc|utah|ut)\b", " ", n)
    n = re.sub(r"^the\s+", "", n.strip())
    return re.sub(r"[^a-z0-9]+", "", n)


@lru_cache(maxsize=1)
def _config() -> dict:
    return yaml.safe_load((settings.CONFIG_DIR / "venues.yaml").read_text())


def load_venues() -> tuple[Venue, ...]:
    return tuple(Venue(**v) for v in _config()["venues"])


def load_feeds() -> list[dict]:
    """Calendar feeds that cover many venues at once (see `feeds:` in venues.yaml)."""
    return list(_config().get("feeds") or [])


def match_venue(name: Optional[str], venues: Iterable[Venue] | None = None) -> Optional[Venue]:
    if not name:
        return None
    venues = list(venues or load_venues())
    key = _venue_key(name)
    for v in venues:
        if key in v.keys:
            return v
    # Loose match: "The Grand at The Complex SLC - Complex" contains a known alias
    best, best_score = None, 0.0
    for v in venues:
        for k in v.keys:
            if len(k) >= 6 and (k in key or key in k):
                score = len(k) / max(len(key), 1)
                if score > best_score:
                    best, best_score = v, score
    return best


def in_salt_lake_county(city: Optional[str]) -> bool:
    if not city:
        return True  # unknown city: keep, venue matching and review will sort it out
    return clean(city).lower() in settings.SALT_LAKE_COUNTY_CITIES


# ---------------------------------------------------------------------------
# Final pass
# ---------------------------------------------------------------------------
# Ticket sites list passes, gift cards and parking next to real shows
_NOT_A_SHOW = re.compile(
    r"\b(golden ticket|gift cards?|gift certificates?|season pass|season tickets?|waitlist|annual pass|membership|parking|"
    r"(all ages|21\+|vip) pass|merch(andise)? only|presale registration)\b", re.I)


def resolve(show: Show, venues: Iterable[Venue] | None = None) -> Optional[Show]:
    """Clean a show, attach its venue, fill genres and fingerprint. Returns None to drop it."""
    show.title = clean(show.title) or ""
    show.venue_name = clean(show.venue_name) or ""
    if not show.title or not show.starts_at or _NOT_A_SHOW.search(show.title):
        return None
    if not show.artists:
        show.artists = split_artists(show.title)
    show.artists = [a for a in (clean(x) for x in show.artists) if a][:12]

    venue = match_venue(show.venue_name, venues)
    if venue:
        show.venue_id = venue.id
        show.venue_slug = venue.slug
        show.venue_name = venue.name
        show.city = venue.city
        if not show.age_restriction and venue.age_policy in ("all_ages", "21_plus"):
            show.age_restriction = venue.age_policy
    elif not in_salt_lake_county(show.city):
        return None

    if not show.genres:
        show.genres = map_genres(show.raw_genres)
    if not show.genres and venue and venue.default_genres:
        show.genres = list(venue.default_genres)

    if show.price_min == 0 and not show.price_max:
        show.is_free = True

    venue_part = show.venue_slug or slugify(show.venue_name)[:40] or "unknown-venue"
    show.fingerprint = f"{venue_part}|{show.starts_at.date().isoformat()}|{headliner_key(show.title, show.artists)}"
    return show
