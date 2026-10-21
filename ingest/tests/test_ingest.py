"""Run with:  python -m unittest discover -s tests   (or pytest, if installed)."""
import os
import sys
import unittest
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("DRY_RUN", "1")

from slclive.db import DB  # noqa: E402
from slclive.genres import map_genres  # noqa: E402
from slclive.models import Show  # noqa: E402
from slclive.normalize import TZ, headliner_key, load_venues, match_venue, parse_dt, resolve, split_artists  # noqa: E402
import json  # noqa: E402

from slclive.sources import jsonld, krcl, seatgeek, stateroom, ticketmaster, ticketsauce  # noqa: E402
from slclive.sources.venue_parsers import hogwallow, next_date, parse_clock, soundwell  # noqa: E402
from slclive import coverage  # noqa: E402
from datetime import date, timedelta  # noqa: E402
import run_email  # noqa: E402
import run_digest  # noqa: E402


class TestJsonLd(unittest.TestCase):
    def setUp(self):
        html = (HERE / "fixtures" / "venue_jsonld.html").read_text()
        self.shows = jsonld.parse(html, "https://kilbycourt.com/", "venue:kilby-court", default_venue="Kilby Court")

    def test_finds_events_and_skips_dateless(self):
        self.assertEqual(len(self.shows), 2)

    def test_fields(self):
        s = self.shows[0]
        self.assertEqual(s.artists, ["Sun Valley Static", "Paper Kites Local", "Junebug"])
        self.assertEqual(s.price_min, 18.0)
        self.assertEqual(s.ticket_url, "https://kilbycourt.com/tickets/sun-valley-static")
        self.assertEqual(s.age_restriction, "all_ages")
        self.assertEqual(s.doors_at.hour, 18)
        self.assertEqual(s.starts_at.tzinfo.key if hasattr(s.starts_at.tzinfo, "key") else "", "America/Denver")

    def test_cancelled_and_price_range(self):
        s = self.shows[1]
        self.assertTrue(s.cancelled)
        self.assertEqual((s.price_min, s.price_max), (22.0, 25.0))


class TestMicrodata(unittest.TestCase):
    def setUp(self):
        html = (HERE / "fixtures" / "24tix_event.html").read_text()
        url = "https://www.24tix.com/event/bwdgcmgicrc77lh5edang63i4y"
        self.shows = jsonld.parse(html, url, "venue:kilby-court")

    def test_reads_main_event_and_skips_sidebar_teasers(self):
        self.assertEqual(len(self.shows), 1)
        s = self.shows[0]
        self.assertEqual(s.title, "Kilby Court Halloween")
        self.assertEqual(s.artists, ["Kilby Court Halloween", "BLEACHER BABE", "Stage Fright", "CAMO"])
        self.assertEqual(s.starts_at.astimezone(TZ).strftime("%Y-%m-%d %H:%M"), "2026-10-23 19:00")

    def test_venue_price_age(self):
        s = self.shows[0]
        self.assertEqual(s.venue_name, "Kilby Court")
        self.assertEqual(s.city, "Salt Lake City")
        self.assertEqual((s.price_min, s.price_max), (12.15, 13.99))
        self.assertEqual(s.age_restriction, "all_ages")
        self.assertEqual(s.ticket_url, "https://www.24tix.com/event/bwdgcmgicrc77lh5edang63i4y")
        self.assertIsNone(s.description)  # venue rules are not a show description

    def test_event_links_are_deduplicated(self):
        from slclive.sources import venue_page
        html = ('<a href="https://www.24tix.com/event/abc123">x</a><a href="https://www.24tix.com/events/abc123">y</a>'
                '<a href="https://www.axs.com/events/1/z">z</a><a href="/about">a</a>')
        self.assertEqual(venue_page.event_links(html, "https://kilbycourt.com/"),
                         ["https://www.24tix.com/event/abc123"])

    def test_passes_are_not_shows(self):
        s = Show(title="Golden Ticket 2027", starts_at=parse_dt("2027-01-01"),
                 venue_name="Various Locations in Downtown SLC", source="x")
        self.assertIsNone(resolve(s))


class TestCalendarFeed(unittest.TestCase):
    def setUp(self):
        from slclive.sources import ics
        self.shows = ics.parse((HERE / "fixtures" / "24tix_calendar.ics").read_text(), "feed:24tix")

    def test_reads_upcoming_events_despite_malformed_header(self):
        self.assertEqual([s.title for s in self.shows],
                         ["The Black Angels", "Bayonne - The ‘Filters’ Tour", "Night Market Showcase"])

    def test_room_age_rule_and_time(self):
        s = self.shows[0]
        self.assertEqual(s.venue_name, "Metro Music Hall")
        self.assertEqual(s.age_restriction, "21_plus")
        self.assertEqual(s.starts_at.strftime("%Y-%m-%d %H:%M"), "2099-11-13 19:00")
        self.assertIsNone(s.description)  # 24tix repeats the title as the description

    def test_feed_venues_resolve_and_unknown_ones_are_kept_for_review(self):
        import run_scrapers
        db = DB(dry_run=True)
        resolved = [resolve(s) for s in self.shows]
        self.assertEqual(resolved[0].venue_slug, "metro-music-hall")
        self.assertEqual(resolved[1].artists, ["Bayonne"])
        self.assertIsNone(resolved[2].venue_slug)
        found, _, _ = run_scrapers.store(db, ics_shows := __import__("slclive.sources.ics", fromlist=["parse"]).parse(
            (HERE / "fixtures" / "24tix_calendar.ics").read_text(), "feed:24tix"), list(load_venues()), "feed:24tix",
            dry_run=True, review_unknown_venues=True)
        self.assertEqual(found, 3)
        self.assertEqual([s.status for s in ics_shows], ["published", "published", "pending"])


class TestNormalize(unittest.TestCase):
    def test_split_artists(self):
        self.assertEqual(split_artists("S&S Presents: Mt. Joy with Lily Seabird, Local Natives"),
                         ["Mt. Joy", "Lily Seabird", "Local Natives"])
        self.assertEqual(split_artists("Hall & Oates"), ["Hall & Oates"])
        self.assertEqual(split_artists("Turnstile - Never Enough Tour 2026"), ["Turnstile"])

    def test_headliner_key(self):
        self.assertEqual(headliner_key("The Beths w/ Hand Habits"), "beths")

    def test_venue_aliases(self):
        self.assertEqual(match_venue("The Grand at The Complex SLC - Complex").slug, "the-complex")
        self.assertEqual(match_venue("Utah First Credit Union Amphitheatre (formerly USANA Amphitheatre)").slug,
                         "utah-first-amphitheatre")
        self.assertEqual(match_venue("Urban Lounge").slug, "urban-lounge")
        self.assertIsNone(match_venue("Velour Live Music Gallery"))

    def test_bare_date_gets_evening_time(self):
        self.assertEqual(parse_dt("2026-12-01").hour, 19)

    def test_out_of_county_dropped(self):
        s = Show(title="Band", starts_at=parse_dt("2026-12-01"), venue_name="Velour", city="Provo", source="x")
        self.assertIsNone(resolve(s))

    def test_resolve_fills_venue_and_fingerprint(self):
        s = Show(title="Mt. Joy w/ Lily Seabird", starts_at=parse_dt("2026-12-01T20:00:00-07:00"),
                 venue_name="The State Room", source="x", raw_genres=["Folk", "Indie Rock"])
        s = resolve(s)
        self.assertEqual(s.fingerprint, "the-state-room|2026-12-01|mtjoy")
        self.assertEqual(s.age_restriction, "21_plus")
        self.assertEqual(s.genres[0], "folk")


class TestGenres(unittest.TestCase):
    def test_mapping(self):
        self.assertEqual(map_genres(["Hip-Hop/Rap"]), ["hiphop"])
        self.assertIn("electronic", map_genres(["Dance/Electronic"]))
        self.assertEqual(map_genres(["Dancehall"]), ["world"])
        self.assertEqual(map_genres(["Metalcore", "Rock"]), ["metal", "rock"])
        self.assertEqual(map_genres(["undefined"]), [])

    def test_short_keywords_need_word_boundary(self):
        self.assertNotIn("hiphop", map_genres(["Grapefruit Moon"]))


class TestTicketmaster(unittest.TestCase):
    def test_mapping(self):
        e = {
            "name": "Evanescence", "url": "https://tm.example/e/1",
            "dates": {"start": {"dateTime": "2027-07-25T01:00:00Z"}, "status": {"code": "onsale"}},
            "classifications": [{"genre": {"name": "Rock"}, "subGenre": {"name": "Alternative Rock"}}],
            "priceRanges": [{"min": 39.5, "max": 129}],
            "_embedded": {"venues": [{"name": "Utah First Credit Union Amphitheatre", "city": {"name": "West Valley City"}}],
                          "attractions": [{"name": "Evanescence"}]},
            "images": [{"url": "a.jpg", "width": 100, "ratio": "4_3"}, {"url": "b.jpg", "width": 1024, "ratio": "16_9"}],
        }
        s = ticketmaster._to_show(e)
        self.assertEqual(s.starts_at.astimezone(TZ).strftime("%Y-%m-%d %H:%M"), "2027-07-24 19:00")
        self.assertEqual(s.image_url, "b.jpg")
        s = resolve(s)
        self.assertEqual(s.venue_slug, "utah-first-amphitheatre")
        self.assertIn("indie", s.genres)


class TestEmail(unittest.TestCase):
    def test_html_email_keeps_links_and_images(self):
        msg = EmailMessage()
        msg["Subject"] = "Show at Diabolical Records Friday"
        msg.set_content("plain fallback")
        msg.add_alternative('<p>Free show! <a href="https://tix.example/1">RSVP</a></p>', subtype="html")
        msg.add_attachment(b"\x89PNG" + b"0" * 5000, maintype="image", subtype="png", filename="flyer.png")
        text, images = run_email.message_parts(msg)
        self.assertIn("plain fallback", text)
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0][0], "image/png")

    def test_trusted_senders(self):
        run_email.settings.TRUSTED_SENDERS[:] = ["@thestateroompresents.com", "booking@kilbycourt.com"]
        self.assertTrue(run_email.is_trusted("events@thestateroompresents.com"))
        self.assertTrue(run_email.is_trusted("Booking@kilbycourt.com"))
        self.assertFalse(run_email.is_trusted("someone@gmail.com"))


class TestMerge(unittest.TestCase):
    def test_second_source_merges_into_first(self):
        db = DB(dry_run=True)
        db._existing = {}
        a = resolve(Show(title="The Beths", starts_at=parse_dt("2026-12-05T19:00:00-07:00"),
                         venue_name="Urban Lounge", source="venue:urban-lounge"))
        b = resolve(Show(title="The Beths w/ Hand Habits", starts_at=parse_dt("2026-12-05T20:00:00-07:00"),
                         venue_name="The Urban Lounge SLC", source="ticketmaster", price_min=25.0,
                         image_url="x.jpg"))
        self.assertEqual(db.upsert_show(a), "inserted")
        self.assertEqual(db.upsert_show(b), "updated")
        row = db._existing[a.fingerprint]
        self.assertEqual(row["price_min"], 25.0)
        self.assertEqual(row["sources"], ["ticketmaster", "venue:urban-lounge"])

    def test_fuzzy_headliner_match(self):
        db = DB(dry_run=True)
        db._existing = {}
        a = resolve(Show(title="Gregory Alan Isakov", starts_at=parse_dt("2026-12-09"), venue_name="Eccles Theater", source="a"))
        b = resolve(Show(title="Gregory Alan Isakov (Solo)", starts_at=parse_dt("2026-12-09"), venue_name="Eccles Theater", source="b"))
        db.upsert_show(a)
        self.assertNotEqual(a.fingerprint, b.fingerprint)
        self.assertEqual(db.upsert_show(b), "updated")

    def test_scraper_publishes_pending_email_show(self):
        db = DB(dry_run=True)
        db._existing = {}
        e = resolve(Show(title="Choir Boy", starts_at=parse_dt("2026-12-11"), venue_name="Kilby Court",
                         source="email", status="pending"))
        s = resolve(Show(title="Choir Boy", starts_at=parse_dt("2026-12-11"), venue_name="Kilby Court",
                         source="venue:kilby-court"))
        db.upsert_show(e)
        db.upsert_show(s)
        self.assertEqual(db._existing[e.fingerprint]["status"], "published")

    def test_hidden_show_stays_hidden(self):
        db = DB(dry_run=True)
        a = resolve(Show(title="Lo Velo", starts_at=parse_dt("2026-12-12"), venue_name="Soundwell", source="ticketmaster"))
        db._existing = {a.fingerprint: {"fingerprint": a.fingerprint, "status": "rejected", "sources": ["ticketmaster"]}}
        db.upsert_show(a)
        self.assertEqual(db._existing[a.fingerprint]["status"], "rejected")


class TestStateRoom(unittest.TestCase):
    def setUp(self):
        data = json.loads((HERE / "fixtures" / "stateroom_events.json").read_text())
        self.shows = {s.title: s for s in stateroom.parse(data)}

    def test_reads_events_and_rooms(self):
        self.assertEqual(set(self.shows), {"Powder Blue Ween Tribute", "#IMOMSOHARD", "Pigeons Playing Ping Pong",
                                           "The Jungle Giants"})  # the 2001 show is dropped
        self.assertEqual(self.shows["Powder Blue Ween Tribute"].venue_name, "The State Room")
        self.assertEqual(self.shows["Pigeons Playing Ping Pong"].venue_name, "The Commonwealth Room")
        ween = self.shows["Powder Blue Ween Tribute"]
        self.assertEqual(ween.starts_at, datetime(2099, 10, 23, 19, 0, tzinfo=TZ))
        self.assertEqual(ween.ticket_url, "https://thestateroompresents.com/state-room-presents/ween-tribute")
        self.assertIn("Ween", ween.description)

    def test_eccles_waits_for_review_and_cancelled_is_marked(self):
        self.assertEqual(self.shows["#IMOMSOHARD"].status, "pending")
        self.assertEqual(self.shows["Pigeons Playing Ping Pong"].status, "published")
        self.assertTrue(self.shows["The Jungle Giants"].cancelled)

    def test_resolves_to_known_venues(self):
        venues = list(load_venues())
        r = resolve(self.shows["Pigeons Playing Ping Pong"], venues)
        self.assertEqual(r.venue_slug, "commonwealth-room")


class TestKrcl(unittest.TestCase):
    def setUp(self):
        self.venues = list(load_venues())
        html = (HERE / "fixtures" / "krcl_live_music.html").read_text()
        self.shows = krcl.parse_page(html, self.venues)
        self.by = {s.title: s for s in self.shows}

    def test_titles_drop_venue_and_presenter(self):
        self.assertIn("The Wildwoods", self.by)
        self.assertIn("Gorillaz", self.by)
        self.assertIn("Clejan", self.by)
        self.assertIn("JD McPherson", self.by)
        self.assertNotIn("Old Show", self.by)

    def test_dates_and_times(self):
        self.assertEqual(self.by["Gorillaz"].starts_at, datetime(2099, 10, 20, 19, 30, tzinfo=TZ))
        self.assertEqual(self.by["Fall Harvest Festival"].starts_at, datetime(2099, 10, 24, 11, 0, tzinfo=TZ))

    def test_venues_and_cities(self):
        self.assertEqual(self.by["The Wildwoods"].venue_name, "The Urban Lounge")
        self.assertEqual(self.by["Clejan"].venue_name, "The DLC")
        self.assertEqual(self.by["Kilby Court Halloween: BLEACHER BABE, Stage Fright, CAMO"].venue_name, "Kilby Court")
        self.assertEqual(self.by["JD McPherson"].venue_name, "The Commonwealth Room")
        self.assertEqual(self.by["American West Symphony October Concert"].city, "Sandy")
        self.assertEqual(self.by["Fall Harvest Festival"].city, "Salt Lake City")
        self.assertEqual(self.by["The Wildwoods"].ticket_url, "https://www.24tix.com/event/58221926385")

    def test_outside_county_is_dropped(self):
        shows = [resolve(s, self.venues) for s in self.shows]
        titles = {s.title for s in shows if s}
        self.assertNotIn("2nd Annual Country Christmas Fundraiser Concert", titles)
        self.assertIn("American West Symphony October Concert", titles)


class TestVenueParsers(unittest.TestCase):
    TODAY = date(2026, 10, 21)

    def test_year_rolls_over(self):
        self.assertEqual(next_date(10, 30, self.TODAY), date(2026, 10, 30))
        self.assertEqual(next_date(1, 5, self.TODAY), date(2027, 1, 5))
        self.assertEqual(next_date(10, 18, self.TODAY), date(2026, 10, 18))   # a few days back: same year
        self.assertEqual(parse_clock(" 9:30PM to 12:30AM"), datetime(1, 1, 1, 21, 30).time())
        self.assertEqual(parse_clock("7:00 pm"), datetime(1, 1, 1, 19, 0).time())

    def test_soundwell(self):
        html = (HERE / "fixtures" / "soundwell_events.html").read_text()
        shows = soundwell(html, "https://soundwellslc.com/events/", "Soundwell", "venue:soundwell", today=self.TODAY)
        self.assertEqual(len(shows), 6)
        by = {s.title: s for s in shows}
        medium = by["Medium Build Presents The King of Having Fun on Tour"]
        self.assertEqual(medium.description, "Sold out.")
        self.assertEqual(medium.ticket_url, "https://tixr.com/e/196036")
        self.assertEqual(medium.artists, ["Medium Build"])
        self.assertEqual(by["Raynes and David Wimbish & The Collection"].artists[0], "Raynes")
        burndown = by["BurnDown"]
        self.assertEqual(burndown.artists, ["BurnDown", "Febuary", "Knumears", "Soap Box Derby"])
        self.assertEqual(burndown.doors_at, datetime(2026, 10, 25, 18, 0, tzinfo=TZ))
        self.assertEqual(by["New Constellations: It Comes In Waves Tour"].artists, ["New Constellations", "Vox Rea"])
        resolved = resolve(by["Waterparks"], load_venues())
        self.assertEqual(resolved.venue_slug, "soundwell")
        self.assertEqual(resolved.fingerprint, "soundwell|2026-10-27|waterparks")

    def test_hogwallow(self):
        html = (HERE / "fixtures" / "hogwallow_upcoming.html").read_text()
        shows = hogwallow(html, "https://thehogwallow.com/music/all-upcoming-live-music/", "The Hog Wallow Pub",
                          "venue:hog-wallow", today=self.TODAY)
        self.assertEqual(len(shows), 10)
        first = shows[0]
        self.assertEqual(first.title, "Sarah DeGraw")
        self.assertEqual(first.starts_at, datetime(2026, 10, 21, 21, 0, tzinfo=TZ))
        self.assertEqual(first.source_url, "https://thehogwallow.com/music/live/sarah-degraw1526.html")
        self.assertEqual(first.raw_genres, ["Americana", "Folk"])
        cajun = next(s for s in shows if "Cajun" in s.title)
        self.assertEqual(cajun.title, "J-Rad Cooley & The Cajun Cowboys")
        self.assertEqual(cajun.starts_at, datetime(2026, 10, 30, 21, 30, tzinfo=TZ))
        self.assertEqual(next(s for s in shows if s.title == "Reggae Thursday").starts_at.date(), date(2026, 11, 5))
        resolved = resolve(first, load_venues())
        self.assertEqual((resolved.venue_slug, resolved.city, resolved.age_restriction),
                         ("hog-wallow", "Cottonwood Heights", "21_plus"))
        self.assertIn("country", resolved.genres)


class TestTicketsauce(unittest.TestCase):
    def test_reads_events(self):
        data = json.loads((HERE / "fixtures" / "ticketsauce_events.json").read_text())
        shows = ticketsauce.parse(data, "Liquid Joe's", "venue:liquid-joes")
        by = {s.title: s for s in shows}
        self.assertEqual(set(by), {"Stonebreed", "Friday The 13th at Liquid Joes"})
        s = by["Stonebreed"]
        self.assertEqual(s.starts_at, datetime(2026, 10, 23, 19, 0, tzinfo=TZ))
        self.assertEqual(s.ticket_url, "https://liquidjoes.ticketsauce.com/e/stonebreed/tickets")
        self.assertEqual(s.status, "published")
        self.assertEqual(by["Friday The 13th at Liquid Joes"].status, "pending")   # not filed as a concert
        self.assertEqual(resolve(s, load_venues()).venue_slug, "liquid-joes")


class TestSeatGeek(unittest.TestCase):
    def test_mapping(self):
        e = {"short_title": "Rise Against", "datetime_local": "2026-10-18T18:30:00", "url": "https://seatgeek.com/x",
             "venue": {"name": "The Union Event Center", "city": "Salt Lake City"},
             "performers": [{"name": "Support", "primary": False}, {"name": "Rise Against", "primary": True, "image": "i.jpg"}]}
        s = seatgeek.to_show(e)
        self.assertEqual(s.artists, ["Rise Against", "Support"])
        self.assertEqual(s.starts_at, datetime(2026, 10, 18, 18, 30, tzinfo=TZ))
        self.assertEqual(resolve(s, load_venues()).venue_slug, "the-union-event-center")
        tbd = seatgeek.to_show(dict(e, time_tbd=True, datetime_local="2026-12-01T03:30:00"))
        self.assertEqual(tbd.starts_at, datetime(2026, 12, 1, 19, 0, tzinfo=TZ))
        self.assertIsNone(seatgeek.to_show(dict(e, date_tbd=True)))


class TestCoverage(unittest.TestCase):
    class FakeDB:
        def __init__(self, rows):
            self.rows, self.logged = rows, []

        def upcoming_venue_dates(self, until):
            return [r for r in self.rows if datetime.fromisoformat(r["starts_at"]) <= until]

        def log_run(self, source, ok, found=0, error=None, **kw):
            self.logged.append((source, ok, found, error))

    def test_flags_quiet_venues_and_respects_seasons(self):
        venues = list(load_venues())
        for v in venues:
            v.id = v.slug
        now = datetime(2026, 10, 21, 12, 0, tzinfo=TZ)
        soon = (now + timedelta(days=3)).isoformat()
        rows = [{"venue_id": "kilby-court", "starts_at": soon},
                {"venue_id": "hog-wallow", "starts_at": (now + timedelta(days=12)).isoformat()}]
        db = self.FakeDB(rows)
        results = {v.slug: (n, p) for v, n, p in coverage.check(db, venues, now=now)}
        self.assertEqual(results["kilby-court"], (1, None))
        self.assertIsNotNone(results["hog-wallow"][1])        # a show, but outside its 7-day window
        self.assertIsNone(results["great-saltair"][1])        # seasonal venues are quiet October through March
        winter = {v.slug: p for v, n, p in coverage.check(db, venues, now=datetime(2027, 1, 10, tzinfo=TZ))}
        self.assertIsNone(winter["great-saltair"])
        summer = {v.slug: p for v, n, p in coverage.check(db, venues, now=datetime(2027, 7, 10, tzinfo=TZ))}
        self.assertIsNotNone(summer["great-saltair"])
        gaps = coverage.log(db, coverage.check(db, venues, now=now))
        self.assertEqual(gaps, sum(1 for _, ok, _, _ in db.logged if not ok))
        self.assertIn(("coverage:kilby-court", True, 1, None), db.logged)


class TestDigest(unittest.TestCase):
    def test_lists_gaps_and_failures(self):
        runs = [
            {"source": "coverage:hog-wallow", "ok": False, "error": "No published shows in the next 7 days.", "ran_at": "2026-10-21T13:00"},
            {"source": "coverage:kilby-court", "ok": True, "error": None, "ran_at": "2026-10-21T13:00"},
            {"source": "venue:the-complex", "ok": False, "error": "HTTPError: 503", "ran_at": "2026-10-21T13:00"},
            {"source": "ticketmaster", "ok": True, "error": None, "ran_at": "2026-10-21T13:00"},
        ]
        subject, body = run_digest.build(runs, pending=4)
        self.assertIn("2 to look at", subject)
        self.assertIn("hog-wallow", body)
        self.assertIn("venue:the-complex", body)
        self.assertNotIn("kilby-court", body)
        self.assertIn("Shows waiting for review: 4", body)
        self.assertIn("all sources healthy", run_digest.build(runs[1:2], 0)[0])


if __name__ == "__main__":
    unittest.main()
