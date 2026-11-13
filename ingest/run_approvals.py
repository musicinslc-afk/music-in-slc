"""Weekly approval email: lists every show waiting in the review queue.

Sent to the musicinslc inbox every Tuesday so emailed and submitted shows get approved
before the weekend. Each upcoming pending show is listed by night with its venue, where it
came from, who sent it and any notes, followed by a link to the admin review queue. Shows
whose date has already passed are counted separately so they can be rejected in bulk.

Sent from the inbox to itself over Gmail SMTP with the same app password the inbox reader
uses. It carries the digest header, so the inbox reader skips it.

Usage:
    python run_approvals.py
    DRY_RUN=1 python run_approvals.py     # print the email instead of sending it
"""
from __future__ import annotations

import smtplib
import sys
from datetime import datetime, timezone
from email.message import EmailMessage
from zoneinfo import ZoneInfo

from slclive import settings
from slclive.db import DB
from run_digest import DIGEST_HEADER

LOCAL = ZoneInfo("America/Denver")

SOURCE_LABELS = {"email": "Emailed", "submission": "Submitted on the site"}


def _when(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(LOCAL)


def _source(row: dict) -> str:
    src = row.get("source") or ""
    return SOURCE_LABELS.get(src) or SOURCE_LABELS.get(src.split(":", 1)[0]) or src


def build(rows: list[dict], now: datetime | None = None) -> tuple[str, str]:
    now = now or datetime.now(timezone.utc)
    upcoming = sorted((r for r in rows if _when(r["starts_at"]) >= now), key=lambda r: r["starts_at"])
    past = len(rows) - len(upcoming)
    admin = f"{settings.SITE_URL.rstrip('/')}/admin.html"

    lines: list[str] = []
    if upcoming:
        lines.append(f"{len(upcoming)} upcoming show{'s' if len(upcoming) != 1 else ''} waiting for your approval.")
        lines.append(f"Approve or reject them here: {admin}")
        lines.append("")
        night = None
        for r in upcoming:
            when = _when(r["starts_at"])
            day = when.strftime("%A, %B %-d")
            if day != night:
                lines.append(day.upper())
                night = day
            lines.append(f"  {when.strftime('%-I:%M %p')}  {r['title']} at {r['venue_name']}")
            detail = [_source(r)]
            who = r.get("submitter_name") or r.get("submitter_email")
            if who:
                detail.append(f"from {who}")
            lines.append("      " + ", ".join(detail))
            if r.get("submitter_notes"):
                lines.append(f"      Notes: {r['submitter_notes'].strip()[:200]}")
            link = r.get("ticket_url") or r.get("source_url")
            if link:
                lines.append(f"      {link}")
            lines.append("")
    else:
        lines.append("Nothing is waiting for approval this week.")
        lines.append("")
    if past:
        lines.append(f"{past} pending show{'s have' if past != 1 else ' has'} already passed and can be rejected.")
        lines.append("")
    lines.append(f"Admin page: {admin}")

    subject = (f"Music in SLC: {len(upcoming)} show{'s' if len(upcoming) != 1 else ''} to approve" if upcoming
               else "Music in SLC: no shows to approve this week")
    return subject, "\n".join(lines)


def main() -> int:
    if not (settings.SUPABASE_URL and settings.SUPABASE_SERVICE_KEY):
        print("SUPABASE_URL and SUPABASE_SERVICE_KEY are needed to build the approval email", file=sys.stderr)
        return 1
    reader = DB(dry_run=False)
    rows = reader._get("events", {
        "select": "title,venue_name,starts_at,source,source_url,ticket_url,"
                  "submitter_name,submitter_email,submitter_notes",
        "status": "eq.pending", "order": "starts_at", "limit": 1000,
    })
    subject, body = build(rows)
    if settings.DRY_RUN or not settings.INBOX_APP_PASSWORD:
        print(subject + "\n\n" + body)
        return 0
    msg = EmailMessage()
    msg["From"] = f"Music in SLC <{settings.INBOX_ADDRESS}>"
    msg["To"] = settings.APPROVALS_TO or settings.INBOX_ADDRESS
    msg["Subject"] = subject
    msg[DIGEST_HEADER] = "approvals"
    msg.set_content(body)
    with smtplib.SMTP_SSL(settings.INBOX_SMTP_HOST, 465) as smtp:
        smtp.login(settings.INBOX_ADDRESS, settings.INBOX_APP_PASSWORD)
        smtp.send_message(msg)
    print(f"sent: {subject}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
