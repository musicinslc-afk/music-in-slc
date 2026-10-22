"""Scrape one venue's calendar page with the 'auto' strategy:
JSON-LD first, then an iCal feed, then the AI page reader as a fallback."""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field, replace
from typing import Callable, Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from .. import ai_extract, fetch, music_filter, render
from ..models import Show
from ..normalize import Venue
from . import ics, jsonld, ticketsauce
from .venue_parsers import PARSERS, recurring


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


# Ticket sites whose event pages carry structured event data and allow crawling.
# Venue calendars link to these, so the scraper follows the links and reads each event page.
# (AXS sits behind a bot challenge and Eventlive has no structured data, so they're not listed.)
FOLLOW_LINKS = [
    (re.compile(r"^https?://(?:www\.)?24tix\.com/events?/([A-Za-z0-9]+)"), "https://www.24tix.com/event/{}"),
]
MAX_FOLLOWED_PER_VENUE = 80
_followed: dict[str, list[Show]] = {}   # event pages already read this run, shared across venues


def event_links(html: str, base_url: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    found: list[str] = []
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"])
        for pattern, canonical in FOLLOW_LINKS:
            m = pattern.match(href)
            if m:
                url = canonical.format(m.group(1))
                if url not in found:
                    found.append(url)
    return found[:MAX_FOLLOWED_PER_VENUE]


def follow(links: list[str], source: str) -> list[Show]:
    shows: list[Show] = []
    for url in links:
        if url not in _followed:
            try:
                _followed[url] = jsonld.parse(fetch.get(url).text, url, source=source)
            except Exception:
                _followed[url] = []  # one dead ticket link shouldn't sink the venue
        shows.extend(replace(s, source=source) for s in _followed[url])
    return shows


def scrape(venue: Venue, previous_hash: Callable[[str], Optional[str]]) -> PageResult:
    result = _scrape(venue, previous_hash)
    if venue.music_only:
        result.shows = music_filter.apply(result.shows)
    return result


def _scrape(venue: Venue, previous_hash: Callable[[str], Optional[str]]) -> PageResult:
    result = PageResult()
    source = f"venue:{venue.slug}"
    if venue.recurring and not venue.calendar_urls:
        result.shows = recurring(venue.recurring, venue.name, source)
        result.method = "weekly schedule"
        return result
    if venue.ticketsauce_partner:
        result.shows = ticketsauce.fetch_shows(venue.ticketsauce_partner, venue.name, source)
        result.method = "ticketsauce"
        if result.shows or not venue.calendar_urls:
            return result
    texts = []
    for url in venue.calendar_urls:
        html = render.get_html(url) if venue.strategy == "render" else fetch.get(url).text
        parser = PARSERS.get(venue.parser or "")
        if parser:
            found = parser(html, url, venue.name, source)
            if found:
                result.shows.extend(found)
                result.method = f"parser:{venue.parser}"
                continue
        found = jsonld.parse(html, url, source=source, default_venue=venue.name)
        # A venue page sometimes lists shows at sister venues; keep them, normalize sorts it out
        if found:
            result.shows.extend(found)
            result.method = "rendered jsonld" if venue.strategy == "render" else "jsonld"
            continue
        links = event_links(html, url)
        followed = follow(links, source) if links else []
        if followed:
            result.shows.extend(followed)
            result.method = f"ticket links ({len(links)} pages)"
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
