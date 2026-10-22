"""Find flyers for listed shows that arrived without an image.

Most event pages name their show image for link previews (og:image) or in their event data,
and for venue calendars and 24tix that image is usually the flyer. Each upcoming show with no
image has its event page read once; the result is recorded either way so pages aren't re-read.
Images that turn up for several different bands are a venue logo or placeholder and are dropped."""
from __future__ import annotations

import json
import re
from collections import defaultdict
from typing import Optional
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from . import fetch
from .links import artist_key
from .sources.venue_parsers import _NOT_FLYER

# Pages that never carry a show-specific image we can use, or that block automated visits
SKIP_HOSTS = re.compile(r"(^|\.)(ticketmaster|livenation|axs|seatgeek|stubhub|google|facebook|instagram)\.", re.I)
MAX_PAGES_PER_RUN = 60
SHARED_IMAGE_LIMIT = 3      # the same image for this many different bands is a logo, not a flyer

# Sites that show the flyer on the page but don't name it for link previews: the image path that marks it,
# and file names that are the site's stand-in graphic rather than a flyer.
SITE_IMAGES = {
    # The State Room Presents: each show's square flyer is uploaded under /media/acfupload/. Shows without one
    # get the room's graphic (564_x564_Commonwealth_Room.png and the like).
    "thestateroompresents.com": (
        re.compile(r"/media/acfupload/", re.I),
        re.compile(r"(commonwealth|state[_ -]?room|eccles|deer[_ -]?valley|fort[_ -]?desolation)[^/]*$", re.I),
    ),
}
# Pages checked before a site rule existed for their host are read again once
SITE_RULES_ADDED = "2026-10-23"


def page_image(html: str, page_url: str) -> Optional[str]:
    soup = BeautifulSoup(html, "html.parser")
    for attrs in ({"property": "og:image"}, {"property": "og:image:url"}, {"name": "twitter:image"}):
        tag = soup.find("meta", attrs=attrs)
        if tag and tag.get("content"):
            url = urljoin(page_url, tag["content"].strip())
            if usable(url):
                return url
    for tag in soup.find_all("script", type=lambda t: t and "ld+json" in t):
        try:
            data = json.loads(tag.string or tag.get_text() or "")
        except (json.JSONDecodeError, TypeError):
            continue
        for node in data if isinstance(data, list) else [data]:
            if not isinstance(node, dict) or not str(node.get("@type", "")).endswith("Event"):
                continue
            image = node.get("image")
            image = image[0] if isinstance(image, list) and image else image
            image = image.get("url") if isinstance(image, dict) else image
            if isinstance(image, str) and usable(urljoin(page_url, image)):
                return urljoin(page_url, image)
    host = urlparse(page_url).netloc.lower().removeprefix("www.")
    rule = SITE_IMAGES.get(host)
    if rule:
        marks, stand_in = rule
        for img in soup.find_all("img"):
            src = (img.get("src") or img.get("data-src") or "").strip()
            url = urljoin(page_url, src) if src else ""
            if url and marks.search(url) and usable(url):
                return None if stand_in.search(urlparse(url).path) else url
    return None


def usable(url: str) -> bool:
    u = urlparse(url)
    return u.scheme in ("http", "https") and bool(u.netloc) and not _NOT_FLYER.search(u.path)


def candidate_pages(row: dict) -> list[str]:
    pages = []
    for url in (row.get("source_url"), row.get("ticket_url")):
        if not url or url in pages:
            continue
        u = urlparse(url)
        if u.scheme not in ("http", "https") or SKIP_HOSTS.search(u.netloc + "."):
            continue
        # A listing page (KRCL's whole calendar, a venue's events page) is not the show's own page
        if u.query and "category=" in u.query:
            continue
        pages.append(url)
    return pages


def backfill(db, limit: int = MAX_PAGES_PER_RUN) -> tuple[int, int]:
    """Returns (shows checked, flyers found)."""
    rows = db.shows_missing_images(limit, recheck_hosts=tuple(SITE_IMAGES), checked_before=SITE_RULES_ADDED)
    found: dict[str, Optional[str]] = {}
    bands_by_image: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        image = None
        for page in candidate_pages(row):
            try:
                image = page_image(fetch.get(page).text, page)
            except Exception:
                image = None    # a dead or blocked page: record the check and move on
            if image:
                break
        found[row["id"]] = image
        if image:
            bands_by_image[image].add(artist_key((row.get("artists") or [row.get("title")])[0]))
    # Shows already carrying the same image count too, so a logo is caught across runs
    for image, bands in bands_by_image.items():
        for other in db.shows_with_image(image):
            bands.add(artist_key((other.get("artists") or [other.get("title")])[0]))
    hits = 0
    for row in rows:
        image = found.get(row["id"])
        if image and len(bands_by_image[image]) >= SHARED_IMAGE_LIMIT:
            image = None
        hits += bool(image)
        db.set_image(row["id"], image, "flyer" if image else None)
    return len(rows), hits
