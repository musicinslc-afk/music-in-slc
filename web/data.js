// Shared data layer: config, Supabase REST calls, genres, sample data and date formatting.
(function () {
  const cfg = window.SLC_CONFIG || {};
  const TZ = "America/Denver";
  const live = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: keep in memory only */ }
      window.SLCDB?.put(key, value); // copy the service worker can read
    },
    remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } window.SLCDB?.remove(key); },
  };

  function rest(path, opts = {}) {
    return fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
      ...opts,
      headers: {
        apikey: cfg.supabaseAnonKey,
        Authorization: `Bearer ${opts.token || cfg.supabaseAnonKey}`,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
  }

  let genresPromise;
  function loadGenres() {
    genresPromise ||= fetch("genres.json").then((r) => r.json()).then((d) => d.genres);
    return genresPromise;
  }

  async function loadEvents() {
    if (!live) return sampleEvents();
    const since = new Date(Date.now() - 6 * 3600e3).toISOString();
    let cols = "id,title,artists,venue_name,city,starts_at,doors_at,price_min,price_max,is_free," +
      "age_restriction,genres,ticket_url,image_url,image_kind,status,description";
    const all = [];
    for (let offset = 0; offset < 6000; offset += 1000) {
      const get = () => rest(`events?select=${cols}&status=in.(published,cancelled)&starts_at=gte.${since}` +
        `&order=starts_at.asc&limit=1000&offset=${offset}`);
      let r = await get();
      if (r.status === 400 && cols.includes("image_kind")) {
        cols = cols.replace(",image_kind", ""); // database not migrated yet
        r = await get();
      }
      if (!r.ok) throw new Error(`Couldn't load shows (${r.status}). Check supabaseUrl and supabaseAnonKey in config.js.`);
      const saved = r.headers.get("x-slc-saved-at"); // set when the app served its offline copy
      if (offset === 0) window.dispatchEvent(new CustomEvent("slc:saved-data", { detail: saved }));
      const page = await r.json();
      all.push(...page);
      if (page.length < 1000) break;
    }
    return all;
  }

  // ---------- band links ----------
  // Same rules as ingest/slclive/links.py, so names match the artists table
  function artistKey(name) {
    return String(name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()
      .replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "").slice(0, 60);
  }
  const LINK_LABELS = {
    homepage: "Website", bandcamp: "Bandcamp", instagram: "Instagram", spotify: "Spotify", youtube: "YouTube",
    soundcloud: "SoundCloud", tiktok: "TikTok", facebook: "Facebook", twitter: "X", linktree: "Links",
  };
  const LINK_ORDER = Object.keys(LINK_LABELS);
  const HOST_KINDS = [["bandcamp.com", "bandcamp"], ["instagram.com", "instagram"], ["open.spotify.com", "spotify"],
    ["youtube.com", "youtube"], ["youtu.be", "youtube"], ["soundcloud.com", "soundcloud"], ["tiktok.com", "tiktok"],
    ["facebook.com", "facebook"], ["fb.com", "facebook"], ["twitter.com", "twitter"], ["x.com", "twitter"], ["linktr.ee", "linktree"]];
  function linkKind(url) {
    const u = safeUrl(url);
    if (!u) return null;
    const host = new URL(u).hostname.replace(/^www\./, "");
    const hit = HOST_KINDS.find(([d]) => host === d || host.endsWith(`.${d}`));
    return hit ? hit[1] : "homepage";
  }

  let artistsPromise;
  function loadArtists() {
    artistsPromise ||= (async () => {
      if (!live) return sampleArtists();
      const map = new Map();
      for (let offset = 0; offset < 20000; offset += 1000) {
        const r = await rest(`artists?select=key,name,homepage,links&or=(homepage.not.is.null,links.neq.{})` +
          `&order=key.asc&limit=1000&offset=${offset}`);
        if (!r.ok) break; // no artists table yet: shows simply have no band links
        const page = await r.json();
        for (const a of page) map.set(a.key, a);
        if (page.length < 1000) break;
      }
      return map;
    })().catch(() => new Map());
    return artistsPromise;
  }

  // [{kind, label, url}] for one artist, in display order
  function bandLinks(artists, name) {
    const a = artists && artists.get(artistKey(name));
    if (!a) return [];
    const all = { ...(a.links || {}), ...(a.homepage ? { homepage: a.homepage } : {}) };
    return LINK_ORDER.filter((k) => all[k] && safeUrl(all[k])).map((k) => ({ kind: k, label: LINK_LABELS[k], url: safeUrl(all[k]) }));
  }

  // A stand-in tile for shows without a flyer: the headliner's initials on a color picked from the name
  const TILE_COLORS = ["#6A2BD9", "#A3127A", "#0B6F80", "#3B1E8A", "#8A1FB0", "#1D4FA8"];
  // A small LED level meter: how busy a night is, one segment per show up to six
  function meter(n) {
    const segs = [];
    for (let i = 5; i >= 0; i--) segs.push(`<i class="${i < n ? "on " : ""}${i < 3 ? "lv-v" : i < 5 ? "lv-m" : "lv-c"}"></i>`);
    return `<span class="meter" role="img" aria-label="${n} show${n === 1 ? "" : "s"}">${segs.join("")}</span>`;
  }
  function tileStyle(name) {
    let h = 0;
    for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `--tile:${TILE_COLORS[h % TILE_COLORS.length]}`;
  }
  function initials(name) {
    const words = String(name || "").replace(/^the\s+/i, "").split(/[\s&/+-]+/).filter((w) => /[a-z0-9]/i.test(w));
    return (words.slice(0, 2).map((w) => w.match(/[a-z0-9]/i)[0]).join("") || "♪").toUpperCase();
  }

  async function loadVenues() {
    if (!live) return [...new Set(sampleEvents().map((e) => e.venue_name))].sort().map((name) => ({ name }));
    const r = await rest("venues?select=name,city,address,age_policy&order=name.asc");
    return r.ok ? r.json() : [];
  }

  async function submitShow(row) {
    if (!live) return { ok: true, demo: true };
    const r = await rest("events", { method: "POST", body: JSON.stringify(row), headers: { Prefer: "return=minimal" } });
    if (r.ok) return { ok: true };
    const text = await r.text();
    return { ok: false, error: text };
  }

  // ---------- dates, always shown in Mountain time ----------
  const fmt = (opts) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts });
  const dayKeyFmt = fmt({ year: "numeric", month: "2-digit", day: "2-digit" });
  function dayKey(d) {
    const p = Object.fromEntries(dayKeyFmt.formatToParts(new Date(d)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  const timeFmt = fmt({ hour: "numeric", minute: "2-digit" });
  function timeLabel(d) { return d ? timeFmt.format(new Date(d)).replace(":00", "").replace(" ", "").toLowerCase() : ""; }
  const dowFmt = fmt({ weekday: "short" }), monFmt = fmt({ month: "short" }), numFmt = fmt({ day: "numeric" });
  const longFmt = fmt({ weekday: "long", month: "long", day: "numeric" });

  function addDays(key, n) {
    const [y, m, d] = key.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return t.toISOString().slice(0, 10);
  }

  function priceLabel(e) {
    if (e.is_free || e.price_min === 0) return "Free";
    if (e.price_min == null) return "";
    const lo = `$${Math.round(e.price_min)}`;
    return e.price_max && e.price_max > e.price_min ? `${lo}–${Math.round(e.price_max)}` : lo;
  }
  const AGE = { all_ages: "All ages", "18_plus": "18+", "21_plus": "21+" };

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function safeUrl(u) {
    try { const x = new URL(u); return ["http:", "https:"].includes(x.protocol) ? x.href : null; } catch { return null; }
  }

  // A wall-clock time in Salt Lake as a Date, whichever of MST/MDT applies that day.
  const hourFmt = fmt({ hour: "numeric", hourCycle: "h23" });
  function mountainTime(day, hh, mm) {
    const pad = (n) => String(n).padStart(2, "0");
    for (const off of ["-06:00", "-07:00"]) {
      const d = new Date(`${day}T${pad(hh)}:${pad(mm)}:00${off}`);
      if (Number(hourFmt.format(d)) === hh) return d;
    }
    return new Date(`${day}T${pad(hh)}:${pad(mm)}:00-07:00`);
  }

  // ---------- sample listings (fictional bands, real venues), dated from today ----------
  function sampleEvents() {
    const today = dayKey(Date.now());
    const rows = [
      [0, "20:00", "Sun Valley Static", ["Paper Kites Local", "Junebug"], "Kilby Court", "Salt Lake City", 15, null, "all_ages", ["indie", "local"]],
      [0, "21:00", "Bonneville Drift", ["Rhea Vance"], "The Urban Lounge", "Salt Lake City", 18, null, "21_plus", ["indie", "rock"]],
      [0, "19:30", "Wasatch Jazz Collective", [], "The State Room", "Salt Lake City", 25, 35, "21_plus", ["jazz"]],
      [1, "19:00", "Marrow Saints", ["Grave Lattice", "Sulfur Bloom"], "Metro Music Hall", "Salt Lake City", 20, null, "all_ages", ["metal", "punk"]],
      [1, "18:00", "Sunday Porch Sessions", ["The Alder Twins"], "Gallivan Center", "Salt Lake City", 0, null, "all_ages", ["folk", "bluegrass"]],
      [2, "20:00", "Lo Velo", ["Copper Coast"], "Soundwell", "Salt Lake City", 22, 30, "21_plus", ["electronic"]],
      [3, "19:00", "Utah Symphony: Rachmaninoff 2", [], "Abravanel Hall", "Salt Lake City", 29, 95, "all_ages", ["classical"]],
      [4, "20:00", "Mesa Mile", ["Hollow Oak"], "The Commonwealth Room", "South Salt Lake", 28, null, "21_plus", ["country"]],
      [4, "19:00", "Tidepool Kids", ["Minor Saint", "Lake Effect"], "Kilby Court", "Salt Lake City", 14, null, "all_ages", ["punk", "local"]],
      [5, "20:00", "Copper Cathedral", ["The Valley Bells"], "The Depot", "Salt Lake City", 35, 55, "all_ages", ["indie", "pop"]],
      [5, "21:00", "Northbound 89", ["DJ Halite"], "The Union Event Center", "Salt Lake City", 40, 60, "all_ages", ["hiphop"]],
      [5, "21:30", "Grid City Soul Revue", [], "The State Room", "Salt Lake City", 20, null, "21_plus", ["rnb"]],
      [6, "19:00", "Los Cerros", ["Banda Azul del Valle"], "Maverik Center", "West Valley City", 45, 120, "all_ages", ["latin"]],
      [6, "20:00", "Bitter Creek Ramblers", [], "The Royal", "Murray", 12, null, "21_plus", ["bluegrass", "country"]],
      [7, "20:00", "Velvet Inversion", ["Mirror Lake"], "The Urban Lounge", "Salt Lake City", 16, null, "21_plus", ["indie", "experimental"]],
      [8, "19:00", "Hollow Season", ["Ashgrove", "Pale Signal"], "Murray Theater", "Murray", 24, null, "all_ages", ["metal"]],
      [9, "20:00", "Rhea Vance", ["Junebug"], "Kilby Court", "Salt Lake City", 15, null, "all_ages", ["folk", "indie"]],
      [10, "19:30", "Salt Flats Big Band", [], "Eccles Theater", "Salt Lake City", 30, 70, "all_ages", ["jazz"]],
      [11, "21:00", "Parley's Canyon Sound System", [], "Soundwell", "Salt Lake City", 25, null, "21_plus", ["electronic", "world"]],
      [12, "20:00", "Copper Coast", ["Bonneville Drift"], "Metro Music Hall", "Salt Lake City", 18, null, "all_ages", ["rock", "indie"]],
      [12, "19:00", "Open Mic & Songwriter Night", [], "The Beehive", "Salt Lake City", 0, null, "21_plus", ["local", "folk"]],
      [13, "19:30", "Aurora Pike", ["Lake Effect"], "Delta Center", "Salt Lake City", 59, 189, "all_ages", ["pop"]],
      [14, "20:00", "Dust Choir", [], "The Commonwealth Room", "South Salt Lake", 22, null, "21_plus", ["blues", "rock"]],
      [16, "20:00", "Minor Saint", ["Tidepool Kids"], "Kilby Court", "Salt Lake City", 12, null, "all_ages", ["punk"]],
      [18, "19:00", "Neon Basin", ["Lo Velo"], "The Complex", "Salt Lake City", 30, 45, "all_ages", ["electronic", "pop"]],
      [20, "20:00", "Emigration Canyon String Band", [], "Red Butte Garden Amphitheatre", "Salt Lake City", 32, null, "all_ages", ["bluegrass", "folk"]],
      [23, "20:00", "The Alder Twins", ["Hollow Oak"], "The State Room", "Salt Lake City", 26, null, "21_plus", ["folk", "country"]],
      [26, "19:00", "Sulfur Bloom", ["Marrow Saints"], "Metro Music Hall", "Salt Lake City", 15, null, "all_ages", ["punk", "metal"]],
    ];
    return rows.map(([d, t, title, support, venue, city, lo, hi, age, genres], i) => {
      const [hh, mm] = t.split(":").map(Number);
      const day = addDays(today, d);
      const starts = mountainTime(addDays(today, d), hh, mm);
      return {
        id: `sample-${i}`, title, artists: [title.split(":")[0], ...support], venue_name: venue, city,
        starts_at: starts.toISOString(), doors_at: new Date(starts - 3600e3).toISOString(),
        price_min: lo, price_max: hi, is_free: lo === 0, age_restriction: age, genres,
        ticket_url: null, status: "published", sample: true,
        ...(i % 3 !== 2 ? { image_url: samplePoster(title, venue, day, i), image_kind: "flyer" } : {}),
      };
    });
  }

  // Made-up gig posters for the sample listings, drawn as SVG so the demo needs no image files
  function samplePoster(title, venue, day, i) {
    const palettes = [["#0E1A2B", "#FF6B35", "#F4EDE1"], ["#2b1240", "#f0c419", "#fbf3dc"], ["#0d3b3a", "#ff8fab", "#e1f3f1"],
      ["#3a0d0d", "#ffd166", "#fff4e0"], ["#14213d", "#8ecae6", "#ffffff"]];
    const [bg, accent, ink] = palettes[i % palettes.length];
    const words = title.toUpperCase().split(/\s+/);
    const lines = [];
    for (const w of words) {
      const last = lines[lines.length - 1];
      if (last && (last + " " + w).length <= 11) lines[lines.length - 1] = `${last} ${w}`; else lines.push(w);
    }
    const x = (t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const date = new Date(`${day}T19:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 560"><rect width="400" height="560" fill="${bg}"/>` +
      `<circle cx="${120 + (i * 53) % 200}" cy="${150 + (i * 37) % 120}" r="${110 + (i * 17) % 60}" fill="${accent}" opacity=".9"/>` +
      `<g font-family="Arial Narrow, Arial, sans-serif" font-weight="800" fill="${ink}">` +
      lines.slice(0, 4).map((l, n) => `<text x="28" y="${330 + n * 52}" font-size="50">${x(l)}</text>`).join("") +
      `<text x="28" y="520" font-size="22" fill="${accent}">${x(date)} · ${x(venue.toUpperCase())}</text></g></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  // Sample band links for the demo, pointing at example.com
  function sampleArtists() {
    const map = new Map();
    for (const name of ["Sun Valley Static", "Rhea Vance", "Marrow Saints", "Lo Velo", "Copper Cathedral", "Bonneville Drift"]) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
      map.set(artistKey(name), { key: artistKey(name), name, homepage: `https://example.com/${slug}`,
        links: { bandcamp: `https://example.com/${slug}/music`, instagram: `https://example.com/${slug}/photos` } });
    }
    return map;
  }

  window.SLC = {
    cfg, live, TZ, store, mountainTime, rest, loadGenres, loadEvents, loadVenues, submitShow,
    loadArtists, artistKey, linkKind, bandLinks, LINK_LABELS, LINK_ORDER, tileStyle, initials, meter,
    dayKey, addDays, timeLabel, priceLabel, AGE, esc, safeUrl,
    fmtDow: (d) => dowFmt.format(new Date(d)), fmtMon: (d) => monFmt.format(new Date(d)),
    fmtNum: (d) => numFmt.format(new Date(d)), fmtLong: (d) => longFmt.format(new Date(d)),
  };
})();
