"""Scrape one venue's calendar page with the 'auto' strategy:
JSON-LD first, then an iCal feed, then the AI page reader as a fallback."""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Callable, Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from .. import ai_extract, fetch
from ..models import Show
from ..normalize import Venue
from . import ics, jsonld


@dataclass
class PageResult:
    shows: list[Show] = field(default_factory=list)
    method: str = ""
    content_hash: Optional[str] = None
    skipped_unchanged: bool = False


def page_text(html: str, base_url: str) -> str:
    """Readable text with link targets kept, so the AI reader can pick up ticket URLs."""
    soup = BeautifulSoup(html, "html.parser")
    for t in soup(["script", "style", "noscript", "svg", "iframe", "header", "footer", "nav", "form"]):
        t.decompose()
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"])
        if re.search(r"ticket|event|show|buy|tix|dice\.fm|etix|seetickets|eventbrite", href, re.I):
            a.append(f" [{href}]")
    text = soup.get_text("\n")
    text = re.sub(r"\n\s*\n+", "\n", text)
    return re.sub(r"[ \t]+", " ", text).strip()


def scrape(venue: Venue, previous_hash: Callable[[str], Optional[str]]) -> PageResult:
    result = PageResult()
    source = f"venue:{venue.slug}"
    texts = []
    for url in venue.calendar_urls:
        html = fetch.get(url).text
        found = jsonld.parse(html, url, source=source, default_venue=venue.name)
        # A venue page sometimes lists shows at sister venues; keep them, normalize sorts it out
        if found:
            result.shows.extend(found)
            result.method = "jsonld"
        else:
            texts.append((url, page_text(html, url)))

    if not result.shows and venue.ics_url:
        result.shows = ics.parse(fetch.get(venue.ics_url).text, source=source, default_venue=venue.name)
        result.method = "ics"

    if not result.shows and texts:
        combined = "\n\n".join(f"Page: {u}\n{t}" for u, t in texts)
        result.content_hash = hashlib.sha256(combined.encode()).hexdigest()[:16]
        if previous_hash(source) == result.content_hash:
            result.skipped_unchanged = True
            result.method = "ai (page unchanged, skipped)"
            return result
        if not ai_extract.available():
            raise RuntimeError("No structured event data on page; set ANTHROPIC_API_KEY to enable the AI page reader")
        result.shows = ai_extract.extract(
            combined, source=source, default_venue=venue.name,
            context=f"This is the events page for {venue.name} in {venue.city or 'Salt Lake County'}, Utah.",
        )
        result.method = "ai"
    return result
