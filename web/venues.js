// Venues: a directory of every room on the calendar, with what's coming up at each.
(async function () {
  const S = window.SLC;
  const $ = (id) => document.getElementById(id);
  const PREFS = "slc.venues.v1";
  const state = Object.assign({ q: "", kind: "", sort: "name", allAges: false, active: false }, S.store.get(PREFS, {}));
  let venues = [];
  const upcoming = new Map();   // venue name -> shows from now on, soonest first

  $("inbox-addr").textContent = S.cfg.inboxAddress || "musicinslc@gmail.com";

  const AGE = { all_ages: "All ages", "21_plus": "21+", "18_plus": "18+", varies: "Age varies by show" };
  // Kinds grouped into a few filters people actually think in
  const GROUPS = [
    ["Clubs", ["Club", "All-ages club", "Music hall"]],
    ["Bars & pubs", ["Bar", "Pub", "Lounge"]],
    ["Breweries & food halls", ["Brewery", "Food hall", "Market"]],
    ["Theaters & halls", ["Theater", "Concert hall", "Concert complex", "Event hall"]],
    ["Arenas & outdoors", ["Arena", "Amphitheater", "Stadium", "Outdoor plaza", "Fairgrounds"]],
  ];
  const groupOf = (kind) => (GROUPS.find(([, kinds]) => kinds.includes(kind)) || ["Other"])[0];

  const norm = (s) => String(s || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "");
  const capLabel = (n) => (n >= 10000 ? `${Math.round(n / 1000)},000` : n.toLocaleString("en-US"));
  const sizeWord = (n) => (!n ? "" : n < 300 ? "Small room" : n < 1500 ? "Mid-size" : n < 6000 ? "Large" : "Arena-size");
  const weekEnd = S.addDays(S.dayKey(Date.now()), 6);
  const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: S.TZ, weekday: "short", month: "short", day: "numeric" });

  function showsFor(v) {
    const keys = new Set([v.name, ...(v.aliases || [])].map(norm));
    const out = [];
    for (const [name, list] of upcoming) if (keys.has(norm(name))) out.push(...list);
    return out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }

  function keep(v) {
    if (state.kind && groupOf(v.kind) !== state.kind) return false;
    if (state.allAges && v.age_policy !== "all_ages") return false;
    if (state.active && !v.shows.some((e) => S.dayKey(e.starts_at) <= weekEnd)) return false;
    if (state.q) {
      const hay = `${v.name} ${(v.aliases || []).join(" ")} ${v.kind || ""} ${v.address || ""} ${v.city || ""}`.toLowerCase();
      if (!state.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  const sorters = {
    name: (a, b) => a.name.replace(/^the\s+/i, "").localeCompare(b.name.replace(/^the\s+/i, "")),
    shows: (a, b) => b.shows.length - a.shows.length || sorters.name(a, b),
    big: (a, b) => (b.capacity || -1) - (a.capacity || -1) || sorters.name(a, b),
    small: (a, b) => (a.capacity || 1e9) - (b.capacity || 1e9) || sorters.name(a, b),
  };

  function picture(v) {
    const img = S.safeUrl(v.image);
    const fallback = `<span class="vpic-fallback" style="${S.tileStyle(v.name)}" aria-hidden="true">${S.esc(S.initials(v.name))}</span>`;
    if (!img) return fallback;
    return `<img src="${S.esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">${fallback}`;
  }

  function nextLine(v) {
    if (!v.shows.length) return `<p class="vnext none">No shows listed right now</p>`;
    const e = v.shows[0];
    const n = v.shows.length;
    return `<p class="vnext"><span class="vnext-label">Next</span> ${S.esc(dateFmt.format(new Date(e.starts_at)))}, ${S.esc(S.timeLabel(e.starts_at))}: ${S.esc(e.title)}</p>
      <a class="vshows" href="index.html?venue=${encodeURIComponent(e.venue_name)}">${n} upcoming show${n === 1 ? "" : "s"} →</a>`;
  }

  function card(v) {
    const where = [v.address, v.city].filter(Boolean).join(", ");
    const facts = [v.kind, v.capacity ? `Holds about ${capLabel(v.capacity)}` : "", AGE[v.age_policy] || ""].filter(Boolean);
    const site = S.safeUrl(v.website);
    const map = S.safeUrl(v.map);
    return `<article class="vcard">
      <div class="vpic">${picture(v)}${v.capacity ? `<span class="vsize">${S.esc(sizeWord(v.capacity))}</span>` : ""}</div>
      <div class="vbody">
        <h2 class="vname">${S.esc(v.name)}</h2>
        <p class="vfacts">${facts.map(S.esc).join(" · ")}</p>
        ${where ? `<p class="vwhere">${map ? `<a href="${S.esc(map)}" target="_blank" rel="noopener">${S.esc(where)}</a>` : S.esc(where)}</p>` : ""}
        ${nextLine(v)}
        <div class="vlinks">
          ${site ? `<a href="${S.esc(site)}" target="_blank" rel="noopener">Website</a>` : ""}
          ${map ? `<a href="${S.esc(map)}" target="_blank" rel="noopener">Map</a>` : ""}
        </div>
      </div>
    </article>`;
  }

  function render() {
    S.store.set(PREFS, { sort: state.sort, allAges: state.allAges, kind: state.kind });
    document.querySelectorAll("[data-kind]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === state.kind)));
    $("v-allages").setAttribute("aria-pressed", String(state.allAges));
    $("v-active").setAttribute("aria-pressed", String(state.active));
    const list = venues.filter(keep).sort(sorters[state.sort] || sorters.name);
    $("vcount").textContent = `${list.length} venue${list.length === 1 ? "" : "s"}`;
    $("venues").innerHTML = list.length ? list.map(card).join("")
      : `<div class="empty"><strong>No venues match</strong>Try a different search or filter.</div>`;
    // A picture that loads shows; one that fails leaves the venue's initials underneath
    $("venues").querySelectorAll(".vpic img").forEach((img) => {
      const done = () => img.classList.add(img.naturalWidth > 1 ? "loaded" : "failed");
      if (img.complete) done(); else { img.addEventListener("load", done); img.addEventListener("error", () => img.classList.add("failed")); }
    });
  }

  $("vq").value = state.q;
  $("vsort").value = state.sort;
  $("vq").addEventListener("input", (ev) => { state.q = ev.target.value; render(); });
  $("vsort").addEventListener("change", (ev) => { state.sort = ev.target.value; render(); });
  $("v-allages").onclick = () => { state.allAges = !state.allAges; render(); };
  $("v-active").onclick = () => { state.active = !state.active; render(); };

  try {
    const [data, events] = await Promise.all([
      fetch("venues.json").then((r) => { if (!r.ok) throw new Error(`venues.json (${r.status})`); return r.json(); }),
      S.loadEvents().catch(() => []),
    ]);
    const now = new Date().toISOString();
    for (const e of events) {
      if (e.status === "cancelled" || e.starts_at < now) continue;
      if (!upcoming.has(e.venue_name)) upcoming.set(e.venue_name, []);
      upcoming.get(e.venue_name).push(e);
    }
    venues = data.venues.map((v) => ({ ...v, shows: showsFor(v) }));
    const present = new Set(venues.map((v) => groupOf(v.kind)));
    $("vkinds").innerHTML = `<button class="chip" type="button" data-kind="">All</button>` +
      GROUPS.filter(([g]) => present.has(g)).map(([g]) => `<button class="chip" type="button" data-kind="${S.esc(g)}">${S.esc(g)}</button>`).join("");
    document.querySelectorAll("[data-kind]").forEach((b) => b.onclick = () => { state.kind = b.dataset.kind; render(); });
    const total = venues.reduce((n, v) => n + v.shows.length, 0);
    $("venue-sub").textContent = `${venues.length} rooms in Salt Lake County · ${total.toLocaleString("en-US")} shows coming up`;
    render();
  } catch (err) {
    $("venues").innerHTML = `<div class="empty"><strong>Venues didn't load</strong>${S.esc(err.message)}</div>`;
  }
})();
