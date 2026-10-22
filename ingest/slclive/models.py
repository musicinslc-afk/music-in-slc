"""The normalized show record every source produces."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Optional


@dataclass
class Show:
    title: str
    starts_at: datetime                      # timezone-aware
    venue_name: str
    source: str                              # e.g. "jsonld:kilby-court", "ticketmaster", "email"
    artists: list[str] = field(default_factory=list)
    city: Optional[str] = None
    doors_at: Optional[datetime] = None
    price_min: Optional[float] = None
    price_max: Optional[float] = None
    is_free: bool = False
    age_restriction: Optional[str] = None    # all_ages | 18_plus | 21_plus
    raw_genres: list[str] = field(default_factory=list)
    genres: list[str] = field(default_factory=list)
    description: Optional[str] = None
    ticket_url: Optional[str] = None
    image_url: Optional[str] = None
    image_kind: Optional[str] = None         # flyer | photo (an artist press photo)
    source_url: Optional[str] = None
    cancelled: bool = False
    status: str = "published"                # published for trusted scrapers, pending for email
    submitter_email: Optional[str] = None
    submitter_notes: Optional[str] = None
    artist_url: Optional[str] = None         # headliner link waiting for an admin to check it
    # band links the source gave: {artist name: {kind: url}}; saved to the artists table
    artist_links: dict = field(default_factory=dict)
    flyer_index: int = 0                     # emailed shows: which attached image is the flyer (1-based)
    # filled in by normalize.resolve()
    venue_id: Optional[str] = None
    venue_slug: Optional[str] = None
    fingerprint: Optional[str] = None

    def to_row(self) -> dict:
        d = asdict(self)
        d["starts_at"] = self.starts_at.isoformat()
        d["doors_at"] = self.doors_at.isoformat() if self.doors_at else None
        d["status"] = "cancelled" if self.cancelled else self.status
        d["sources"] = [self.source]
        for k in ("cancelled", "venue_slug", "artist_links", "flyer_index"):
            d.pop(k)
        return d
