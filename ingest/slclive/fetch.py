"""Polite HTTP: identifies itself, obeys robots.txt, and spaces out requests per host."""
from __future__ import annotations

import time
import urllib.robotparser
from urllib.parse import urlparse

import requests

from . import settings

_session = requests.Session()
_session.headers.update({"User-Agent": settings.USER_AGENT, "Accept-Language": "en-US,en;q=0.9"})
_robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
_last_hit: dict[str, float] = {}
MIN_GAP_SECONDS = 2.0


class RobotsDisallowed(Exception):
    pass


def _allowed(url: str) -> bool:
    parts = urlparse(url)
    host = f"{parts.scheme}://{parts.netloc}"
    if host not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            r = _session.get(host + "/robots.txt", timeout=15)
            if r.status_code >= 400:
                _robots[host] = None  # no robots.txt: allowed
            else:
                rp.parse(r.text.splitlines())
                _robots[host] = rp
        except requests.RequestException:
            _robots[host] = None
    rp = _robots[host]
    return True if rp is None else rp.can_fetch(settings.USER_AGENT, url)


def get(url: str, *, params: dict | None = None, check_robots: bool = True, timeout: int = 30) -> requests.Response:
    if check_robots and not _allowed(url):
        raise RobotsDisallowed(f"robots.txt disallows {url}")
    host = urlparse(url).netloc
    wait = MIN_GAP_SECONDS - (time.monotonic() - _last_hit.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    for attempt in range(3):
        try:
            r = _session.get(url, params=params, timeout=timeout)
            _last_hit[host] = time.monotonic()
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(5 * (attempt + 1))
                continue
            r.raise_for_status()
            return r
        except requests.ConnectionError:
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))
    r.raise_for_status()
    return r
