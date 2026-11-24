"""Weekly digest: emails the musicinslc inbox a short report on coverage and source health.

Lists venues the coverage watchdog flagged (no upcoming shows where some are expected),
sources whose last run failed, and how many shows wait in the review queue. Sent from the
inbox to itself over Gmail SMTP with the same app password the inbox reader uses; the inbox
reader recognizes the digest by its header and skips it.

Usage:
    python run_digest.py
    DRY_RUN=1 python run_digest.py     # print the digest instead of sending it
"""
from __future__ import annotations

import smtplib
import sys
from email.message import EmailMessage

from datetime import datetime, timedelta

from slclive import quality, settings
from slclive.db import DB
from slclive.normalize import TZ

DIGEST_HEADER = "X-MusicInSLC-Digest"


def build(runs: list[dict], pending: int, listings: dict[str, list[str]] | None = None) -> tuple[str, str]:
    gaps = sorted((r for r in runs if r["source"].startswith("coverage:") and not r["ok"]), key=lambda r: r["source"])
    failing = sorted((r for r in runs if not r["source"].startswith("coverage:") and not r["ok"]),
                     key=lambda r: r["source"])
    lines = []
    if gaps:
        lines.append("Venues with no upcoming shows where some are expected:")
        lines += [f"  - {r['source'].split(':', 1)[1]}: {r['error'] or ''}" for r in gaps]
        lines.append("")
    if failing:
        lines.append("Sources whose last run failed:")
        lines += [f"  - {r['source']} ({r['ran_at'][:10]}): {(r['error'] or '')[:200]}" for r in failing]
        lines.append("")
    listing_problems = 0
    for kind, found in (listings or {}).items():
        if found:
            listing_problems += len(found)
            lines.append(quality.HEADINGS[kind])
            lines += [f"  - {f}" for f in found[:40]]
            if len(found) > 40:
                lines.append(f"  ...and {len(found) - 40} more")
            if kind == "not_music":
                lines.append("  These are already on the calendar, so they aren't in the review queue."
                             " Hide one under Published shows on the admin page.")
            lines.append("")
    lines.append(f"Shows waiting for review: {pending}")
    lines.append("")
    lines.append(f"Admin page: {settings.SITE_URL.rstrip('/')}/admin.html")
    problems = len(gaps) + len(failing) + listing_problems
    subject = (f"Music in SLC weekly check: {problems} to look at" if problems
               else "Music in SLC weekly check: all sources and listings healthy")
    return subject, "\n".join(lines)


def main() -> int:
    db = DB()
    if db.dry_run and not (settings.SUPABASE_URL and settings.SUPABASE_SERVICE_KEY):
        print("SUPABASE_URL and SUPABASE_SERVICE_KEY are needed to build the digest", file=sys.stderr)
        return 1
    reader = DB(dry_run=False)
    runs = reader.latest_runs()
    pending = len(reader._get("events", {"select": "id", "status": "eq.pending", "limit": 1000}))
    now = datetime.now(TZ)
    rows = reader._get("events", {"select": "title,artists,venue_name,starts_at,status,fingerprint",
                                  "status": "eq.published", "starts_at": f"gte.{now.isoformat(timespec='seconds')}",
                                  "and": f"(starts_at.lte.{(now + timedelta(days=60)).isoformat(timespec='seconds')})",
                                  "order": "starts_at.asc", "limit": 5000})
    subject, body = build(runs, pending, quality.check(rows))
    if settings.DRY_RUN or not settings.INBOX_APP_PASSWORD:
        print(subject + "\n\n" + body)
        return 0
    msg = EmailMessage()
    msg["From"] = settings.INBOX_ADDRESS
    msg["To"] = settings.DIGEST_TO or settings.INBOX_ADDRESS
    msg["Subject"] = subject
    msg[DIGEST_HEADER] = "1"
    msg.set_content(body)
    with smtplib.SMTP_SSL(settings.INBOX_SMTP_HOST, 465) as smtp:
        smtp.login(settings.INBOX_ADDRESS, settings.INBOX_APP_PASSWORD)
        smtp.send_message(msg)
    print(f"sent: {subject}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
