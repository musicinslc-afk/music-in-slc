"""Runtime settings, all read from environment variables (GitHub Actions secrets in production)."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # ingest/
REPO = ROOT.parent                                     # repo root
CONFIG_DIR = ROOT / "config"
GENRES_FILE = REPO / "web" / "genres.json"

TIMEZONE = "America/Denver"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

TICKETMASTER_API_KEY = os.environ.get("TICKETMASTER_API_KEY", "")
LASTFM_API_KEY = os.environ.get("LASTFM_API_KEY", "")
SEATGEEK_CLIENT_ID = os.environ.get("SEATGEEK_CLIENT_ID", "")

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-5-5")

INBOX_ADDRESS = os.environ.get("INBOX_ADDRESS", "musicinslc@gmail.com")
INBOX_APP_PASSWORD = os.environ.get("INBOX_APP_PASSWORD", "")
INBOX_IMAP_HOST = os.environ.get("INBOX_IMAP_HOST", "imap.gmail.com")
INBOX_SMTP_HOST = os.environ.get("INBOX_SMTP_HOST", "smtp.gmail.com")
# Where the weekly digest goes; the inbox itself by default
DIGEST_TO = os.environ.get("DIGEST_TO", "")
INBOX_LOOKBACK_DAYS = int(os.environ.get("INBOX_LOOKBACK_DAYS", "14"))
# Comma-separated sender addresses or domains whose shows publish without review,
# e.g. "booking@kilbycourt.com,@thestateroompresents.com"
TRUSTED_SENDERS = [s.strip().lower() for s in os.environ.get("TRUSTED_SENDERS", "").split(",") if s.strip()]

SITE_URL = os.environ.get("SITE_URL", "https://example.com")
CONTACT_EMAIL = os.environ.get("CONTACT_EMAIL", INBOX_ADDRESS)
USER_AGENT = f"SLCLiveBot/1.0 (+{SITE_URL}; {CONTACT_EMAIL})"

# Salt Lake County, centered on downtown SLC
GEO_LAT, GEO_LNG, GEO_RADIUS_MILES = 40.66, -111.92, 22

SALT_LAKE_COUNTY_CITIES = {
    "salt lake city", "south salt lake", "west valley city", "west valley", "west jordan",
    "south jordan", "sandy", "draper", "murray", "midvale", "taylorsville", "holladay",
    "cottonwood heights", "millcreek", "riverton", "herriman", "bluffdale", "magna",
    "kearns", "alta", "brighton", "copperton", "white city", "emigration canyon",
}
# Note: North Salt Lake is in Davis County and is intentionally excluded.

DRY_RUN = os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes")
