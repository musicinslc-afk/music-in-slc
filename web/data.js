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
    },
    remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
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
    const cols = "id,title,artists,venue_name,city,starts_at,doors_at,price_min,price_max,is_free," +
      "age_restriction,genres,ticket_url,image_url,status,description";
    const all = [];
    for (let offset = 0; offset < 6000; offset += 1000) {
      const r = await rest(`events?select=${cols}&status=in.(published,cancelled)&starts_at=gte.${since}` +
        `&order=starts_at.asc&limit=1000&offset=${offset}`);
      if (!r.ok) throw new Error(`Couldn't load shows (${r.status}). Check supabaseUrl and supabaseAnonKey in config.js.`);
      const page = await r.json();
      all.push(...page);
      if (page.length < 1000) break;
    }
    return all;
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
      };
    });
  }

  window.SLC = {
    cfg, live, TZ, store, mountainTime, rest, loadGenres, loadEvents, loadVenues, submitShow,
    dayKey, addDays, timeLabel, priceLabel, AGE, esc, safeUrl,
    fmtDow: (d) => dowFmt.format(new Date(d)), fmtMon: (d) => monFmt.format(new Date(d)),
    fmtNum: (d) => numFmt.format(new Date(d)), fmtLong: (d) => longFmt.format(new Date(d)),
  };
})();
