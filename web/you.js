// You page: the shows you've marked Going and Maybe, then settings (account, friends, who sees your plans,
// and your listening). Settings stay open until they've been set up once, then fold to one line.
(async function () {
  const S = window.SLC, T = window.SLCTaste, P = window.SLCPlans, C = window.SLCCards;
  const $ = (id) => document.getElementById(id);
  const TAB = "slc.you.tab.v1";
  const YOU = "slc.you.v1";

  let events = [];
  const artists = new Map();
  C.setArtists(artists);
  const find = (id) => events.find((e) => String(e.id) === String(id));
  const details = window.SLCDetails.create({ find, artists });
  let tab = S.store.get(TAB, "all");
  // Read before the sign-in library tidies the address
  const fromSignIn = location.hash.includes("access_token") || new URLSearchParams(location.search).has("code");

  $("inbox-addr").textContent = S.cfg.inboxAddress || "musicinslc@gmail.com";
  $("demo-note").hidden = S.live;

  // ---------- your shows ----------
  function counts() {
    const c = { going: 0, maybe: 0 };
    for (const e of events) { const s = P.status(e.id); if (s) c[s]++; }
    return c;
  }

  function syncCounts() {
    const c = counts();
    $("n-all").textContent = c.going + c.maybe ? String(c.going + c.maybe) : "";
    $("n-going").textContent = c.going ? String(c.going) : "";
    $("n-maybe").textContent = c.maybe ? String(c.maybe) : "";
    document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tab === tab)));
    const p = P.profile;
    $("you-name").textContent = p ? p.display_name : "You";
    $("you-sub-head").textContent = p
      ? `@${p.handle} · ${P.visibilityNote()}`
      : "The shows you've said yes and maybe to.";
  }

  // The list is drawn when the page loads and when you switch tabs. A show you un-mark stays put until then,
  // so a slip of the thumb can be undone in place.
  function renderShows() {
    syncCounts();
    const mine = events.filter((e) => {
      const s = P.status(e.id);
      return s && (tab === "all" || s === tab);
    });
    if (!mine.length) {
      const c = counts();
      const none = c.going + c.maybe === 0;
      $("my-shows").innerHTML = `<div class="empty you-empty">
        <strong>${none ? "No plans yet" : tab === "going" ? "Nothing marked Going" : "Nothing marked Maybe"}</strong>
        ${none ? "Tap Maybe or Going on any show and it lands here." : "Switch to All to see the rest of your shows."}
        ${none ? `<p><a class="btn primary" href="index.html">Browse the calendar</a> <a class="btn" href="week.html">This week</a></p>` : ""}
      </div>`;
      return;
    }
    mine.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    const byDay = new Map();
    for (const e of mine) {
      const k = S.dayKey(e.starts_at);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e);
    }
    let html = "";
    for (const [k, shows] of byDay) html += C.dayHtml(k, shows);
    $("my-shows").innerHTML = html;
  }

  document.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => {
    tab = b.dataset.tab;
    S.store.set(TAB, tab);
    renderShows();
  });

  // ---------- settings ----------
  const youPref = S.store.get(YOU, { setUp: false });
  if (T.profile) youPref.setUp = true;

  const isOpen = () => !$("you-body").hidden;
  function setOpen(open) {
    $("you-body").hidden = !open;
    $("you").dataset.open = String(open);
    $("you-toggle").setAttribute("aria-expanded", String(open));
    syncSettings();
  }
  function done() {
    youPref.setUp = true;
    S.store.set(YOU, youPref);
    setOpen(false);
    $("you-toggle").focus({ preventScroll: true });
  }
  $("you-toggle").onclick = () => (isOpen() ? done() : setOpen(true));
  $("you-done").onclick = done;

  // Used by plans.js when someone taps "Sign in to add" on a person's page
  window.SLCYou = {
    focusSignIn() {
      setOpen(true);
      $("you").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      setTimeout(() => $("signin-email")?.focus({ preventScroll: true }), 350);
    },
  };

  function showTasteError(msg) { $("taste-error").textContent = msg; $("taste-error").hidden = !msg; }

  function syncSettings() {
    const on = Boolean(T.profile);
    const open = isOpen();
    $("you").dataset.active = String(on || Boolean(P.user));

    // Folded summary
    const bits = [];
    if (P.profile) bits.push(`Signed in as <strong>${S.esc(P.profile.display_name)}</strong>`);
    else if (P.social) bits.push("Not signed in");
    if (P.profile) bits.push(S.esc(P.visibilityNote().replace(/\.$/, "")));
    if (on) bits.push(`Music from ${S.esc(T.summary().label)}`);
    $("you-summary").innerHTML = bits.length && (P.profile || on)
      ? bits.join('<span class="dot" aria-hidden="true"> · </span>')
      : "Sign in, choose who sees your plans, and connect your listening.";
    $("you-toggle").textContent = open ? "Close" : youPref.setUp || P.profile || on ? "Edit" : "Set up";

    // Account
    const social = P.social;
    $("acct-off").hidden = social;
    $("acct-out").hidden = !social || Boolean(P.user);
    $("acct-in").hidden = !social || !P.profile;
    if (P.profile && !$("acct-in").dataset.filled) fillProfile();

    // Music
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
        (s.text ? ` (${S.esc(s.text)})` : "") + `. <a href="index.html">See them on the calendar</a>`;
    }
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
      syncSettings();
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
  $("taste-clear").onclick = () => { T.save(null); syncSettings(); };

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
    if (r.ok) { delete $("acct-in").dataset.filled; fillProfile(); syncCounts(); }
  };
  $("share-btn").onclick = (ev) => P.shareLink(ev.currentTarget);
  $("sign-out").onclick = async () => { await P.signOut(); delete $("acct-in").dataset.filled; };

  let lastUser = null;
  P.onChange(() => {
    if (P.profile) {
      if (!$("acct-in").dataset.filled) fillProfile(); else renderFriends();
    } else {
      delete $("acct-in").dataset.filled;
    }
    syncSettings();
    // Signing in or out swaps in a different set of plans
    const uid = P.user?.id || null;
    if (uid !== lastUser) { lastUser = uid; renderShows(); } else syncCounts();
  });

  // ---------- load ----------
  try {
    const genres = await S.loadGenres();
    window.SLC_GENRE_LABELS = Object.fromEntries(genres.map((g) => [g.id, g.label]));
    $("manual-genres").innerHTML = genres.map((g) =>
      `<label><input type="checkbox" value="${g.id}"> ${S.esc(g.label)}</label>`).join("");
    const artistsLoad = S.loadArtists();
    events = await S.loadEvents();
    for (const [k, v] of await artistsLoad) artists.set(k, v);
    for (const e of events) e._match = T.score(e);
    syncSettings();
    renderShows();
    details.fromHash();
    await P.start({ find });
    lastUser = P.user?.id || null;
    renderShows();
    // Settings start open until they've been set up once, or when arriving from a sign-in link
    if (!youPref.setUp && !P.profile) setOpen(true);
    else syncSettings();
    if (fromSignIn && P.profile) {
      setOpen(true);
      $("you").scrollIntoView({ block: "start" });
    }
  } catch (err) {
    $("my-shows").innerHTML = `<div class="empty"><strong>Shows didn't load</strong>${S.esc(err.message)}</div>`;
  }
})();
