"""Supabase access over its REST API (PostgREST) using the service-role key.
Merges incoming shows with what is already stored so several sources reporting the
same show produce one listing."""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta
from typing import Iterable, Optional

import requests

from . import settings
from .links import KINDS, artist_key, clean_links
from .models import Show
from .normalize import TZ, Venue, similar

FUZZY_THRESHOLD = 0.82


class DB:
    def __init__(self, url: str = settings.SUPABASE_URL, key: str = settings.SUPABASE_SERVICE_KEY,
                 dry_run: bool = settings.DRY_RUN):
        self.dry_run = dry_run or not (url and key)
        self.base = f"{url}/rest/v1"
        self.s = requests.Session()
        self.s.headers.update({
            "apikey": key, "Authorization": f"Bearer {key}",
            "Content-Type": "application/json", "Prefer": "return=representation",
        })
        self._existing: Optional[dict[str, dict]] = None
        self._artists: Optional[dict[str, dict]] = None
        self.url = url
        self.stats = {"inserted": 0, "updated": 0}

    # -- low level ---------------------------------------------------------
    def _get(self, table: str, params: dict) -> list[dict]:
        if self.dry_run:
            return []
        r = self.s.get(f"{self.base}/{table}", params=params, timeout=60)
        r.raise_for_status()
        return r.json()

    def _post(self, table: str, rows, params: dict | None = None, prefer: str | None = None) -> list[dict]:
        if self.dry_run:
            return rows if isinstance(rows, list) else [rows]
        headers = {"Prefer": prefer} if prefer else {}
        r = self.s.post(f"{self.base}/{table}", json=rows, params=params or {}, headers=headers, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"{table} insert failed: {r.status_code} {r.text[:300]}")
        return r.json() if r.text else []

    def _patch(self, table: str, match: dict, values: dict) -> None:
        if self.dry_run:
            return
        r = self.s.patch(f"{self.base}/{table}", params={k: f"eq.{v}" for k, v in match.items()},
                         json=values, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"{table} update failed: {r.status_code} {r.text[:300]}")

    # -- venues ------------------------------------------------------------
    def sync_venues(self, venues: Iterable[Venue]) -> None:
        venues = list(venues)
        rows = self._post("venues", [v.to_row() for v in venues], params={"on_conflict": "slug"},
                          prefer="resolution=merge-duplicates,return=representation")
        ids = {r["slug"]: r.get("id") for r in rows}
        for v in venues:
            v.id = ids.get(v.slug)

    # -- source health -----------------------------------------------------
    def last_hash(self, source: str) -> Optional[str]:
        rows = self._get("source_runs", {"source": f"eq.{source}", "ok": "eq.true",
                                          "content_hash": "not.is.null", "order": "ran_at.desc", "limit": 1,
                                          "select": "content_hash"})
        return rows[0]["content_hash"] if rows else None

    def log_run(self, source: str, ok: bool, found: int = 0, inserted: int = 0, updated: int = 0,
                error: str | None = None, content_hash: str | None = None) -> None:
        self._post("source_runs", {"source": source, "ok": ok, "found": found, "inserted": inserted,
                                   "updated": updated, "error": (error or "")[:1000] or None,
                                   "content_hash": content_hash}, prefer="return=minimal")

    def latest_runs(self, limit: int = 600) -> list[dict]:
        """The most recent run of each source."""
        rows = self._get("source_runs", {"select": "source,ok,found,inserted,error,ran_at",
                                          "order": "ran_at.desc", "limit": limit})
        seen, out = set(), []
        for r in rows:
            if r["source"] not in seen:
                seen.add(r["source"])
                out.append(r)
        return out

    def upcoming_venue_dates(self, until: datetime) -> list[dict]:
        """venue_id and starts_at of every published show from now until `until`."""
        rows, offset = [], 0
        while True:
            page = self._get("events", {"select": "venue_id,starts_at", "status": "eq.published",
                                        "starts_at": f"gte.{datetime.now(TZ).isoformat(timespec='seconds')}",
                                        "and": f"(starts_at.lte.{until.isoformat(timespec='seconds')})",
                                        "limit": 1000, "offset": offset})
            rows += page
            if len(page) < 1000:
                return rows
            offset += 1000

    # -- emails ------------------------------------------------------------
    def email_processed(self, message_id: str) -> bool:
        return bool(self._get("processed_emails", {"message_id": f"eq.{message_id}", "select": "message_id"}))

    def mark_email(self, message_id: str, subject: str, sender: str, shows_found: int) -> None:
        self._post("processed_emails", {"message_id": message_id, "subject": subject[:300],
                                        "sender": sender[:200], "shows_found": shows_found},
                   params={"on_conflict": "message_id"}, prefer="resolution=ignore-duplicates,return=minimal")

    # -- events ------------------------------------------------------------
    def _load_existing(self) -> dict[str, dict]:
        if self._existing is None:
            since = (datetime.now(TZ) - timedelta(days=2)).isoformat()
            rows, offset = [], 0
            while True:
                page = self._get("events", {
                    "select": "id,fingerprint,title,artists,venue_name,starts_at,status,sources,genres,raw_genres,"
                              "price_min,price_max,ticket_url,image_url,image_kind,description,age_restriction,"
                              "doors_at,venue_id,city,is_free,artist_url,source_url",
                    # rejected rows are loaded too, so a show an admin hid is never re-added
                    "starts_at": f"gte.{since}",
                    "order": "starts_at.asc", "limit": 1000, "offset": offset,
                })
                rows += page
                if len(page) < 1000:
                    break
                offset += 1000
            self._existing = {r["fingerprint"]: r for r in rows}
        return self._existing

    def _find_match(self, show: Show) -> Optional[dict]:
        existing = self._load_existing()
        if show.fingerprint in existing:
            return existing[show.fingerprint]
        venue_part, day, head = show.fingerprint.split("|", 2)
        for fp, row in existing.items():
            parts = fp.split("|", 2)
            if len(parts) == 3 and parts[0] == venue_part and parts[1] == day and similar(parts[2], head) >= FUZZY_THRESHOLD:
                return row
        return None

    def retire_unseen(self, source: str, before: datetime) -> int:
        """Remove upcoming shows that only `source` ever reported and that its latest complete
        read no longer lists: taken off the calendar, or older duplicates of a listing the
        source now reports differently. Removed rather than hidden, so a show that comes back
        is listed again; shows an admin hid are never touched. Returns how many were removed."""
        if self.dry_run:
            return 0
        r = self.s.delete(f"{self.base}/events", params={
            "sources": f'cd.{{"{source}"}}', "status": "eq.published",
            "last_seen_at": f"lt.{before.isoformat(timespec='seconds')}",
            "starts_at": f"gt.{datetime.now(TZ).isoformat(timespec='seconds')}",
        }, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"events delete failed: {r.status_code} {r.text[:300]}")
        removed = r.json() if r.text else []
        existing = self._load_existing()
        for row in removed:
            existing.pop(row.get("fingerprint"), None)
        return len(removed)

    def upsert_show(self, show: Show) -> str:
        """Insert or merge one show. Returns 'inserted', 'updated' or 'unchanged'."""
        match = self._find_match(show)
        row = show.to_row()
        row["last_seen_at"] = datetime.now(TZ).isoformat()
        if not match:
            created = self._post("events", row, params={"on_conflict": "fingerprint"},
                                 prefer="resolution=merge-duplicates,return=representation")
            stored = created[0] if created else row
            self._load_existing()[show.fingerprint] = stored
            self.stats["inserted"] += 1
            return "inserted"

        changes: dict = {"last_seen_at": row["last_seen_at"]}
        # Fill blanks, never overwrite what an admin or earlier source already set
        for k in ("price_min", "price_max", "ticket_url", "description", "age_restriction",
                  "doors_at", "venue_id", "city", "artist_url"):
            if row.get(k) not in (None, "", []) and match.get(k) in (None, "", []):
                changes[k] = row[k]
        # An image fills a blank, and a flyer replaces an artist photo. An unreviewed email
        # can't change the picture on a show that is already public.
        unreviewed = row["status"] == "pending" and match.get("status") == "published"
        if row.get("image_url") and not unreviewed and row["image_url"] != match.get("image_url") and (
                not match.get("image_url") or (row.get("image_kind") == "flyer" and match.get("image_kind") != "flyer")):
            changes["image_url"] = row["image_url"]
            changes["image_kind"] = row.get("image_kind")
        if row.get("genres") and not match.get("genres"):
            changes["genres"] = row["genres"]
        if row.get("artists") and len(row["artists"]) > len(match.get("artists") or []):
            changes["artists"] = row["artists"]
        merged_raw = sorted(set(match.get("raw_genres") or []) | set(row.get("raw_genres") or []))
        if merged_raw != sorted(match.get("raw_genres") or []):
            changes["raw_genres"] = merged_raw
        sources = sorted(set(match.get("sources") or []) | {show.source})
        if sources != sorted(match.get("sources") or []):
            changes["sources"] = sources
        # A trusted scraper confirming a pending email/submission publishes it
        if match.get("status") == "pending" and row["status"] == "published":
            changes["status"] = "published"
        if row["status"] == "cancelled" and match.get("status") != "cancelled":
            changes["status"] = "cancelled"

        if len(changes) == 1:
            if "id" in match:
                self._patch("events", {"id": match["id"]}, changes)
            return "unchanged"
        if "id" in match:
            self._patch("events", {"id": match["id"]}, changes)
        match.update(changes)
        self.stats["updated"] += 1
        return "updated"

    # -- flyers ------------------------------------------------------------
    def shows_missing_images(self, limit: int, days_ahead: int = 365,
                             recheck_hosts: tuple[str, ...] = (), checked_before: Optional[str] = None) -> list[dict]:
        """Upcoming published shows with no image: pages on recheck_hosts checked before checked_before (when a
        site rule was added), then pages never checked, then pages last checked more than two weeks ago."""
        now = datetime.now(TZ)
        window = f"(starts_at.lte.{(now + timedelta(days=days_ahead)).isoformat(timespec='seconds')})"
        base = {
            "select": "id,title,artists,source_url,ticket_url,starts_at",
            "status": "eq.published", "image_url": "is.null",
            "starts_at": f"gte.{now.isoformat(timespec='seconds')}",
            "and": window, "order": "starts_at.asc", "limit": limit,
        }
        rows = []
        if recheck_hosts and checked_before:
            hosts = ",".join(f"source_url.ilike.*{h}*" for h in recheck_hosts)
            rows = self._get("events", {**base, "image_checked_at": f"lt.{checked_before}", "or": f"({hosts})"})
        if len(rows) < limit:
            rows += self._get("events", {**base, "image_checked_at": "is.null", "limit": limit - len(rows)})
        # Flyers often go up after a show is announced, so a page with nothing is read again every two weeks
        if len(rows) < limit:
            seen = {r["id"] for r in rows}
            stale = (now - timedelta(days=14)).isoformat(timespec="seconds")
            more = self._get("events", {**base, "image_checked_at": f"lt.{stale}", "limit": limit - len(rows)})
            rows += [r for r in more if r["id"] not in seen]
        return rows

    def shows_with_image(self, url: str) -> list[dict]:
        return self._get("events", {"select": "title,artists", "image_url": f"eq.{url}", "limit": 10})

    def set_image(self, event_id: str, url: Optional[str], kind: Optional[str]) -> None:
        values = {"image_checked_at": datetime.now(TZ).isoformat()}
        if url:
            values.update(image_url=url, image_kind=kind)
        self._patch("events", {"id": event_id}, values)

    def upload_flyer(self, data: bytes, media_type: str) -> Optional[str]:
        """Store an emailed flyer in the public 'flyers' bucket; returns its public address."""
        if self.dry_run:
            return None
        ext = {"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"}.get(media_type, "img")
        name = f"{hashlib.sha256(data).hexdigest()[:24]}.{ext}"
        r = self.s.post(f"{self.url}/storage/v1/object/flyers/{name}", data=data, timeout=60,
                        headers={"Content-Type": media_type, "x-upsert": "true", "Prefer": ""})
        if r.status_code >= 400:
            raise RuntimeError(f"flyer upload failed: {r.status_code} {r.text[:300]}")
        return f"{self.url}/storage/v1/object/public/flyers/{name}"

    # -- band links --------------------------------------------------------
    def artists(self) -> dict[str, dict]:
        if self._artists is None:
            rows, offset = [], 0
            while True:
                page = self._get("artists", {"select": "key,name,homepage,links,source,locked,checked_at",
                                             "order": "key.asc", "limit": 1000, "offset": offset})
                rows += page
                if len(page) < 1000:
                    break
                offset += 1000
            self._artists = {r["key"]: r for r in rows}
        return self._artists

    def save_artist(self, name: str, links: dict, source: str, checked: bool = False) -> bool:
        """Add band links for `name`, filling kinds it doesn't have yet. An admin-locked artist is
        never changed. `checked` records a MusicBrainz lookup even when nothing was found.
        Returns True when something was written."""
        key = artist_key(name)
        if not key:
            return False
        links = clean_links(links or {})
        current = self.artists().get(key)
        if current and current.get("locked"):
            return False
        have = dict(current.get("links") or {}) if current else {}
        if current and current.get("homepage"):
            have["homepage"] = current["homepage"]
        merged = {**links, **have}
        merged = {k: merged[k] for k in KINDS if k in merged}
        if current and merged == have and not checked:
            return False
        if not current and not merged and not checked:
            return False
        row = {
            "key": key, "name": (current or {}).get("name") or name,
            "homepage": merged.pop("homepage", None), "links": merged,
            "source": (current or {}).get("source") if current and have else source,
        }
        if checked:
            row["checked_at"] = datetime.now(TZ).isoformat()
        elif current and current.get("checked_at"):
            row["checked_at"] = current["checked_at"]
        self._post("artists", row, params={"on_conflict": "key"}, prefer="resolution=merge-duplicates,return=minimal")
        self.artists()[key] = {**(current or {}), **row}
        return True
