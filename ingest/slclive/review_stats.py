"""What the last few weeks of review decisions say: why shows were rejected, which sources
keep sending things that aren't music, and which senders are always approved as sent.

Only decisions made by a person in the admin page count (reviewed_at is set there), so the
scrapers' own filtering doesn't skew the numbers."""
from __future__ import annotations

from collections import Counter, defaultdict

REASON_LABELS = {
    "approved": "Published as sent",
    "approved_edited": "Published after a fix",
    "not_music": "Not music",
    "outside_county": "Outside the county",
    "duplicate": "Already listed",
    "wrong_details": "Wrong or missing details",
    "private": "Private event",
    "spam": "Spam or promo",
    "other": "Other",
}
EDIT_LABELS = {"date_time": "date or time", "ticket_link": "ticket link", "band_link": "band link"}

TRUST_AFTER = 3        # approvals as sent, with nothing rejected, before a sender is suggested
MUSIC_ONLY_AFTER = 3   # "not music" rejections at one venue before music_only is suggested


def _source(row: dict) -> str:
    src = (row.get("source") or "").split(":", 1)[0]
    return {"email": "email", "submission": "the submit form"}.get(src, src or "unknown")


def summarize(rows: list[dict], days: int) -> list[str]:
    """Plain-text lines for an email. Empty when nothing was reviewed in the window."""
    rows = [r for r in rows if r.get("review_reason")]
    if not rows:
        return []
    reasons = Counter(r["review_reason"] for r in rows)
    lines = [f"YOUR LAST {days} DAYS OF REVIEWS ({len(rows)} shows)"]
    for key in REASON_LABELS:
        if reasons.get(key):
            lines.append(f"  {REASON_LABELS[key]}: {reasons[key]}")

    not_music = [r for r in rows if r["review_reason"] == "not_music"]
    if not_music:
        by_source = Counter(_source(r) for r in not_music).most_common(3)
        lines.append("  Not music came mostly from: " + ", ".join(f"{s} ({n})" for s, n in by_source))

    edits = Counter(e for r in rows if r["review_reason"] == "approved_edited" for e in (r.get("review_edits") or []))
    if edits:
        lines.append("  Most common fixes: " + ", ".join(f"{EDIT_LABELS.get(e, e.replace('_', ' '))} ({n})"
                                                       for e, n in edits.most_common(3)))

    tips = []
    venues = Counter(r.get("venue_name") for r in not_music if r.get("venue_name"))
    for venue, n in venues.most_common():
        if n >= MUSIC_ONLY_AFTER:
            tips.append(f"  {venue} had {n} shows that weren't music. Consider music_only: true for it in venues.yaml.")

    senders: dict[str, Counter] = defaultdict(Counter)
    for r in rows:
        if _source(r) == "email" and r.get("submitter_email"):
            senders[r["submitter_email"].lower()][r["review_reason"]] += 1
    for sender, c in sorted(senders.items()):
        clean = c.get("approved", 0)
        if clean >= TRUST_AFTER and sum(c.values()) == clean:
            tips.append(f"  {sender}: {clean} shows approved as sent, none rejected. Consider adding it to TRUSTED_SENDERS.")

    notes = [r for r in rows if r.get("review_notes") and r["review_reason"] != "approved"][:8]
    if tips:
        lines += ["", "SUGGESTIONS"] + tips
    if notes:
        lines += ["", "YOUR NOTES"]
        lines += [f"  {r.get('title', '')[:60]}: {r['review_notes'].strip()[:160]}" for r in notes]
    lines.append("")
    return lines
