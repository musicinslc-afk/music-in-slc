// Maybe and Going, signing in, friends, and who can see your plans.
// Signed out, plans live in this browser. Signing in moves them to your account, where the people your
// profile allows (just you, friends, or everyone) can see them. Totals count everyone without naming anyone.
(function () {
  const S = window.SLC;
  const LOCAL = "slc.plans.v1";
  const PENDING_FRIEND = "slc.addfriend.v1";
  const sb = S.live && window.supabase ? window.supabase.createClient(S.cfg.supabaseUrl, S.cfg.supabaseAnonKey) : null;
  const esc = S.esc;

  const st = {
    user: null,
    profile: null,
    mine: new Map(Object.entries(S.store.get(LOCAL, {}))), // event id -> "maybe" | "going"
    people: new Map(),   // event id -> [{ user_id, name, handle, status }]
    counts: new Map(),   // event id -> { going, maybe }
    out: new Set(),      // people you've added
    in: new Set(),       // people who've added you
    names: new Map(),    // user id -> { user_id, handle, display_name, visibility }
    social: Boolean(sb), // false when the database doesn't have these tables yet
    ready: false,
  };
  let find = () => null;
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => { try { f(); } catch (err) { console.error(err); } });
  const since = () => new Date(Date.now() - 6 * 3600e3).toISOString();

  function saveLocal() { S.store.set(LOCAL, Object.fromEntries(st.mine)); }
  const isFriend = (id) => st.out.has(id) && st.in.has(id);

  // ---------- loading ----------
  async function loadMine() {
    if (!st.user) return;
    const { data, error } = await sb.from("rsvps").select("event_id,status").eq("user_id", st.user.id);
    if (!error) st.mine = new Map((data || []).map((r) => [String(r.event_id), r.status]));
  }

  async function loadSocial() {
    if (!sb || !st.social) return;
    const [counts, rows] = await Promise.all([
      sb.rpc("rsvp_counts", { since: since() }),
      sb.from("rsvps").select("event_id,status,user_id,profiles(handle,display_name),events!inner(starts_at)")
        .gte("events.starts_at", since()).limit(5000),
    ]);
    if (counts.error && rows.error) { st.social = false; return; } // migration 003 not run yet
    st.counts = new Map((counts.data || []).map((r) => [String(r.event_id), { going: r.going, maybe: r.maybe }]));
    st.people = new Map();
    for (const r of rows.data || []) {
      if (!r.profiles || (st.user && r.user_id === st.user.id)) continue;
      const k = String(r.event_id);
      if (!st.people.has(k)) st.people.set(k, []);
      st.people.get(k).push({ user_id: r.user_id, name: r.profiles.display_name, handle: r.profiles.handle, status: r.status });
    }
  }

  async function loadFollows() {
    st.out = new Set(); st.in = new Set();
    if (!st.user) return;
    const me = st.user.id;
    const { data } = await sb.from("follows").select("follower,followee");
    for (const f of data || []) {
      if (f.follower === me) st.out.add(f.followee);
      if (f.followee === me) st.in.add(f.follower);
    }
    const ids = [...new Set([...st.out, ...st.in])];
    if (ids.length) {
      const { data: ps } = await sb.from("profiles").select("user_id,handle,display_name,visibility").in("user_id", ids);
      for (const p of ps || []) st.names.set(p.user_id, p);
    }
  }

  function nameFromEmail(email) {
    const local = String(email || "").split("@")[0];
    const words = local.replace(/[._+-]+/g, " ").replace(/\d+/g, " ").trim().split(/\s+/).filter(Boolean);
    return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ").slice(0, 40) || "Music fan";
  }

  async function ensureProfile() {
    const u = st.user;
    const got = await sb.from("profiles").select("user_id,handle,display_name,visibility").eq("user_id", u.id).maybeSingle();
    if (got.error) { st.social = false; return; }
    let p = got.data;
    if (!p) {
      let base = String(u.email || "").split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 18);
      if (base.length < 3) base = `fan${base}`.slice(0, 18);
      for (let i = 0; i < 6 && !p; i++) {
        const handle = i ? `${base}${Math.floor(100 + Math.random() * 900)}` : base;
        const r = await sb.from("profiles").insert({ user_id: u.id, handle, display_name: nameFromEmail(u.email) })
          .select("user_id,handle,display_name,visibility").single();
        if (!r.error) p = r.data;
        else if (r.error.code !== "23505") break; // only retry when the handle is taken
      }
    }
    st.profile = p || null;
  }

  // Plans made before signing in move to the account; the account wins where both have a show.
  async function syncLocal() {
    const local = S.store.get(LOCAL, {});
    const rows = Object.entries(local).filter(([id]) => /^[0-9a-f-]{36}$/i.test(id))
      .map(([event_id, status]) => ({ user_id: st.user.id, event_id, status }));
    if (rows.length) {
      const { error } = await sb.from("rsvps").upsert(rows, { onConflict: "user_id,event_id", ignoreDuplicates: true });
      if (error) return;
    }
    S.store.remove(LOCAL);
  }

  async function setUser(user) {
    st.user = user || null;
    st.profile = null;
    if (st.user && sb) {
      await ensureProfile();
      if (st.profile) {
        await syncLocal();
        await loadMine();
        await loadFollows();
        const pending = S.store.get(PENDING_FRIEND, null);
        if (pending) { S.store.remove(PENDING_FRIEND); await addFriendByHandle(pending); }
      }
    } else {
      st.mine = new Map(Object.entries(S.store.get(LOCAL, {})));
      st.out = new Set(); st.in = new Set();
    }
    await loadSocial();
  }

  async function start(opts = {}) {
    if (opts.find) find = opts.find;
    if (sb) {
      try {
        const { data: { session } } = await sb.auth.getSession();
        await setUser(session?.user);
      } catch (err) { console.error(err); }
      sb.auth.onAuthStateChange((event, session) => {
        const id = session?.user?.id || null;
        if ((event === "SIGNED_IN" || event === "SIGNED_OUT") && id !== (st.user?.id || null)) {
          setUser(session?.user).then(() => { refreshAll(); emit(); });
        }
      });
    }
    st.ready = true;
    refreshAll();
    emit();
    const h = new URLSearchParams(location.search).get("u");
    if (h) openProfile(h);
  }

  // ---------- your plans ----------
  function status(id) { return st.mine.get(String(id)) || null; }

  function bump(id, s, n) {
    if (!s) return;
    const c = st.counts.get(id) || { going: 0, maybe: 0 };
    c[s] = Math.max(0, (c[s] || 0) + n);
    st.counts.set(id, c);
  }

  async function set(id, wanted) {
    id = String(id);
    const prev = st.mine.get(id) || null;
    const next = prev === wanted ? null : wanted;
    const apply = (from, to) => {
      if (to) st.mine.set(id, to); else st.mine.delete(id);
      bump(id, from, -1); bump(id, to, 1);
      refresh(id); emit();
    };
    apply(prev, next);
    if (st.user && st.profile) {
      const q = next
        ? sb.from("rsvps").upsert({ user_id: st.user.id, event_id: id, status: next }, { onConflict: "user_id,event_id" })
        : sb.from("rsvps").delete().eq("user_id", st.user.id).eq("event_id", id);
      const { error } = await q;
      if (error) { apply(next, prev); toast("That didn't save. Check your connection and try again."); }
    } else {
      saveLocal();
    }
  }

  // ---------- markup ----------
  function nameList(names) {
    if (names.length === 1) return names[0];
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  function personLink(p) {
    return `<a href="?u=${encodeURIComponent(p.handle)}" data-profile="${esc(p.handle)}">${esc(p.name)}</a>`;
  }
  function visiblePeople(id) {
    const list = (st.people.get(id) || []).slice();
    list.sort((a, b) => Number(isFriend(b.user_id)) - Number(isFriend(a.user_id)) || a.name.localeCompare(b.name));
    return list;
  }

  // One line for a card: who you know that's going, then the totals
  function socialLine(id) {
    const ppl = visiblePeople(id);
    const going = ppl.filter((p) => p.status === "going");
    const maybe = ppl.filter((p) => p.status === "maybe");
    const c = st.counts.get(id) || { going: 0, maybe: 0 };
    const bits = [];
    if (going.length) {
      const shown = going.slice(0, 2).map(personLink);
      const more = going.length - shown.length;
      bits.push(`<span class="who">${more ? `${shown.join(", ")} and ${more} more` : nameList(shown)} going</span>`);
    } else if (maybe.length) {
      bits.push(`<span class="who">${nameList(maybe.slice(0, 2).map(personLink))}${maybe.length > 2 ? ` and ${maybe.length - 2} more` : ""} interested</span>`);
    }
    // Totals only say something once someone besides you has picked the show
    const mine = status(id);
    const othersPicked = (c.going || 0) + (c.maybe || 0) - (mine ? 1 : 0) > 0;
    const tally = othersPicked ? [c.going ? `${c.going} going` : "", c.maybe ? `${c.maybe} maybe` : ""].filter(Boolean).join(" · ") : "";
    if (tally) bits.push(`<span class="tally">${tally}</span>`);
    return bits.length ? `<div class="plans-social">${bits.join("")}</div>` : "";
  }

  function buttons(e, id, mine) {
    const b = (s, label) => `<button type="button" class="rsvp rsvp-${s}" data-rsvp="${s}" data-id="${esc(id)}" aria-pressed="${mine === s}">${label}</button>`;
    return `<div class="rsvp-pair" role="group" aria-label="Your plans for ${esc(e.title)}">${b("maybe", "Maybe")}${b("going", "Going")}</div>`;
  }

  // kind: "card" for list and week cards, "detail" for the show view
  function html(e, kind = "card") {
    const id = String(e.id);
    const mine = status(id);
    const cancelled = e.status === "cancelled";
    let inner = "";
    if (kind === "detail") inner = detailInner(e, id, mine, cancelled);
    else inner = `${cancelled && !mine ? "" : buttons(e, id, mine)}${socialLine(id)}`;
    return `<div class="plans plans-${kind}" data-plans="${esc(id)}" data-kind="${kind}">${inner}</div>`;
  }

  function detailInner(e, id, mine, cancelled) {
    const ppl = visiblePeople(id);
    const c = st.counts.get(id) || { going: 0, maybe: 0 };
    const group = (s, label) => {
      const named = ppl.filter((p) => p.status === s);
      const total = Math.max(c[s] || 0, named.length + (mine === s ? 1 : 0));
      const others = total - named.length - (mine === s ? 1 : 0);
      if (!total) return "";
      const parts = [...(mine === s ? ["You"] : []), ...named.map(personLink)];
      if (others > 0) parts.push(parts.length ? `${others} other${others === 1 ? "" : "s"}` : `${others} ${others === 1 ? "person" : "people"}`);
      return `<p class="plans-group"><span class="plans-k">${label} · ${total}</span> ${nameList(parts)}</p>`;
    };
    const hint = !st.user && sb && st.social
      ? `<p class="plans-hint">Saved in this browser. <a href="index.html?you=1" data-you-link>Sign in under You</a> to keep plans on every device and share them with friends.</p>`
      : st.profile ? `<p class="plans-hint">${visibilityNote()} <a href="index.html?you=1" data-you-link>Change</a></p>` : "";
    return `<h3 class="sd-label">Your plans</h3>
      ${cancelled && !mine ? '<p class="plans-hint">This show was cancelled.</p>' : buttons(e, id, mine)}
      ${group("going", "Going")}${group("maybe", "Maybe")}
      ${mine ? hint : ""}`;
  }

  function visibilityNote() {
    const v = st.profile?.visibility;
    return v === "public" ? "Anyone can see your plans." : v === "private" ? "Only you can see your plans." : "Your friends can see your plans.";
  }

  // Redraw every place a show's plans appear, keeping focus on the button that was pressed
  function refresh(id) {
    const active = document.activeElement;
    const refocus = active?.dataset?.rsvp && active.dataset.id === id ? active.dataset.rsvp : null;
    document.querySelectorAll(`[data-plans="${CSS.escape(id)}"]`).forEach((el) => {
      const e = find(id);
      if (!e) return;
      const wasActive = el.contains(active);
      const tmp = document.createElement("div");
      tmp.innerHTML = html(e, el.dataset.kind);
      const fresh = tmp.firstElementChild;
      el.replaceWith(fresh);
      if (wasActive && refocus) fresh.querySelector(`[data-rsvp="${refocus}"]`)?.focus();
    });
    const mine = status(id);
    document.querySelectorAll(`[data-card="${CSS.escape(id)}"]`).forEach((c) => {
      c.classList.toggle("is-going", mine === "going");
      c.classList.toggle("is-maybe", mine === "maybe");
    });
  }
  function refreshAll() {
    const ids = new Set([...document.querySelectorAll("[data-plans]")].map((el) => el.dataset.plans));
    ids.forEach(refresh);
  }
  function cardClass(e) {
    const s = status(e.id);
    return s === "going" ? " is-going" : s === "maybe" ? " is-maybe" : "";
  }

  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-rsvp]");
    if (b) { ev.preventDefault(); ev.stopPropagation(); set(b.dataset.id, b.dataset.rsvp); return; }
    const p = ev.target.closest("[data-profile]");
    if (p && !ev.metaKey && !ev.ctrlKey) { ev.preventDefault(); openProfile(p.dataset.profile); }
  }, true);

  // ---------- account ----------
  async function signIn(email) {
    if (!sb) return { error: { message: "Sign-in needs the database." } };
    const back = new URL("index.html", location.href);
    back.searchParams.set("you", "1");
    return sb.auth.signInWithOtp({ email, options: { emailRedirectTo: back.href } });
  }
  async function signOut() { if (sb) await sb.auth.signOut(); }

  async function saveProfile(fields) {
    const clean = {
      display_name: String(fields.display_name || "").trim().slice(0, 40),
      handle: String(fields.handle || "").trim().toLowerCase().replace(/^@/, ""),
      visibility: fields.visibility,
    };
    if (!clean.display_name) return { error: "Add a name." };
    if (!/^[a-z0-9_]{3,24}$/.test(clean.handle)) return { error: "Handles are 3 to 24 letters, numbers or underscores." };
    const { data, error } = await sb.from("profiles").update(clean).eq("user_id", st.user.id)
      .select("user_id,handle,display_name,visibility").single();
    if (error) return { error: error.code === "23505" ? "Someone already has that handle." : error.message };
    st.profile = data;
    await loadSocial();
    refreshAll(); emit();
    return { ok: true };
  }

  function shareUrl(handle = st.profile?.handle) {
    const u = new URL("index.html", location.href);
    u.searchParams.set("u", handle);
    return u.href;
  }

  async function follow(uid) {
    const { error } = await sb.from("follows").insert({ follower: st.user.id, followee: uid });
    if (error && error.code !== "23505") { toast("That didn't go through. Try again."); return; }
    await loadFollows(); await loadSocial(); refreshAll(); emit();
  }
  async function unfriend(uid) {
    await sb.from("follows").delete().eq("follower", st.user.id).eq("followee", uid);
    await sb.from("follows").delete().eq("follower", uid).eq("followee", st.user.id);
    await loadFollows(); await loadSocial(); refreshAll(); emit();
  }
  async function addFriendByHandle(handle) {
    const { data } = await sb.rpc("profile_by_handle", { h: handle });
    const p = data && data[0];
    if (p && p.user_id !== st.user.id) await sb.from("follows").insert({ follower: st.user.id, followee: p.user_id });
    await loadFollows();
  }

  function friends() {
    const by = (ids) => [...ids].map((id) => st.names.get(id)).filter(Boolean)
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
    return {
      friends: by([...st.out].filter((id) => st.in.has(id))),
      requests: by([...st.in].filter((id) => !st.out.has(id))),
      waiting: by([...st.out].filter((id) => !st.in.has(id))),
    };
  }

  // ---------- someone's page (?u=handle) ----------
  let dlg;
  function dialog() {
    if (dlg) return dlg;
    dlg = document.createElement("dialog");
    dlg.className = "show-dialog people-dialog";
    dlg.setAttribute("aria-labelledby", "pd-title");
    document.body.appendChild(dlg);
    dlg.addEventListener("click", (ev) => { if (ev.target === dlg) dlg.close(); });
    dlg.addEventListener("close", () => {
      const u = new URL(location.href);
      if (u.searchParams.has("u")) { u.searchParams.delete("u"); history.replaceState(history.state, "", u); }
    });
    return dlg;
  }

  async function openProfile(handle) {
    const d = dialog();
    d.innerHTML = `<form method="dialog" class="sd-close-row"><button class="sd-close" aria-label="Close">×</button></form><div class="pd"><p class="plans-hint">Loading…</p></div>`;
    if (!d.open) d.showModal();
    const u = new URL(location.href);
    if (u.searchParams.get("u") !== handle) { u.searchParams.set("u", handle); history.replaceState(history.state, "", u); }
    await renderProfile(handle);
  }

  async function renderProfile(handle) {
    const d = dialog();
    const body = d.querySelector(".pd");
    if (!sb || !st.social) { body.innerHTML = `<p class="plans-hint">Profiles aren't switched on for this site yet.</p>`; return; }
    const { data } = await sb.rpc("profile_by_handle", { h: handle });
    const p = data && data[0];
    if (!p) { body.innerHTML = `<h2 class="pd-name" id="pd-title">Not found</h2><p class="plans-hint">No one on Music in SLC goes by @${esc(handle)}.</p>`; return; }
    const me = st.user && st.user.id === p.user_id;
    const canSee = me || p.visibility === "public" || (p.visibility === "friends" && isFriend(p.user_id));
    let plans = [];
    if (canSee) {
      const { data: rows } = await sb.from("rsvps").select("event_id,status,events!inner(starts_at)")
        .eq("user_id", p.user_id).gte("events.starts_at", since());
      plans = (rows || []).map((r) => ({ e: find(String(r.event_id)), status: r.status })).filter((x) => x.e)
        .sort((a, b) => a.e.starts_at.localeCompare(b.e.starts_at));
    }
    const row = ({ e }) => `<li><a href="#show-${esc(e.id)}" data-show="${esc(e.id)}">
        <span class="pd-date">${esc(S.fmtDow(e.starts_at))} ${esc(S.fmtMon(e.starts_at))} ${esc(S.fmtNum(e.starts_at))}</span>
        <span class="pd-show">${esc(e.title)}</span><span class="pd-venue">${esc(e.venue_name)}</span></a></li>`;
    const list = (s, label) => {
      const items = plans.filter((x) => x.status === s);
      return items.length ? `<h3 class="sd-label">${label}</h3><ul class="pd-list">${items.map(row).join("")}</ul>` : "";
    };
    const first = p.display_name.split(" ")[0];
    let note = "";
    if (!canSee) {
      note = p.visibility === "private"
        ? `<p class="plans-hint">${esc(first)} keeps plans private.</p>`
        : `<p class="plans-hint">${esc(first)} shares plans with friends. Once you've both added each other, you'll see where ${esc(first)} is headed.</p>`;
    } else if (!plans.length) {
      note = `<p class="plans-hint">${me ? "You haven't" : `${esc(first)} hasn't`} marked any upcoming shows yet.</p>`;
    }
    body.innerHTML = `<p class="sd-when">@${esc(p.handle)}</p>
      <h2 class="pd-name" id="pd-title">${esc(p.display_name)}</h2>
      <div class="pd-actions">${friendButton(p, me)}</div>
      ${note}${list("going", "Going")}${list("maybe", "Maybe")}`;
    body.querySelector("[data-friend]")?.addEventListener("click", async (ev) => {
      const act = ev.currentTarget.dataset.friend;
      ev.currentTarget.disabled = true;
      if (act === "add") await follow(p.user_id);
      else if (act === "remove") await unfriend(p.user_id);
      else if (act === "signin") {
        S.store.set(PENDING_FRIEND, p.handle);
        dialog().close();
        openYou();
        return;
      } else if (act === "share") { await shareLink(ev.currentTarget); ev.currentTarget.disabled = false; return; }
      await renderProfile(handle);
    });
  }

  function friendButton(p, me) {
    if (me) return `<button class="btn" type="button" data-friend="share">Share my page</button>`;
    if (!st.user) return `<button class="btn primary" type="button" data-friend="signin">Sign in to add ${esc(p.display_name.split(" ")[0])}</button>`;
    if (!st.profile) return "";
    const o = st.out.has(p.user_id), i = st.in.has(p.user_id);
    if (o && i) return `<span class="pd-status">Friends</span><button class="btn ghost" type="button" data-friend="remove">Remove friend</button>`;
    if (o) return `<span class="pd-status">Request sent</span><button class="btn ghost" type="button" data-friend="remove">Cancel</button>`;
    if (i) return `<button class="btn primary" type="button" data-friend="add">Add back</button><span class="pd-status">Added you</span>`;
    return `<button class="btn primary" type="button" data-friend="add">Add friend</button>`;
  }

  async function shareLink(button, handle) {
    const url = shareUrl(handle);
    const data = { title: `${st.profile?.display_name || "My"} on Music in SLC`, text: "See which shows I'm going to", url };
    try {
      if (navigator.share) { await navigator.share(data); return; }
      await navigator.clipboard.writeText(url);
      flash(button, "Link copied");
    } catch (err) {
      if (err && err.name === "AbortError") return;
      prompt("Copy your link", url);
    }
  }
  function flash(button, text) {
    if (!button) return;
    const was = button.textContent;
    button.textContent = text;
    setTimeout(() => { button.textContent = was; }, 1600);
  }

  // The You section lives on the calendar page; elsewhere, links go there
  function openYou() {
    if (window.SLCYou) window.SLCYou.open(true);
    else location.href = "index.html?you=1";
  }
  document.addEventListener("click", (ev) => {
    const a = ev.target.closest("[data-you-link]");
    if (!a || !window.SLCYou) return;
    ev.preventDefault();
    document.querySelectorAll("dialog[open]").forEach((d) => d.close());
    window.SLCYou.open(true);
  });

  let toastEl;
  function toast(msg) {
    toastEl ||= Object.assign(document.createElement("div"), { className: "toast", role: "status" });
    if (!toastEl.isConnected) document.body.appendChild(toastEl);
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { toastEl.hidden = true; }, 4000);
  }

  window.SLCPlans = {
    start, html, status, set, cardClass, refreshAll,
    onChange: (f) => listeners.add(f),
    get user() { return st.user; }, get profile() { return st.profile; },
    get social() { return Boolean(sb) && st.social; }, get ready() { return st.ready; },
    mineCount: () => {
      const c = { going: 0, maybe: 0 };
      for (const [id, s] of st.mine) if (find(id)) c[s]++;
      return c;
    },
    signIn, signOut, saveProfile, shareUrl, shareLink, friends, follow, unfriend, openProfile, visibilityNote,
  };
})();
