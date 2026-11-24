// Moderation: approve or reject submissions and emailed shows, watch scraper health.
(async function () {
  const S = window.SLC;
  const $ = (id) => document.getElementById(id);
  if (!S.live) { $("not-live").hidden = false; return; }

  const sb = window.supabase.createClient(S.cfg.supabaseUrl, S.cfg.supabaseAnonKey);
  const genres = await S.loadGenres();
  const LABEL = Object.fromEntries(genres.map((g) => [g.id, g.label]));
  let venues = [];

  // Same fingerprint rules as ingest/slclive/normalize.py, so approved shows merge with later scrapes
  const ascii = (s) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const slugify = (s) => ascii(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const venueKey = (n) => ascii(n).toLowerCase().replace(/\b(salt lake city|slc|utah|ut)\b/g, " ").trim()
    .replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "");
  function venueFor(name) {
    const k = venueKey(name || "");
    return venues.find((v) => [v.name, ...(v.aliases || [])].some((n) => venueKey(n) === k));
  }
  function fingerprint(row) {
    const v = venueFor(row.venue_name);
    const venuePart = v ? v.slug : (slugify(row.venue_name).slice(0, 40) || "unknown-venue");
    const head = ascii((row.artists?.[0] || row.title)).toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "").slice(0, 40) || "show";
    return `${venuePart}|${S.dayKey(row.starts_at)}|${head}`;
  }

  // ---------- auth ----------
  $("login").onsubmit = async (ev) => {
    ev.preventDefault();
    const { error } = await sb.auth.signInWithOtp({ email: $("login-email").value.trim(), options: { emailRedirectTo: location.href } });
    const msg = $("login-msg");
    msg.hidden = false;
    msg.className = `notice ${error ? "err" : "ok"}`;
    msg.textContent = error ? error.message : "Check your email for the sign-in link.";
  };
  $("sign-out").onclick = async (ev) => { ev.preventDefault(); await sb.auth.signOut(); location.reload(); };

  async function start(session) {
    if (!session) { $("login").hidden = false; return; }
    $("sign-out").hidden = false;
    const { data: admin } = await sb.from("admins").select("user_id").eq("user_id", session.user.id).maybeSingle();
    if (!admin) { $("who").textContent = session.user.email; $("not-admin").hidden = false; return; }
    $("admin").hidden = false;
    venues = (await sb.from("venues").select("id,slug,name,aliases,city")).data || [];
    await loadArtistRows();
    await Promise.all([loadQueue(), loadHealth(), loadRecent(), loadBandNames()]);
  }

  // ---------- queue ----------
  const localInput = (iso) => {
    const d = new Date(iso);
    const day = S.dayKey(d);
    const t = new Intl.DateTimeFormat("en-US", { timeZone: S.TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    return { day, t };
  };

  let artistRows = new Map();
  async function loadArtistRows() {
    const { data } = await sb.from("artists").select("key,name,homepage,links,source,locked").limit(10000);
    artistRows = new Map((data || []).map((a) => [a.key, a]));
  }
  function mainLink(name) {
    const a = artistRows.get(S.artistKey(name));
    if (!a) return "";
    return a.homepage || Object.values(a.links || {})[0] || "";
  }

  // Save one link for a band, keeping the others; admin-saved bands are locked
  async function saveBandLink(name, url) {
    const key = S.artistKey(name);
    if (!key || !url) return null;
    const cur = artistRows.get(key) || { key, name, homepage: null, links: {} };
    const kind = S.linkKind(url);
    if (!kind) return "That link doesn't look like a web address.";
    const row = { key, name: cur.name || name, homepage: cur.homepage, links: { ...(cur.links || {}) }, source: "admin", locked: true };
    if (kind === "homepage") row.homepage = url; else row.links[kind] = url;
    const { error } = await sb.from("artists").upsert(row);
    if (error) return error.message;
    artistRows.set(key, row);
    return null;
  }

  const REJECT_REASONS = [
    ["not_music", "Not music (sports, comedy, talks)"], ["outside_county", "Outside the county"],
    ["duplicate", "Already listed"], ["wrong_details", "Wrong or missing details"],
    ["private", "Private event"], ["spam", "Spam or promo"], ["other", "Other"],
  ];
  const queueRows = new Map();
  const sameList = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());

  // What the reviewer changed before publishing, so the sources that get details wrong stand out
  function editsMade(e, u, linkChanged) {
    const out = [];
    if (u.title !== e.title) out.push("title");
    if (JSON.stringify(u.artists) !== JSON.stringify(e.artists || [])) out.push("artists");
    if (new Date(u.starts_at).getTime() !== new Date(e.starts_at).getTime()) out.push("date_time");
    if (u.venue_name !== e.venue_name) out.push("venue");
    if ((u.city || null) !== (e.city || null) && e.city) out.push("city");
    if ((u.price_min ?? null) !== (e.price_min ?? null)) out.push("price");
    if ((u.age_restriction || null) !== (e.age_restriction || null)) out.push("ages");
    if (!sameList(u.genres, e.genres)) out.push("genres");
    if ((u.ticket_url || null) !== (S.safeUrl(e.ticket_url || "") || null)) out.push("ticket_link");
    if ((u.image_url || null) !== (S.safeUrl(e.image_url || "") || null)) out.push("flyer");
    if (linkChanged) out.push("band_link");
    return out;
  }

  function itemHtml(e) {
    queueRows.set(String(e.id), e);
    const { day, t } = localInput(e.starts_at);
    const head = (e.artists || [])[0] || e.title;
    const offered = e.artist_url || "";
    const known = mainLink(head);
    const from = e.source === "email" ? `Email from ${e.submitter_email || "unknown"}` : `Submitted by ${e.submitter_name || "?"} (${e.submitter_email || "no email"})`;
    return `<form class="card queue-item" data-id="${e.id}" data-image="${S.esc(e.image_url || "")}">
      <header><strong>${S.esc(e.title)}</strong><span class="meta">${S.esc(from)}${e.submitter_notes ? ` · ${S.esc(e.submitter_notes)}` : ""}</span></header>
      <div class="grid-2">
        <div class="field"><label for="t-${e.id}">Title</label><input id="t-${e.id}" name="title" value="${S.esc(e.title)}" required></div>
        <div class="field"><label for="a-${e.id}">Artists, headliner first</label><input id="a-${e.id}" name="artists" value="${S.esc((e.artists || []).join(", "))}"></div>
      </div>
      <div class="grid-3">
        <div class="field"><label for="d-${e.id}">Date</label><input id="d-${e.id}" name="date" type="date" value="${day}" required></div>
        <div class="field"><label for="s-${e.id}">Show time</label><input id="s-${e.id}" name="time" type="time" value="${t}" required></div>
        <div class="field"><label for="p-${e.id}">Cover $</label><input id="p-${e.id}" name="price" type="number" min="0" value="${e.price_min ?? ""}"></div>
      </div>
      <div class="grid-3">
        <div class="field"><label for="v-${e.id}">Venue</label><input id="v-${e.id}" name="venue" value="${S.esc(e.venue_name)}" list="venue-names" required></div>
        <div class="field"><label for="c-${e.id}">City</label><input id="c-${e.id}" name="city" value="${S.esc(e.city || "")}"></div>
        <div class="field"><label for="g-${e.id}">Ages</label><select id="g-${e.id}" name="age">
          ${[["", "Not sure"], ["all_ages", "All ages"], ["18_plus", "18+"], ["21_plus", "21+"]].map(([v, l]) => `<option value="${v}"${e.age_restriction === v ? " selected" : ""}>${l}</option>`).join("")}
        </select></div>
      </div>
      <div class="field"><span class="label">Genres</span><div class="checks">${genres.map((g) =>
        `<label><input type="checkbox" name="genre" value="${g.id}"${(e.genres || []).includes(g.id) ? " checked" : ""}> ${S.esc(g.label)}</label>`).join("")}</div></div>
      <div class="field"><label for="u-${e.id}">Ticket link</label><input id="u-${e.id}" name="ticket" type="url" value="${S.esc(e.ticket_url || "")}"></div>
      <div class="grid-2">
        <div class="field"><label for="l-${e.id}">Headliner's link <span class="opt">${offered && offered !== known ? "(offered by the sender, check it)" : known ? "(already on file)" : "(optional)"}</span></label>
          <input id="l-${e.id}" name="artist_link" type="url" value="${S.esc(offered || known)}" data-known="${S.esc(known)}"></div>
        <div class="field"><label for="i-${e.id}">Flyer image link <span class="opt">(optional)</span></label>
          <input id="i-${e.id}" name="image" type="url" value="${S.esc(S.safeUrl(e.image_url) || "")}"></div>
      </div>
      ${S.safeUrl(e.image_url) ? `<img class="queue-flyer" src="${S.esc(S.safeUrl(e.image_url))}" alt="Flyer for ${S.esc(e.title)}" loading="lazy" referrerpolicy="no-referrer">` : ""}
      ${e.description ? `<p class="meta">${S.esc(e.description)}</p>` : ""}
      <div class="field"><span class="label">If rejecting, why?</span><div class="checks">${REJECT_REASONS.map(([v, l]) =>
        `<label><input type="radio" name="reason" value="${v}"> ${S.esc(l)}</label>`).join("")}</div></div>
      <div class="field"><label for="n-${e.id}">Note <span class="opt">(optional, for you later)</span></label>
        <input id="n-${e.id}" name="note" maxlength="500" placeholder="Anything worth remembering about this one"></div>
      <div class="notice err" hidden></div>
      <div class="form-actions">
        <button class="btn primary" type="submit" value="publish">Publish</button>
        <button class="btn" type="submit" value="reject">Reject</button>
      </div>
    </form>`;
  }

  async function loadQueue() {
    const { data, error } = await sb.from("events").select("*").eq("status", "pending").order("starts_at").limit(200);
    if (error) { $("queue-summary").textContent = error.message; return; }
    $("queue-summary").textContent = data.length ? `${data.length} show${data.length === 1 ? "" : "s"} waiting for review.` : "Nothing waiting. Nice.";
    $("queue").innerHTML = `<datalist id="venue-names">${venues.map((v) => `<option value="${S.esc(v.name)}">`).join("")}</datalist>` + data.map(itemHtml).join("");
    document.querySelectorAll(".queue-item").forEach((form) => form.addEventListener("submit", onDecision));
  }

  async function onDecision(ev) {
    ev.preventDefault();
    const form = ev.currentTarget;
    const err = form.querySelector(".notice.err");
    err.hidden = true;
    const id = form.dataset.id;
    const f = Object.fromEntries(new FormData(form));
    const orig = queueRows.get(String(id)) || {};
    const note = (f.note || "").trim() || null;
    let update, review;
    if (ev.submitter.value === "reject") {
      if (!f.reason) { err.hidden = false; err.textContent = "Pick a reason for rejecting, so the patterns add up over time."; return; }
      update = { status: "rejected" };
      review = { review_reason: f.reason, review_notes: note, review_edits: [], reviewed_at: new Date().toISOString() };
    } else {
      const [hh, mm] = f.time.split(":").map(Number);
      const artists = f.artists.split(",").map((s) => s.trim()).filter(Boolean);
      const v = venueFor(f.venue);
      update = {
        status: "published",
        title: f.title.trim(),
        artists: artists.length ? artists : [f.title.trim()],
        starts_at: S.mountainTime(f.date, hh, mm).toISOString(),
        venue_name: v ? v.name : f.venue.trim(),
        venue_id: v ? v.id : null,
        city: f.city.trim() || (v && v.city) || null,
        price_min: f.price === "" ? null : Number(f.price),
        is_free: f.price === "0",
        age_restriction: f.age || null,
        genres: [...form.querySelectorAll('input[name="genre"]:checked')].map((b) => b.value),
        ticket_url: S.safeUrl(f.ticket) || null,
        image_url: S.safeUrl(f.image) || null,
      };
      if (update.image_url && update.image_url !== S.safeUrl(form.dataset.image || "")) update.image_kind = "flyer";
      if (!update.image_url) update.image_kind = null;
      update.fingerprint = fingerprint(update);
      const link = S.safeUrl(f.artist_link || "");
      const known = form.querySelector('[name="artist_link"]').dataset.known;
      const offered = S.safeUrl(orig.artist_url || "") || known || "";
      if (link && link !== known) {
        const problem = await saveBandLink(update.artists[0], link);
        if (problem) { err.hidden = false; err.textContent = problem; return; }
      }
      const edits = editsMade(orig, update, (link || "") !== offered);
      review = { review_reason: edits.length ? "approved_edited" : "approved", review_edits: edits,
        review_notes: note, reviewed_at: new Date().toISOString() };
    }
    let { error } = await sb.from("events").update({ ...update, ...review }).eq("id", id);
    if (error && /review_reason|review_edits|reviewed_at/.test(error.message || "")) {
      // Migration 004 not run yet: still save the decision, and say how to keep the reasons
      ({ error } = await sb.from("events").update({ ...update, review_notes: note }).eq("id", id));
      if (!error) $("queue-summary").dataset.warn = "1";
    }
    if (error) {
      err.hidden = false;
      err.textContent = error.code === "23505"
        ? "This show is already on the calendar (same venue, date and headliner). Reject this copy."
        : error.message;
      return;
    }
    form.remove();
    const left = document.querySelectorAll(".queue-item").length;
    $("queue-summary").textContent = (left ? `${left} show${left === 1 ? "" : "s"} waiting for review.` : "Nothing waiting. Nice.")
      + ($("queue-summary").dataset.warn ? " Reasons aren't being saved yet: run supabase/migrations/004_review_reasons.sql." : "");
    if (update.status === "published") loadRecent();
  }

  // ---------- band links ----------
  const KIND_HINT = { homepage: "https://band.com", bandcamp: "https://band.bandcamp.com", instagram: "https://www.instagram.com/band",
    spotify: "https://open.spotify.com/artist/...", youtube: "https://www.youtube.com/@band", soundcloud: "https://soundcloud.com/band",
    tiktok: "https://www.tiktok.com/@band", facebook: "https://www.facebook.com/band", twitter: "https://x.com/band", linktree: "https://linktr.ee/band" };
  let bandKey = null;

  async function loadBandNames() {
    const { data } = await sb.from("events").select("artists").eq("status", "published")
      .gte("starts_at", new Date().toISOString()).limit(2000);
    const names = new Set();
    for (const e of data || []) for (const a of (e.artists || []).slice(0, 3)) names.add(a);
    $("band-names").innerHTML = [...names].sort((a, b) => a.localeCompare(b)).map((n) => `<option value="${S.esc(n)}">`).join("");
  }

  function showBand() {
    const name = $("band-name").value.trim();
    bandKey = S.artistKey(name);
    if (!bandKey) return;
    const a = artistRows.get(bandKey);
    const all = { ...((a && a.links) || {}), ...(a && a.homepage ? { homepage: a.homepage } : {}) };
    $("band-status").textContent = !a ? "No links on file yet."
      : a.locked ? "Saved by an admin; the robots leave this band alone."
      : `Filled in automatically from ${a.source || "an unknown source"}.`;
    $("band-inputs").innerHTML = S.LINK_ORDER.map((k) => `<div class="field"><label for="bl-${k}">${S.esc(S.LINK_LABELS[k] === "Links" ? "Linktree" : S.LINK_LABELS[k])}</label>
      <input id="bl-${k}" data-kind="${k}" type="url" value="${S.esc(all[k] || "")}" placeholder="${S.esc(KIND_HINT[k])}"></div>`).join("");
    $("band-unlock").hidden = !(a && a.locked);
    $("band-msg").hidden = true;
    $("band-fields").hidden = false;
  }
  $("band-load").onclick = showBand;
  $("band-name").addEventListener("change", showBand);
  $("band-form").onsubmit = async (ev) => {
    ev.preventDefault();
    if (!bandKey) return showBand();
    const name = $("band-name").value.trim();
    const row = { key: bandKey, name: (artistRows.get(bandKey) || {}).name || name, homepage: null, links: {}, source: "admin", locked: true };
    for (const input of $("band-inputs").querySelectorAll("input")) {
      const url = S.safeUrl(input.value.trim());
      if (input.value.trim() && !url) { bandMsg(`The ${input.dataset.kind} link should start with https://`, true); return; }
      if (!url) continue;
      if (input.dataset.kind === "homepage") row.homepage = url; else row.links[input.dataset.kind] = url;
    }
    const { error } = await sb.from("artists").upsert(row);
    if (error) return bandMsg(error.message, true);
    artistRows.set(bandKey, row);
    bandMsg(Object.keys(row.links).length || row.homepage ? "Saved." : "Saved with no links, so none will show.", false);
    $("band-unlock").hidden = false;
  };
  $("band-unlock").onclick = async () => {
    const cur = artistRows.get(bandKey);
    if (!cur) return;
    const { error } = await sb.from("artists").update({ locked: false, checked_at: null }).eq("key", bandKey);
    if (error) return bandMsg(error.message, true);
    artistRows.set(bandKey, { ...cur, locked: false });
    bandMsg("The robots can add to this band's links again.", false);
    $("band-unlock").hidden = true;
  };
  function bandMsg(text, bad) {
    const m = $("band-msg");
    m.hidden = false; m.className = `notice ${bad ? "err" : "ok"}`; m.textContent = text;
  }

  // ---------- health + recent ----------
  async function loadHealth() {
    const { data } = await sb.from("source_health").select("*").order("ok").order("source");
    $("health").innerHTML = (data || []).map((r) => `<tr>
      <td class="mono">${S.esc(r.source)}</td>
      <td><span class="pill ${r.ok ? "ok" : "bad"}">${r.ok ? "Working" : "Failing"}</span></td>
      <td>${S.esc(new Date(r.ran_at).toLocaleString("en-US", { timeZone: S.TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</td>
      <td>${r.found ?? ""}</td><td>${r.inserted ?? ""}</td>
      <td class="err">${S.esc(r.error || "")}</td></tr>`).join("") || `<tr><td colspan="6">No runs yet. The first scheduled run fills this in.</td></tr>`;
  }

  // One published show as a table row with a Hide button (Recently added and Published shows)
  const showRow = (e) => `<tr data-id="${S.esc(e.id)}">
      <td>${S.esc(S.fmtDow(e.starts_at))} ${S.esc(S.fmtMon(e.starts_at))} ${S.esc(S.fmtNum(e.starts_at))}</td>
      <td>${S.esc(e.title)}</td><td>${S.esc(e.venue_name)}</td><td class="mono">${S.esc(e.source)}</td>
      <td><button class="btn ghost" type="button" data-hide="${S.esc(e.id)}">Hide</button></td></tr>`;

  // Hiding marks the show rejected. The scrapers load rejected rows too, so it never comes back.
  async function setShowStatus(id, status) {
    const { error } = await sb.from("events").update({ status }).eq("id", id);
    return error;
  }

  async function loadRecent() {
    const { data } = await sb.from("events").select("id,title,venue_name,starts_at,source,status")
      .eq("status", "published").order("created_at", { ascending: false }).limit(25);
    $("recent").innerHTML = (data || []).map(showRow).join("");
    $("recent").querySelectorAll("[data-hide]").forEach((b) => b.onclick = async () => {
      const error = await setShowStatus(b.dataset.hide, "rejected");
      if (!error) b.closest("tr").remove();
    });
  }

  // ---------- published shows: find any upcoming show and hide it ----------
  function findMsg(text, bad) {
    const m = $("find-msg");
    m.hidden = !text; m.className = `notice ${bad ? "err" : "ok"}`; m.textContent = text || "";
  }

  // Hide and Undo swap in place, so a slip is one tap to put back
  function hideButton(cell, id) {
    cell.innerHTML = `<button class="btn ghost" type="button">Hide</button>`;
    const b = cell.querySelector("button");
    b.onclick = async () => {
      b.disabled = true;
      const error = await setShowStatus(id, "rejected");
      if (error) { b.disabled = false; return findMsg(error.message, true); }
      findMsg("");
      undoButton(cell, id);
      loadRecent();
    };
  }
  function undoButton(cell, id) {
    cell.innerHTML = `<span class="meta">Hidden</span> <button class="btn ghost" type="button">Undo</button>`;
    const b = cell.querySelector("button");
    b.onclick = async () => {
      b.disabled = true;
      const error = await setShowStatus(id, "published");
      if (error) { b.disabled = false; return findMsg(error.message, true); }
      findMsg("");
      hideButton(cell, id);
      loadRecent();
    };
  }

  $("find-form").onsubmit = async (ev) => {
    ev.preventDefault();
    // Keep the words only: commas, brackets and quotes would break the search filter
    const term = $("find-q").value.replace(/[^\p{L}\p{N}\s&'-]/gu, " ").replace(/\s+/g, " ").trim();
    if (term.length < 2) return findMsg("Type at least two letters of a show or venue.", true);
    const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();   // tonight's shows still count
    const like = `*${term.split(" ").join("*")}*`;   // words in order, anything between: "hoard vine" finds "Hoard Nation: Vine"
    const { data, error } = await sb.from("events").select("id,title,venue_name,starts_at,source")
      .eq("status", "published").gte("starts_at", since)
      .or(`title.ilike.${like},venue_name.ilike.${like}`)
      .order("starts_at").limit(50);
    if (error) { $("find-results").hidden = true; return findMsg(error.message, true); }
    $("found").innerHTML = data.map(showRow).join("");
    $("found").querySelectorAll("[data-hide]").forEach((b) => hideButton(b.parentElement, b.dataset.hide));
    $("find-results").hidden = !data.length;
    findMsg(data.length ? (data.length === 50 ? "Showing the first 50. Add a word to narrow it down." : "")
      : `No upcoming published show matches "${term}".`, !data.length);
  };

  const { data: { session } } = await sb.auth.getSession();
  sb.auth.onAuthStateChange((event, s) => { if (event === "SIGNED_IN" && !session) location.reload(); });
  start(session);
})();
