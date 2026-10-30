"""Finish descriptions that arrived cut off.

Some calendars (The State Room Presents, for one) give only a teaser ending in "..." The show's
own page has the whole text, so each upcoming show with a cut-off description has that page read
once and keeps the opening of the full description, a few sentences at most. When the page has
nothing better, the teaser is trimmed to its last complete sentence, so either way the listing no
longer ends mid-thought and the page isn't read again."""
from __future__ import annotations

import json
import re
from typing import Optional

from bs4 import BeautifulSoup

from . import fetch
from .flyers import candidate_pages
from .normalize import clean

MAX_PAGES_PER_RUN = 40
MAX_CHARS = 700          # keep a short summary, not the venue's whole write-up
_HEADING = re.compile(r"^h[1-4]$")
_SENTENCE_END = re.compile(r"[.!?][\"'”’)]?(?=\s|$)")


def is_cut(text: Optional[str]) -> bool:
    return bool(text) and text.rstrip().endswith(("...", "…"))


def _stem(text: str) -> str:
    return re.sub(r"(\.\.\.|…)\s*$", "", text).strip()


def _sentences(text: str, limit: int = MAX_CHARS) -> Optional[str]:
    """The text up to its last complete sentence within `limit` characters."""
    text = clean(text) or ""
    if len(text) <= limit and not is_cut(text) and _SENTENCE_END.search(text[-3:] + " "):
        return text
    window = _stem(text)[:limit]
    ends = [m.end() for m in _SENTENCE_END.finditer(window)]
    return window[:ends[-1]].strip() if ends else None


def _paragraphs_after_heading(soup: BeautifulSoup) -> list[str]:
    for h in soup.find_all(_HEADING):
        if h.get_text(" ", strip=True).lower() not in ("description", "about", "about the show", "event details"):
            continue
        out = []
        for el in h.find_all_next(True):
            if _HEADING.match(el.name or "") and out:
                break
            if el.name == "p":
                t = clean(el.get_text(" ", strip=True))
                if t:
                    out.append(t)
        if out:
            return out
    return []


def full_text(html: str) -> Optional[str]:
    """The fullest description a show page offers, or None."""
    soup = BeautifulSoup(html, "html.parser")
    found: list[str] = []
    for tag in soup.find_all("script", type=lambda t: t and "ld+json" in t):
        try:
            data = json.loads(tag.string or tag.get_text() or "")
        except (json.JSONDecodeError, TypeError):
            continue
        for node in data if isinstance(data, list) else [data]:
            if isinstance(node, dict) and str(node.get("@type", "")).endswith("Event") and node.get("description"):
                found.append(BeautifulSoup(str(node["description"]), "html.parser").get_text(" ", strip=True))
    paras = _paragraphs_after_heading(soup)
    if paras:
        found.append(" ".join(paras))
    for attrs in ({"property": "og:description"}, {"name": "description"}):
        tag = soup.find("meta", attrs=attrs)
        if tag and tag.get("content"):
            found.append(tag["content"])
    found = [clean(t) for t in found if clean(t) and not is_cut(clean(t))]
    return max(found, key=len) if found else None


def finish(teaser: str, page_text: Optional[str]) -> Optional[str]:
    """The description to store in place of a cut-off teaser."""
    stem = _stem(teaser)
    if page_text and len(page_text) > len(stem):
        i = page_text.find(stem[:30])
        start = i if i > 0 else 0
        text = _sentences(page_text[start:])
        if text and len(text) > len(_sentences(stem) or ""):
            return text
    return _sentences(stem)


def backfill(db, limit: int = MAX_PAGES_PER_RUN) -> tuple[int, int]:
    """Returns (shows checked, descriptions completed from the show's page)."""
    rows = db.shows_with_cut_descriptions(limit)
    completed = 0
    for row in rows:
        page_text = None
        for page in candidate_pages(row):
            try:
                page_text = full_text(fetch.get(page).text)
            except Exception:
                page_text = None
            if page_text:
                break
        text = finish(row["description"], page_text)
        completed += bool(page_text and text and len(text) > len(_stem(row["description"])))
        db.set_description(row["id"], text)
    return len(rows), completed
