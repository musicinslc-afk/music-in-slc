// Calendar page: filters, grouping by night, taste matches and plans.
(async function () {
  const S = window.SLC, T = window.SLCTaste, P = window.SLCPlans;
  const $ = (id) => document.getElementById(id);
  const PREFS = "slc.filters.v1";

  const state = Object.assign(
    { q: "", venue: "", when: "all", genres: [], allAges: false, free: false, onlyMatches: false, onlyPlans: false },
    S.store.get(PREFS, {}),
  );
  if (state.when === "tonight") state.when = "all"; // tonight has its own section above the calendar
  // A saved date range that has already ended is dropped
  if (state.when === "range" && !(state.to && state.to >= S.dayKey(Date.now()))) state.when = "all";
  let events = [];
  let genres = [];
  let artists = new Map();
  const D = window.SLCDetails;
  const details = D.create({ find: (id) => events.find((e) => String(e.id) === String(id)), artists });

  $("inbox-addr").textContent = S.cfg.inboxAddress || "musicinslc@gmail.com";
  $("demo-note").hidden = S.live;

  // ---------- date ranges in Salt Lake time ----------
  const WHEN = [
    ["weekend", "This weekend"], ["week", "Next 7 days"], ["month", "Next 30 days"], ["all", "Everything"], ["range", "Pick dates"],
  ];
  function inRange(e) {
    const today = S.dayKey(Date.now());
    const k = S.dayKey(e.starts_at);
    if (k === today) return false; // tonight's shows are listed in their own section
    switch (state.when) {
      case "week": return k <= S.addDays(today, 6);
      case "month": return k <= S.addDays(today, 29);
      case "range": return (!state.from || k >= state.from) && (!state.to || k <= state.to);
      case "weekend": {
        // Friday through Sunday: this one if we're in it, otherwise the next one
        const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 Sun .. 6 Sat
        const start = [5, 6, 0].includes(dow) ? today : S.addDays(today, 5 - dow);
        const end = dow === 0 ? today : S.addDays(start, dow === 6 ? 1 : 2);
        return k >= start && k <= end;
      }
      default: return true;
    }
  }

  function matches(e) {
    if (!inRange(e)) return false;
    if (state.venue && e.venue_name !== state.venue) return false;
    if (state.genres.length && !(e.genres || []).some((g) => state.genres.includes(g))) return false;
    if (state.allAges && e.age_restriction !== "all_ages") return false;
    if (state.free && !(e.is_free || e.price_min === 0)) return false;
    if (state.q) {
      const hay = `${e.title} ${(e.artists || []).join(" ")} ${e.venue_name} ${e.city || ""}`.toLowerCase();
      if (!state.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    if (state.onlyMatches && T.profile && !e._match) return false;
    if (state.onlyPlans && !P.status(e.id)) return false;
    return true;
  }

  // ---------- rendering ----------
  const { showHtml, dayHtml } = window.SLCCards;
  window.SLCCards.setArtists(artists);

  function renderTonight() {
    const today = S.dayKey(Date.now());
    const shows = events.filter((e) => S.dayKey(e.starts_at) === today).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    $("tonight").hidden = !shows.length;
    $("tonight-list").innerHTML = shows.length ? dayHtml(today, shows) : "";
  }

  function render() {
    for (const e of events) e._match = T.score(e);
    renderTonight();
    let list = events.filter(matches);
    const n = list.length;
    $("count").textContent = `${n} show${n === 1 ? "" : "s"}`;
    if (!n) {
      $("list").innerHTML = state.onlyPlans
        ? `<div class="empty"><strong>No plans yet</strong>Tap Maybe or Going on a show and it lands here.</div>`
        : `<div class="empty"><strong>Nothing on the bill</strong>Try a wider date range or fewer filters.</div>`;
      return;
    }
    const byDay = new Map();
    for (const e of list) {
      const k = S.dayKey(e.starts_at);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e);
    }
    let html = "";
    for (const [k, shows] of byDay) html += dayHtml(k, shows);
    $("list").innerHTML = html;
  }

  function persist() { S.store.set(PREFS, { when: state.when, from: state.from, to: state.to, genres: state.genres, allAges: state.allAges, free: state.free }); }
  function update() { persist(); syncControls(); render(); }

  // ---------- controls ----------
  function syncControls() {
    document.querySelectorAll("[data-when]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.when === state.when)));
    $("date-range").hidden = state.when !== "range";
    $("date-from").value = state.from || "";
    $("date-to").value = state.to || "";
    $("date-from").min = $("date-to").min = S.dayKey(Date.now());
    if (state.from) $("date-to").min = state.from;
    document.querySelectorAll("[data-genre]").forEach((b) => b.setAttribute("aria-pressed", String(state.genres.includes(b.dataset.genre))));
    $("f-allages").setAttribute("aria-pressed", String(state.allAges));
    $("f-free").setAttribute("aria-pressed", String(state.free));
    $("only-matches").setAttribute("aria-pressed", String(state.onlyMatches));
    $("only-plans").setAttribute("aria-pressed", String(state.onlyPlans));
  }

  const whenRow = $("when-row");
  for (const [id, label] of WHEN) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.dataset.when = id; b.textContent = label;
    b.onclick = () => {
      state.when = id;
      if (id === "range") {
        const today = S.dayKey(Date.now());
        if (!state.from || state.from < today) state.from = S.addDays(today, 1);
        if (!state.to || state.to < state.from) state.to = S.addDays(state.from, 6);
      }
      update();
      if (id === "range") $("date-from").focus();
    };
    whenRow.appendChild(b);
  }
  whenRow.appendChild($("date-range"));
  function setRange(which, value) {
    if (!value) return;
    state[which] = value;
    if (state.from && state.to && state.to < state.from) {
      if (which === "from") state.to = state.from; else state.from = state.to;
    }
    update();
  }
  $("date-from").addEventListener("change", (ev) => setRange("from", ev.target.value));
  $("date-to").addEventListener("change", (ev) => setRange("to", ev.target.value));
  $("q").addEventListener("input", (ev) => { state.q = ev.target.value.trim(); render(); });
  $("venue").addEventListener("change", (ev) => { state.venue = ev.target.value; render(); });
  $("f-allages").onclick = () => { state.allAges = !state.allAges; update(); };
  $("f-free").onclick = () => { state.free = !state.free; update(); };
  $("f-clear").onclick = () => {
    Object.assign(state, { q: "", venue: "", when: "all", from: "", to: "", genres: [], allAges: false, free: false, onlyMatches: false, onlyPlans: false });
    $("q").value = ""; $("venue").value = ""; update();
  };
  $("only-matches").onclick = () => { state.onlyMatches = !state.onlyMatches; update(); };
  $("only-plans").onclick = () => { state.onlyPlans = !state.onlyPlans; update(); };

  // The calendar always opens at the top. The browser's own scroll restoration would put a reload back where the
  // visitor was and then keep it pinned there while the listings above it load. It has to be switched off on the
  // page being left, so it is set on every load, not only on a reload.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  const params = new URLSearchParams(location.search);
  // The You section moved to its own page; old links (and sign-in links already sent) go there
  if (location.hash === "#you" || location.hash === "#for-you" || params.has("you")) {
    params.delete("you");
    const qs = params.toString();
    const keepHash = location.hash.includes("access_token") || location.hash.startsWith("#show-") ? location.hash : "";
    location.replace(`you.html${qs ? `?${qs}` : ""}${keepHash}`);
    return;
  }
  if (!location.hash.startsWith("#show-")) window.scrollTo(0, 0);

  // My matches and My plans only show up once there's something to filter by
  function syncChips() {
    const planned = P.mineCount().going + P.mineCount().maybe;
    $("only-matches").hidden = !T.profile;
    $("only-plans").hidden = !planned && !state.onlyPlans;
    $("only-plans").textContent = planned ? `My plans (${planned})` : "My plans";
  }
  P.onChange(() => { syncChips(); if (state.onlyPlans) render(); });

  // ---------- load ----------
  try {
    genres = await S.loadGenres();
    window.SLC_GENRE_LABELS = Object.fromEntries(genres.map((g) => [g.id, g.label]));
    $("genre-chips").innerHTML = genres.map((g) =>
      `<button class="chip" type="button" data-genre="${g.id}" aria-pressed="false">${S.esc(g.label)}</button>`).join("");
    document.querySelectorAll("[data-genre]").forEach((b) => b.onclick = () => {
      const g = b.dataset.genre;
      state.genres = state.genres.includes(g) ? state.genres.filter((x) => x !== g) : [...state.genres, g];
      update();
    });

    const artistsLoad = S.loadArtists();
    events = await S.loadEvents();
    for (const [k, v] of await artistsLoad) artists.set(k, v);
    // Alphabetize without a leading "The", so The Union Event Center sits under U
    const sortKey = (v) => v.replace(/^the\s+/i, "");
    const venues = [...new Set(events.map((e) => e.venue_name))].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    $("venue").insertAdjacentHTML("beforeend", venues.map((v) => `<option>${S.esc(v)}</option>`).join(""));
    // ?venue=Name (from the Venues page) opens the calendar filtered to that venue
    const wantVenue = params.get("venue");
    if (wantVenue && venues.includes(wantVenue)) { state.venue = wantVenue; $("venue").value = wantVenue; }
    syncControls(); syncChips(); render();
    details.fromHash();
    P.start({ find: (id) => events.find((e) => String(e.id) === String(id)) });
  } catch (err) {
    $("list").innerHTML = `<div class="empty"><strong>Shows didn't load</strong>${S.esc(err.message)}</div>`;
  }
})();
