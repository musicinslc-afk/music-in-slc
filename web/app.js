// Calendar page: filters, grouping by night, and "For you" matching.
(async function () {
  const S = window.SLC, T = window.SLCTaste;
  const $ = (id) => document.getElementById(id);
  const PREFS = "slc.filters.v1";

  const state = Object.assign(
    { q: "", venue: "", when: "all", genres: [], allAges: false, free: false, onlyMatches: false },
    S.store.get(PREFS, {}),
  );
  if (state.when === "tonight") state.when = "all"; // tonight has its own section above the calendar
  let events = [];
  let genres = [];

  $("inbox-addr").textContent = S.cfg.inboxAddress || "musicinslc@gmail.com";
  $("demo-note").hidden = S.live;

  // ---------- date ranges in Salt Lake time ----------
  const WHEN = [
    ["weekend", "This weekend"], ["week", "Next 7 days"], ["month", "Next 30 days"], ["all", "Everything"],
  ];
  function inRange(e) {
    const today = S.dayKey(Date.now());
    const k = S.dayKey(e.starts_at);
    if (k === today) return false; // tonight's shows are listed in their own section
    switch (state.when) {
      case "week": return k <= S.addDays(today, 6);
      case "month": return k <= S.addDays(today, 29);
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
    return true;
  }

  // ---------- rendering ----------
  function relLabel(key) {
    const today = S.dayKey(Date.now());
    if (key === today) return "Tonight";
    if (key === S.addDays(today, 1)) return "Tomorrow";
    return "";
  }

  function showHtml(e) {
    const support = (e.artists || []).slice(1).filter((a) => a.toLowerCase() !== e.title.toLowerCase());
    const url = S.safeUrl(e.ticket_url);
    const price = S.priceLabel(e);
    const tags = (e.genres || []).map((g) => `<span class="tag">${S.esc(window.SLC_GENRE_LABELS[g] || g)}</span>`).join("");
    const age = S.AGE[e.age_restriction] ? `<span class="tag age">${S.AGE[e.age_restriction]}</span>` : "";
    const cancelled = e.status === "cancelled";
    return `<article class="show${e._match ? " matched" : ""}${cancelled ? " cancelled" : ""}">
      <div class="time">${S.esc(S.timeLabel(e.starts_at))}${e.doors_at ? `<small>doors ${S.esc(S.timeLabel(e.doors_at))}</small>` : ""}</div>
      <div class="show-main">
        <h3 class="title">${S.esc(e.title)}</h3>
        ${support.length ? `<div class="support">with ${S.esc(support.join(", "))}</div>` : ""}
        <div class="where">${S.esc(e.venue_name)}${e.city && e.city !== "Salt Lake City" ? ` <span>· ${S.esc(e.city)}</span>` : ""}</div>
        <div class="tags">${cancelled ? '<span class="tag status">Cancelled</span>' : ""}${age}${tags}</div>
        ${e._match ? `<div class="match">${S.esc(e._match.reason)}</div>` : ""}
      </div>
      <div class="show-side">
        ${price ? `<span class="price${price === "Free" ? " free" : ""}">${S.esc(price)}</span>` : ""}
        ${url && !cancelled ? `<a class="btn primary" href="${S.esc(url)}" target="_blank" rel="noopener">Tickets</a>` : ""}
      </div>
    </article>`;
  }

  function dayHtml(k, shows) {
    // Matches float to the top of each night when a profile is connected
    if (T.profile) shows.sort((a, b) => (b._match?.score || 0) - (a._match?.score || 0) || a.starts_at.localeCompare(b.starts_at));
    const d = shows[0].starts_at;
    const rel = relLabel(k);
    return `<section class="day" aria-label="${S.esc(S.fmtLong(d))}">
        <div class="stub"><span class="dow">${S.esc(S.fmtDow(d))}</span><span class="num">${S.esc(S.fmtNum(d))}</span><span class="mon">${S.esc(S.fmtMon(d))}</span>${rel ? `<span class="rel">${rel}</span>` : ""}</div>
        <div class="shows">${shows.map(showHtml).join("")}</div>
      </section>`;
  }

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
      $("list").innerHTML = `<div class="empty"><strong>Nothing on the bill</strong>Try a wider date range or fewer filters.</div>`;
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

  function persist() { S.store.set(PREFS, { when: state.when, genres: state.genres, allAges: state.allAges, free: state.free }); }
  function update() { persist(); syncControls(); render(); }

  // ---------- controls ----------
  function syncControls() {
    document.querySelectorAll("[data-when]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.when === state.when)));
    document.querySelectorAll("[data-genre]").forEach((b) => b.setAttribute("aria-pressed", String(state.genres.includes(b.dataset.genre))));
    $("f-allages").setAttribute("aria-pressed", String(state.allAges));
    $("f-free").setAttribute("aria-pressed", String(state.free));
    $("only-matches").setAttribute("aria-pressed", String(state.onlyMatches));
  }

  const whenRow = $("when-row");
  for (const [id, label] of WHEN) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.dataset.when = id; b.textContent = label;
    b.onclick = () => { state.when = id; update(); };
    whenRow.appendChild(b);
  }
  $("q").addEventListener("input", (ev) => { state.q = ev.target.value.trim(); render(); });
  $("venue").addEventListener("change", (ev) => { state.venue = ev.target.value; render(); });
  $("f-allages").onclick = () => { state.allAges = !state.allAges; update(); };
  $("f-free").onclick = () => { state.free = !state.free; update(); };
  $("f-clear").onclick = () => {
    Object.assign(state, { q: "", venue: "", when: "all", genres: [], allAges: false, free: false, onlyMatches: false });
    $("q").value = ""; $("venue").value = ""; update();
  };
  $("only-matches").onclick = () => { state.onlyMatches = !state.onlyMatches; update(); };

  // ---------- taste panel ----------
  function showTasteError(msg) { $("taste-error").textContent = msg; $("taste-error").hidden = !msg; }
  function syncTaste() {
    const on = Boolean(T.profile);
    $("for-you").dataset.active = String(on);
    $("taste-connect").hidden = on;
    $("manual-taste").hidden = on;
    $("taste-on").hidden = !on;
    $("lastfm-form").hidden = !T.hasLastfm();
    if (!T.hasLastfm()) {
      $("taste-intro").textContent = "Tell us a few artists or genres you love and we'll flag the shows that fit.";
      $("manual-taste").open = true;
    }
    if (!S.live) $("manual-artists").placeholder = "Try the sample bands: Rhea Vance, Marrow Saints, Lo Velo";
    if (on) {
      const s = T.summary();
      const hits = events.filter((e) => T.score(e)).length;
      $("taste-summary").innerHTML = `<strong>${hits} show${hits === 1 ? "" : "s"}</strong> match ${S.esc(s.label)}` +
        (s.text ? ` (${S.esc(s.text)})` : "");
    }
  }
  async function connect(promise, button) {
    showTasteError("");
    const label = button?.textContent;
    if (button) { button.disabled = true; button.textContent = "Reading your taste…"; }
    try {
      T.save(await promise);
      syncTaste(); render();
    } catch (err) {
      showTasteError(err.message || String(err));
    } finally {
      if (button) { button.disabled = false; button.textContent = label; }
    }
  }
  $("lastfm-form").onsubmit = (ev) => {
    ev.preventDefault();
    const u = $("lastfm-user").value.trim();
    if (u) connect(T.fromLastfm(u), ev.submitter);
  };
  $("manual-form").onsubmit = (ev) => {
    ev.preventDefault();
    const picked = [...document.querySelectorAll("#manual-genres input:checked")].map((i) => i.value);
    connect(T.fromManual($("manual-artists").value, picked), ev.submitter);
  };
  $("taste-clear").onclick = () => { T.save(null); state.onlyMatches = false; syncTaste(); update(); };

  // ---------- load ----------
  try {
    genres = await S.loadGenres();
    window.SLC_GENRE_LABELS = Object.fromEntries(genres.map((g) => [g.id, g.label]));
    $("genre-chips").innerHTML = genres.map((g) =>
      `<button class="chip" type="button" data-genre="${g.id}" aria-pressed="false">${S.esc(g.label)}</button>`).join("");
    $("manual-genres").innerHTML = genres.map((g) =>
      `<label><input type="checkbox" value="${g.id}"> ${S.esc(g.label)}</label>`).join("");
    document.querySelectorAll("[data-genre]").forEach((b) => b.onclick = () => {
      const g = b.dataset.genre;
      state.genres = state.genres.includes(g) ? state.genres.filter((x) => x !== g) : [...state.genres, g];
      update();
    });

    events = await S.loadEvents();
    const venues = [...new Set(events.map((e) => e.venue_name))].sort((a, b) => a.localeCompare(b));
    $("venue").insertAdjacentHTML("beforeend", venues.map((v) => `<option>${S.esc(v)}</option>`).join(""));
    syncControls(); syncTaste(); render();
  } catch (err) {
    $("list").innerHTML = `<div class="empty"><strong>Shows didn't load</strong>${S.esc(err.message)}</div>`;
  }
})();
