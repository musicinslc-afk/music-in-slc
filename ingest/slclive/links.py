"""Band links: sorting URLs into kinds (website, Bandcamp, Instagram...) and matching artists
by a normalized name. The site has the same rules in web/data.js (artistKey, linkKind)."""
from __future__ import annotations

import re
import unicodedata
from typing import Iterable, Optional
from urllib.parse import urlparse

# Display order on the site
KINDS = ("homepage", "bandcamp", "instagram", "spotify", "youtube", "soundcloud", "tiktok",
         "facebook", "twitter", "linktree")

_HOST_KINDS = [
    ("bandcamp.com", "bandcamp"), ("instagram.com", "instagram"), ("open.spotify.com", "spotify"),
    ("youtube.com", "youtube"), ("youtu.be", "youtube"), ("soundcloud.com", "soundcloud"),
    ("tiktok.com", "tiktok"), ("facebook.com", "facebook"), ("fb.com", "facebook"),
    ("twitter.com", "twitter"), ("x.com", "twitter"), ("linktr.ee", "linktree"),
]

# Ticket sellers, venues' calendars, listings and reference sites: never a band's own page
_NOT_BAND = re.compile(
    r"(^|\.)(ticketmaster|livenation|axs|24tix|eventbrite|seetickets|dice|etix|ticketweb|ticketsauce|"
    r"seatgeek|stubhub|vividseats|songkick|bandsintown|ticketfly|tixr|eventlive|showclix|holdmyticket|"
    r"google|goo|bit|wikipedia|wikidata|musicbrainz|last|discogs|allmusic|apple|amazon|deezer|tidal|"
    r"pandora|genius|imdb|krcl|thestateroompresents|kilbycourt|theurbanloungeslc|metromusichall|"
    r"soundwellslc|thehogwallow|musicinslc-afk|gmail|mailchimp|list-manage)\.",
    re.I)
_SPOTIFY_ARTIST = re.compile(r"^/(intl-[a-z]+/)?artist/", re.I)


def link_kind(url: Optional[str]) -> Optional[str]:
    """The kind of a band link, or None for URLs that aren't a band's own page."""
    if not url:
        return None
    try:
        u = urlparse(url.strip())
    except ValueError:
        return None
    if u.scheme not in ("http", "https") or not u.netloc:
        return None
    host = u.netloc.lower().split("@")[-1].split(":")[0]
    host = host[4:] if host.startswith("www.") else host
    for domain, kind in _HOST_KINDS:
        if host == domain or host.endswith("." + domain):
            if kind == "spotify" and not _SPOTIFY_ARTIST.match(u.path):
                return None          # a single track or playlist, not the artist page
            if kind == "instagram" and re.match(r"^/(p|reel|explore)/", u.path):
                return None          # one post, not the account
            if kind == "facebook" and re.match(r"^/(events|share|sharer)", u.path):
                return None
            return kind
    if _NOT_BAND.search(host + "."):
        return None
    return "homepage"


def clean_links(urls: Iterable[str] | dict, homepage: Optional[str] = None) -> dict[str, str]:
    """{kind: url} keeping the first link of each kind. Accepts a list of URLs or a {kind: url}
    dict. An "official site" that is really a Bandcamp or Linktree page is filed under that kind."""
    out: dict[str, str] = {}
    items = list(urls.items()) if isinstance(urls, dict) else [(None, u) for u in urls]
    if homepage:
        items.insert(0, ("homepage", homepage))
    for given, url in items:
        url = (url or "").strip()
        kind = link_kind(url)
        if not kind:
            continue
        if kind not in out:
            out[kind] = url
    return {k: out[k] for k in KINDS if k in out}


def artist_key(name: Optional[str]) -> str:
    """Normalized artist name: lowercase ASCII letters and digits, no leading 'The'."""
    n = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower().strip()
    n = re.sub(r"^the\s+", "", n)
    return re.sub(r"[^a-z0-9]+", "", n)[:60]
