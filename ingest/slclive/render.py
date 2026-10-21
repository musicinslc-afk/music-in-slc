"""Load a page in a headless browser so calendars drawn by JavaScript can be read.

Used by venues with `strategy: render`. The same politeness rules as fetch.get apply:
robots.txt is checked and requests to one host are spaced out. The browser starts once per
run and is closed at exit."""
from __future__ import annotations

import atexit
import time
from urllib.parse import urlparse

from . import fetch, settings

_browser = None
_playwright = None


def _get_browser():
    global _browser, _playwright
    if _browser is None:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as e:
            raise RuntimeError("Playwright is not installed; run `pip install playwright && "
                               "python -m playwright install chromium`") from e
        _playwright = sync_playwright().start()
        _browser = _playwright.chromium.launch()
        atexit.register(close)
    return _browser


def close() -> None:
    global _browser, _playwright
    if _browser is not None:
        _browser.close()
        _playwright.stop()
        _browser = _playwright = None


def get_html(url: str, timeout_ms: int = 45000) -> str:
    if not fetch._allowed(url):
        raise fetch.RobotsDisallowed(f"robots.txt disallows {url}")
    host = urlparse(url).netloc
    wait = fetch.MIN_GAP_SECONDS - (time.monotonic() - fetch._last_hit.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    page = _get_browser().new_page(user_agent=settings.USER_AGENT)
    try:
        page.goto(url, wait_until="networkidle", timeout=timeout_ms)
        return page.content()
    finally:
        fetch._last_hit[host] = time.monotonic()
        page.close()
