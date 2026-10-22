// Calendar page: filters, grouping by night, and the You section (taste, plans, friends).
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
    const id = S.esc(e.id);
    return `<article class="show${e._match ? " matched" : ""}${cancelled ? " cancelled" : ""}${P.cardClass(e)}" data-card="${id}">
      <div class="time">${S.esc(S.timeLabel(e.starts_at))}${e.doors_at ? `<small>doors ${S.esc(S.timeLabel(e.doors_at))}</small>` : ""}</div>
      <a class="thumb" href="#show-${id}" data-show="${id}" tabindex="-1" aria-hidden="true">${D.art(e, "thumb-img")}</a>
      <div class="show-main">
        <h3 class="title"><a href="#show-${id}" data-show="${id}">${S.esc(e.title)}</a></h3>
        ${support.length ? `<div class="support">with ${S.esc(support.join(", "))}</div>` : ""}
        <div class="where">${S.esc(e.venue_name)}${e.city && e.city !== "Salt Lake City" ? ` <span>· ${S.esc(e.city)}</span>` : ""}</div>
        ${D.cardLinks(e, artists)}
        <div class="tags">${cancelled ? '<span class="tag status">Cancelled</span>' : ""}${age}${tags}</div>
        ${e._match ? `<div class="match">${S.esc(e._match.reason)}</div>` : ""}
        ${P.html(e, "card")}
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
  const arriveAtYou = location.hash === "#you" || location.hash === "#for-you" || params.has("you");
  if (arriveAtYou) {
    params.delete("you");
    const qs = params.toString();
    const keepHash = location.hash.startsWith("#show-") || location.hash.includes("access_token") ? location.hash : "";
    history.replaceState(history.state, "", location.pathname + (qs ? `?${qs}` : "") + keepHash);
  }
  if (!location.hash.startsWith("#show-")) window.scrollTo(0, 0);
  // The You link scrolls to the section without leaving #you in the address
  document.querySelector('.nav a[href="#you"]')?.addEventListener("click", (ev) => {
    ev.preventDefault();
    you.open(you.isEmpty());
  });

  // ---------- You ----------
  // Set up once, then it folds down to one line with your matches and plans.
  const YOU = "slc.you.v1";
  const youPref = S.store.get(YOU, { setUp: false });
  if (T.profile) youPref.setUp = true; // already set up under the old For you panel
  const you = {
    isOpen: () => !$("you-body").hidden,
    isEmpty: () => !T.profile && !P.user && !P.mineCount().going && !P.mineCount().maybe,
    open(focus) {
      setOpen(true);
      $("you").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      if (focus) setTimeout(() => {
        const target = !P.user && P.social ? $("signin-email") : !T.profile ? $("lastfm-user") : $("you-done");
        (target && target.offsetParent ? target : $("you-toggle")).focus({ preventScroll: true });
      }, 350);
    },
    close() { setOpen(false); },
  };
  window.SLCYou = you;
  function setOpen(open) {
    $("you-body").hidden = !open;
    $("you").dataset.open = String(open);
    $("you-toggle").setAttribute("aria-expanded", String(open));
    syncYou();
  }
  function done() {
    youPref.setUp = true;
    S.store.set(YOU, youPref);
    setOpen(false);
    $("you-toggle").focus({ preventScroll: true });
  }
  $("you-toggle").onclick = () => (you.isOpen() ? done() : setOpen(true));
  $("you-done").onclick = done;

  function showTasteError(msg) { $("taste-error").textContent = msg; $("taste-error").hidden = !msg; }

  function syncYou() {
    const on = Boolean(T.profile);
    const open = you.isOpen();
    const plans = P.mineCount();
    const planned = plans.going + plans.maybe;
    $("you").dataset.active = String(on || planned > 0 || Boolean(P.user));

    // Collapsed summary
    const bits = [];
    if (on) {
      const hits = events.filter((e) => T.score(e)).length;
      bits.push(`<strong>${hits} show${hits === 1 ? "" : "s"}</strong> match ${S.esc(T.summary().label)}`);
    }
    if (planned) {
      bits.push(`<strong>Going to ${plans.going}</strong>${plans.maybe ? `, maybe ${plans.maybe}` : ""}`);
    }
    if (P.profile) bits.push(S.esc(P.visibilityNote().replace(/\.$/, "")));
    $("you-summary").innerHTML = bits.length
      ? bits.join('<span class="dot" aria-hidden="true"> · </span>')
      : "Picks from your listening, and a place to keep the shows you're going to.";
    $("you-summary").hidden = open && !bits.length;
    $("you-toggle").textContent = open ? "Close" : bits.length || youPref.setUp ? "Edit" : "Set up";
    $("only-matches").hidden = !on;
    $("only-plans").hidden = !planned && !state.onlyPlans;
    $("only-plans").textContent = planned ? `My plans (${planned})` : "My plans";

    // Step 2: music
    $("taste-intro").hidden = on;
    $("taste-connect").hidden = on;
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

    // Step 1: account
    const social = P.social;
    $("acct-off").hidden = social;
    $("acct-out").hidden = !social || Boolean(P.user);
    $("acct-in").hidden = !social || !P.profile;
    if (P.profile && !$("acct-in").dataset.filled) fillProfile();
  }

  function fillProfile() {
    const p = P.profile;
    $("acct-in").dataset.filled = "1";
    $("pf-name").value = p.display_name;
    $("pf-handle").value = p.handle;
    document.querySelectorAll('input[name="vis"]').forEach((r) => { r.checked = r.value === p.visibility; });
    const url = P.shareUrl();
    $("share-url").textContent = url.replace(/^https?:\/\//, "");
    $("share-url").href = url;
    $("share-url").dataset.profile = p.handle;
    $("acct-email").textContent = P.user?.email || "";
    renderFriends();
  }

  function renderFriends() {
    const f = P.friends();
    const person = (p, actions) => `<li><a href="?u=${encodeURIComponent(p.handle)}" data-profile="${S.esc(p.handle)}">${S.esc(p.display_name)}</a>
      <span class="mono">@${S.esc(p.handle)}</span><span class="you-row-actions">${actions(p)}</span></li>`;
    const group = (title, list, actions) => list.length
      ? `<h4 class="you-sub">${title}</h4><ul class="you-people">${list.map((p) => person(p, actions)).join("")}</ul>` : "";
    $("friends").innerHTML =
      group("Added you", f.requests, (p) => `<button class="btn lake" type="button" data-follow="${p.user_id}">Add back</button>`) +
      group(`Friends (${f.friends.length})`, f.friends, (p) => `<button class="linkish" type="button" data-unfriend="${p.user_id}">Remove</button>`) +
      group("Waiting for them to add you back", f.waiting, (p) => `<button class="linkish" type="button" data-unfriend="${p.user_id}">Cancel</button>`);
  }
  $("friends").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-follow],[data-unfriend]");
    if (!b) return;
    b.disabled = true;
    if (b.dataset.follow) await P.follow(b.dataset.follow); else await P.unfriend(b.dataset.unfriend);
  });

  async function connect(promise, button) {
    showTasteError("");
    const label = button?.textContent;
    if (button) { button.disabled = true; button.textContent = "Reading your taste…"; }
    try {
      T.save(await promise);
      syncYou(); render();
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
  $("taste-clear").onclick = () => { T.save(null); state.onlyMatches = false; syncYou(); update(); };

  $("signin-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = ev.submitter;
    btn.disabled = true;
    const { error } = await P.signIn($("signin-email").value.trim());
    btn.disabled = false;
    const msg = $("signin-msg");
    msg.hidden = false;
    msg.className = `notice ${error ? "err" : "ok"}`;
    msg.textContent = error ? error.message : "Check your email and open the link on this device. Your Maybe and Going picks come with you.";
  };
  $("profile-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = ev.submitter;
    btn.disabled = true;
    $("profile-msg").textContent = "";
    const r = await P.saveProfile({
      display_name: $("pf-name").value,
      handle: $("pf-handle").value,
      visibility: document.querySelector('input[name="vis"]:checked')?.value || "friends",
    });
    btn.disabled = false;
    $("profile-msg").textContent = r.error || "Saved.";
    if (r.ok) { delete $("acct-in").dataset.filled; fillProfile(); }
  };
  $("share-btn").onclick = (ev) => P.shareLink(ev.currentTarget);
  $("sign-out").onclick = async () => { await P.signOut(); delete $("acct-in").dataset.filled; };

  P.onChange(() => {
    if (P.profile) {
      if (!$("acct-in").dataset.filled) fillProfile(); else renderFriends();
    } else {
      delete $("acct-in").dataset.filled;
    }
    syncYou();
    if (state.onlyPlans) render();
  });

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
    syncControls(); syncYou(); render();
    details.fromHash();
    P.start({ find: (id) => events.find((e) => String(e.id) === String(id)) }).then(() => {
      if (arriveAtYou) you.open(true);
    });
    // Until the visitor has set it up once, You starts open
    if (!youPref.setUp && !arriveAtYou) setOpen(true);
  } catch (err) {
    $("list").innerHTML = `<div class="empty"><strong>Shows didn't load</strong>${S.esc(err.message)}</div>`;
  }
})();
