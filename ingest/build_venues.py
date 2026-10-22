"""Build web/venues.json, the data behind the site's Venues page, from config/venues.yaml.

For each venue it checks the website still answers and takes the site's preview picture
(og:image or twitter:image), falling back to the venue's Mato page. Links that no longer
work are left out and reported, so the page never shows a dead link.

Usage:
    python build_venues.py              # write ../web/venues.json
    python build_venues.py --print      # print the JSON instead
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote_plus, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from slclive import fetch, settings
from slclive.normalize import TZ, load_venues

OUT = settings.REPO / "web" / "venues.json"
# Bot checks answer with these instead of the page; the site is there for people
CHALLENGE_STATUSES = {202, 403, 429, 503}


def get_page(url: str) -> tuple[Optional[int], str]:
    """(status, html). Status None when the site can't be reached at all."""
    try:
        if not fetch._allowed(url):
            return 200, ""   # robots.txt asks us not to read it; the link itself is fine
        r = fetch._get(url, timeout=25, allow_redirects=True)
        return r.status_code, r.text if r.status_code < 400 else ""
    except requests.RequestException:
        return None, ""


def preview_image(html: str, base: str) -> Optional[str]:
    if not html:
        return None
    soup = BeautifulSoup(html, "html.parser")
    for attrs in ({"property": "og:image"}, {"property": "og:image:url"}, {"name": "twitter:image"},
                  {"name": "twitter:image:src"}, {"itemprop": "image"}):
        tag = soup.find("meta", attrs=attrs)
        content = (tag.get("content") or "").strip() if tag else ""
        if content:
            url = urljoin(base, content.replace("http://", "https://", 1))
            if urlparse(url).scheme == "https":
                return url
    return None


def first_photo(html: str, base: str) -> Optional[str]:
    """The first sizable photo on a page that has no preview picture (skips logos and icons)."""
    if not html:
        return None
    soup = BeautifulSoup(html, "html.parser")
    for img in soup.find_all("img"):
        src = img.get("src") or img.get("data-src") or ""
        if not src and img.get("srcset"):
            src = img["srcset"].split(",")[0].split()[0]
        if not re.search(r"\.(jpe?g|png|webp)(\?|$)", src, re.I) or re.search(r"logo|icon|sprite|avatar|badge|pixel", src, re.I):
            continue
        width = img.get("width") or ""
        if width.isdigit() and int(width) < 400:
            continue
        url = urljoin(base, src.replace("http://", "https://", 1))
        if urlparse(url).scheme == "https":
            return url
    return None


def wikipedia_image(title: str) -> Optional[str]:
    try:
        data = fetch.get("https://en.wikipedia.org/w/api.php", check_robots=False, params={
            "action": "query", "titles": title, "prop": "pageimages", "piprop": "thumbnail",
            "pithumbsize": 960, "redirects": 1, "format": "json"}).json()
    except Exception:
        return None
    for page in (data.get("query", {}).get("pages") or {}).values():
        src = (page.get("thumbnail") or {}).get("source")
        if src:
            return src
    return None


def build() -> tuple[list[dict], list[str]]:
    problems: list[str] = []
    rows = []
    for v in load_venues():
        candidates = [u for u in (v.website, *(v.calendar_urls or [])) if u]
        mato = f"https://ma.to/venue/{v.mato_venue}" if v.mato_venue else None
        image = v.image
        site, html = None, ""
        for url in dict.fromkeys(candidates):
            status, page = get_page(url)
            if status is None:
                # Unreachable from the build machine, often a bot block: keep the link, flag it
                problems.append(f"{v.slug}: couldn't check {url}; link kept")
                site = site or url
                continue
            if status >= 400 and status not in CHALLENGE_STATUSES:
                problems.append(f"{v.slug}: {url} answered {status}; link left out")
                continue
            site = url
            html = page
            break
        if not image and html:
            image = preview_image(html, site)
        if not image and v.wikipedia:
            image = wikipedia_image(v.wikipedia)
        if not image and html:
            image = first_photo(html, site)
        if not image and mato:
            _, html = get_page(mato)
            image = preview_image(html, mato)
        if not site and mato:
            site = mato
        where = ", ".join(x for x in (v.address, v.city) if x)
        rows.append({
            "slug": v.slug,
            "name": v.name,
            "aliases": v.aliases,
            "kind": v.kind,
            "capacity": v.capacity,
            "address": v.address,
            "city": v.city,
            "age_policy": v.age_policy,
            "website": site,
            "image": image,
            "map": "https://www.google.com/maps/search/?api=1&query=" + quote_plus(f"{v.name}, {where or 'Salt Lake City'}, UT"),
        })
        if not image:
            problems.append(f"{v.slug}: no picture found")
    rows.sort(key=lambda r: r["name"].lower().removeprefix("the "))
    return rows, problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", action="store_true")
    a = ap.parse_args()
    rows, problems = build()
    doc = {"updated": datetime.now(timezone.utc).astimezone(TZ).isoformat(timespec="minutes"), "venues": rows}
    text = json.dumps(doc, indent=1, ensure_ascii=False) + "\n"
    if a.print:
        print(text)
    else:
        OUT.write_text(text)
    for p in problems:
        print(p, file=sys.stderr)
    print(f"{len(rows)} venues, {sum(1 for r in rows if r['image'])} with pictures, "
          f"{sum(1 for r in rows if r['website'])} with links", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
