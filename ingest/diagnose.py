"""Diagnose sources from GitHub Actions: fetch pages, render JavaScript ones, list the requests
they make, and dry-run chosen scrapers. Results go to Actions annotations so they can be read
from the API without downloading logs.

    python diagnose.py --url https://example.com/events --render
    python diagnose.py --scrape soundwell
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import traceback

from slclive import fetch
from slclive.sources import jsonld


def notice(title: str, text: str) -> None:
    # Annotations hold about 4,000 characters, so long output goes out in numbered parts
    chunks = [text[i:i + 3900] for i in range(0, min(len(text), 3900 * 5), 3900)] or [""]
    for n, chunk in enumerate(chunks, 1):
        body = chunk.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
        print(f"::notice title={title} ({n}/{len(chunks)})::{body}")


def body_markup(html: str, start: str | None) -> str:
    """The page body with scripts, styles and attributes other than href/class removed."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    for t in soup(["script", "style", "noscript", "svg", "head", "link", "meta", "iframe"]):
        t.decompose()
    for t in soup.find_all(True):
        t.attrs = {k: v for k, v in t.attrs.items() if k in ("href", "class", "datetime")}
    text = re.sub(r"\n\s*\n+", "\n", str(soup.body or soup))
    if start and start in text:
        text = text[text.index(start) - 300:]
    return text


START: str | None = None


def check_url(url: str, render: bool) -> None:
    out = []
    try:
        allowed = fetch._allowed(url)
        out.append(f"robots allows: {allowed}")
        r = fetch._get(url, timeout=30)
        out.append(f"status {r.status_code}, {len(r.text)} chars, type {r.headers.get('content-type')}")
        out.append(f"json-ld events: {len(jsonld.parse(r.text, url, source='diag'))}")
        if "json" in (r.headers.get("content-type") or "") or r.text.lstrip()[:1] in "[{":
            out.append("--- json ---\n" + r.text[:16000])
        elif not render:
            out.append("--- body ---\n" + body_markup(r.text, START)[:16000])
    except Exception as e:
        out.append(f"fetch error: {type(e).__name__}: {e}")
    if render:
        try:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as p:
                b = p.chromium.launch()
                page = b.new_page(user_agent=fetch.settings.USER_AGENT)
                reqs = []
                page.on("request", lambda q: reqs.append(f"{q.resource_type} {q.method} {q.url[:300]}"))
                page.goto(url, wait_until="networkidle", timeout=60000)
                html = page.content()
                b.close()
            interesting = [q for q in reqs if q.split()[0] in ("xhr", "fetch", "document")
                           or (q.split()[0] == "script" and not re.search(r"squarespace|google|facebook|tiktok|gstatic", q))]
            out.append("--- requests ---\n" + "\n".join(interesting[:120]))
            out.append(f"--- rendered: {len(html)} chars, json-ld events {len(jsonld.parse(html, url, source='diag'))} ---")
            from slclive.sources.venue_page import page_text
            out.append(body_markup(html, START)[:12000])
        except Exception:
            out.append("render error:\n" + traceback.format_exc()[-2000:])
    notice(url[:80], "\n".join(out))


GREP: str | None = None


def scrape(slug: str) -> None:
    env = dict(os.environ, DRY_RUN="1")
    p = subprocess.run([sys.executable, "run_scrapers.py", "--only", slug], env=env,
                       capture_output=True, text=True, timeout=900)
    lines = []
    for ln in p.stdout.splitlines():
        try:   # one compact line per show
            d = __import__("json").loads(ln)
            ln = f"{d['starts_at'][:16]} {d['title'][:60]} | {d.get('venue_name')} [{d.get('status')}] {','.join(d.get('genres') or [])}"
        except ValueError:
            pass
        lines.append(ln)
    if GREP:
        lines = [ln for ln in lines if re.search(GREP, ln, re.I)]
    text = f"{len(p.stdout.splitlines())} shows, {len(lines)} matching\n" + "\n".join(lines)[-14000:] \
        + "\n--- stderr ---\n" + p.stderr[-3000:]
    notice(f"scrape {slug}", text)


def db_report() -> None:
    """Upcoming shows per venue and status, plus the latest run of each source."""
    from collections import Counter
    from datetime import datetime
    from slclive.db import DB
    from slclive.normalize import TZ
    db = DB(dry_run=False)
    rows, offset = [], 0
    while True:
        page = db._get("events", {"select": "venue_name,status,sources", "starts_at": f"gte.{datetime.now(TZ).isoformat()}",
                                  "limit": 1000, "offset": offset})
        rows += page
        if len(page) < 1000:
            break
        offset += 1000
    c = Counter((r["venue_name"], r["status"]) for r in rows)
    lines = [f"{n:4} {v} [{st}]" for (v, st), n in sorted(c.items(), key=lambda x: x[0][0].lower())]
    runs = db._get("source_runs", {"select": "source,ok,found,inserted,error,ran_at", "order": "ran_at.desc", "limit": 400})
    seen, rl = set(), []
    for r in runs:
        if r["source"] in seen:
            continue
        seen.add(r["source"])
        rl.append(f"{r['source']}: ok={r['ok']} found={r['found']} new={r['inserted']} {r['ran_at'][:16]} {(r['error'] or '')[:150]}")
    notice("db", f"{len(rows)} upcoming\n" + "\n".join(lines) + "\n--- latest runs ---\n" + "\n".join(sorted(rl)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", action="append", default=[])
    ap.add_argument("--render", action="store_true")
    ap.add_argument("--scrape", action="append", default=[])
    ap.add_argument("--grep", help="with --scrape, keep only output lines matching this pattern")
    ap.add_argument("--db", action="store_true", help="report what the database holds")
    ap.add_argument("--start", help="show page markup from the first occurrence of this text")
    a = ap.parse_args()
    global START, GREP
    START, GREP = a.start, a.grep
    for u in a.url:
        check_url(u, a.render)
    for s in a.scrape:
        scrape(s)
    if a.db:
        db_report()


if __name__ == "__main__":
    main()
