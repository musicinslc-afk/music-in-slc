"""Read the musicinslc@gmail.com inbox and turn show announcements into listings.

Connects over IMAP with a Gmail app password (no OAuth tokens to expire), reads mail from
the last INBOX_LOOKBACK_DAYS days without marking it read, and sends each new message's
text and flyer images to the AI reader. Shows land in the review queue on the admin page,
except mail from TRUSTED_SENDERS, which publishes directly.

Usage:
    python run_email.py
    DRY_RUN=1 python run_email.py     # print extracted shows, write nothing
"""
from __future__ import annotations

import email
import imaplib
import json
import sys
from datetime import datetime, timedelta
from email.header import decode_header, make_header
from email.message import Message
from email.utils import parseaddr

from bs4 import BeautifulSoup

from slclive import ai_extract, enrich, settings
from slclive.db import DB
from slclive.normalize import load_venues, resolve

IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
MAX_IMAGE_BYTES = 4_500_000
MAX_MESSAGES_PER_RUN = 60


def _decode(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def message_parts(msg: Message) -> tuple[str, list[tuple[str, bytes]]]:
    """Return (plain text, [(media_type, bytes)]) for a message, preferring text/plain."""
    plain, html, images = [], [], []
    for part in msg.walk():
        ctype = part.get_content_type()
        if part.is_multipart():
            continue
        payload = part.get_payload(decode=True) or b""
        if ctype in IMAGE_TYPES and 2_000 < len(payload) <= MAX_IMAGE_BYTES:
            images.append((ctype, payload))
        elif ctype == "text/plain" and part.get_content_disposition() != "attachment":
            plain.append(payload.decode(part.get_content_charset() or "utf-8", "replace"))
        elif ctype == "text/html" and part.get_content_disposition() != "attachment":
            soup = BeautifulSoup(payload.decode(part.get_content_charset() or "utf-8", "replace"), "html.parser")
            for a in soup.find_all("a", href=True):
                a.append(f" [{a['href']}]")
            html.append(soup.get_text("\n"))
    text = "\n".join(plain) if plain else "\n".join(html)
    return text.strip(), images


def is_trusted(sender: str) -> bool:
    sender = sender.lower()
    return any(sender == t or (t.startswith("@") and sender.endswith(t)) for t in settings.TRUSTED_SENDERS)


def main() -> int:
    if not settings.INBOX_APP_PASSWORD:
        print("INBOX_APP_PASSWORD is not set; skipping inbox", file=sys.stderr)
        return 0
    if not ai_extract.available():
        print("ANTHROPIC_API_KEY is not set; the inbox reader needs it", file=sys.stderr)
        return 1

    db = DB()
    venues = list(load_venues())
    db.sync_venues(venues)

    imap = imaplib.IMAP4_SSL(settings.INBOX_IMAP_HOST)
    imap.login(settings.INBOX_ADDRESS, settings.INBOX_APP_PASSWORD)
    imap.select("INBOX", readonly=True)
    since = (datetime.now() - timedelta(days=settings.INBOX_LOOKBACK_DAYS)).strftime("%d-%b-%Y")
    _, data = imap.search(None, f'(SINCE "{since}")')
    ids = data[0].split()[-MAX_MESSAGES_PER_RUN:]

    total = 0
    for num in ids:
        _, hdr = imap.fetch(num, "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
        header_bytes = hdr[0][1] if hdr and isinstance(hdr[0], tuple) else b""
        message_id = email.message_from_bytes(header_bytes).get("Message-ID", "").strip() or f"imap-{num.decode()}"
        if db.email_processed(message_id):
            continue
        _, raw = imap.fetch(num, "(BODY.PEEK[])")
        msg = email.message_from_bytes(raw[0][1])
        subject = _decode(msg.get("Subject"))
        sender = parseaddr(_decode(msg.get("From")))[1]
        text, images = message_parts(msg)
        if not text and not images or msg.get("X-MusicInSLC-Digest"):   # empty, or our own weekly digest
            db.mark_email(message_id, subject, sender, 0)
            continue

        trusted = is_trusted(sender)
        try:
            shows = ai_extract.extract(
                f"Subject: {subject}\nFrom: {sender}\n\n{text}",
                images=images,
                source="email",
                status="published" if trusted else "pending",
                context="This is an email sent to a local concert calendar's inbox. It may be a venue "
                        "newsletter, a band asking to be listed, a forwarded flyer, or unrelated mail.",
            )
        except Exception as e:
            print(f"FAIL {subject[:60]!r}: {type(e).__name__}: {e}", file=sys.stderr)
            continue  # not marked processed, so it is retried next run

        kept = 0
        for raw_show in shows:
            show = resolve(raw_show, venues)
            if not show:
                continue
            show.submitter_email = sender
            show.submitter_notes = f"From email: {subject}"[:500]
            enrich.fill_genres(show)
            kept += 1
            if db.dry_run:
                print(json.dumps({k: v for k, v in show.to_row().items() if v not in (None, [], "")}, default=str))
            else:
                db.upsert_show(show)
        db.mark_email(message_id, subject, sender, kept)
        total += kept
        print(f"ok   {subject[:60]!r} from {sender}: {kept} shows{' (trusted)' if trusted else ''}", file=sys.stderr)

    imap.logout()
    db.log_run("email", True, found=total, inserted=db.stats["inserted"], updated=db.stats["updated"])
    print(f"done: {total} shows from email", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
