// Week view: seven days starting today (or a later week), shows grouped by day in columns.
(async function () {
  const S = window.SLC;
  const $ = (id) => document.getElementById(id);
  const PREFS = "slc.week.v1";
  const state = Object.assign({ allAges: false, free: false }, S.store.get(PREFS, {}));
  let events = [];
  const artists = new Map();
  const D = window.SLCDetails;
  const details = D.create({ find: (id) => events.find((e) => String(e.id) === String(id)), artists });

  $("inbox-addr").textContent = S.cfg.inboxAddress || "musicinslc@gmail.com";
  $("demo-note").hidden = S.live;

  // ?w=0 is the seven days starting today, ?w=1 the seven after that, and so on.
  function getOffset() {
    const n = parseInt(new URLSearchParams(location.search).get("w") || "0", 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 52) : 0;
  }
  let offset = getOffset();

  function setOffset(n) {
    offset = Math.max(0, n);
    const url = new URL(location.href);
    if (offset) url.searchParams.set("w", String(offset)); else url.searchParams.delete("w");
    history.pushState({ w: offset }, "", url);
    render();
  }
  window.addEventListener("popstate", () => { offset = getOffset(); render(); });

  const noon = (k) => `${k}T19:00:00Z`; // midday in Salt Lake, safe for formatting a date key
  const rangeFmt = new Intl.DateTimeFormat("en-US", { timeZone: S.TZ, weekday: "short", month: "short", day: "numeric" });

  function keep(e) {
    if (state.allAges && e.age_restriction !== "all_ages") return false;
    if (state.free && !(e.is_free || e.price_min === 0)) return false;
    return true;
  }

  function showHtml(e) {
    const url = S.safeUrl(e.ticket_url);
    const cancelled = e.status === "cancelled";
    const support = (e.artists || []).slice(1).filter((a) => a.toLowerCase() !== e.title.toLowerCase());
    const price = S.priceLabel(e);
    const age = S.AGE[e.age_restriction] || "";
    const id = S.esc(e.id);
    const title = `<a href="#show-${id}" data-show="${id}">${S.esc(e.title)}</a>`;
    const hasArt = S.safeUrl(e.image_url) || String(e.image_url || "").startsWith("data:image/svg+xml");
    return `<article class="wshow${cancelled ? " cancelled" : ""}">
      ${hasArt ? `<a class="wthumb" href="#show-${id}" data-show="${id}" tabindex="-1" aria-hidden="true">${D.art(e, "wthumb-img")}</a>` : ""}
      <div class="wtime">${S.esc(S.timeLabel(e.starts_at))}${cancelled ? " · Cancelled" : ""}</div>
      <h3 class="wtitle">${title}</h3>
      ${support.length ? `<div class="support">with ${S.esc(support.join(", "))}</div>` : ""}
      <div class="wwhere">${S.esc(e.venue_name)}</div>
      ${D.cardLinks(e, artists)}
      ${price || age ? `<div class="wmeta">${price ? `<span class="${price === "Free" ? "free" : ""}">${S.esc(price)}</span>` : ""}${price && age ? "<span>·</span>" : ""}${age ? `<span>${S.esc(age)}</span>` : ""}</div>` : ""}
    </article>`;
  }

  function render() {
    const today = S.dayKey(Date.now());
    const start = S.addDays(today, offset * 7);
    const end = S.addDays(start, 6);
    $("week-title").textContent = offset === 0 ? "This week" : offset === 1 ? "Next week" : `Week of ${rangeFmt.format(new Date(noon(start))).replace(/^\w+, /, "")}`;
    $("week-range").textContent = `${rangeFmt.format(new Date(noon(start)))} to ${rangeFmt.format(new Date(noon(end)))}`;
    document.title = `${$("week-title").textContent} · Music in SLC`;
    $("prev-week").disabled = offset === 0;
    $("this-week").hidden = offset === 0;
    $("f-allages").setAttribute("aria-pressed", String(state.allAges));
    $("f-free").setAttribute("aria-pressed", String(state.free));

    const byDay = new Map();
    for (let i = 0; i < 7; i++) byDay.set(S.addDays(start, i), []);
    for (const e of events) {
      const k = S.dayKey(e.starts_at);
      if (byDay.has(k) && keep(e)) byDay.get(k).push(e);
    }
    let total = 0, html = "";
    for (const [k, shows] of byDay) {
      shows.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      total += shows.length;
      const d = noon(k);
      const rel = k === today ? "Tonight" : k === S.addDays(today, 1) ? "Tomorrow" : "";
      html += `<section class="wday${k === today ? " today" : ""}" aria-label="${S.esc(S.fmtLong(d))}">
        <div class="wday-head"><span class="rel${rel ? "" : " blank"}">${rel || "&nbsp;"}</span><span class="dow">${S.esc(S.fmtDow(d))}</span><span class="num">${S.esc(S.fmtNum(d))}</span><span class="mon">${S.esc(S.fmtMon(d))}</span>${shows.length ? `<span class="n">${shows.length}</span>` : ""}</div>
        <div class="wshows">${shows.length ? shows.map(showHtml).join("") : '<p class="none">No shows listed</p>'}</div>
      </section>`;
    }
    $("count").textContent = `${total} show${total === 1 ? "" : "s"}`;
    $("week").innerHTML = html;
  }

  function toggle(key) { state[key] = !state[key]; S.store.set(PREFS, state); render(); }
  $("f-allages").onclick = () => toggle("allAges");
  $("f-free").onclick = () => toggle("free");
  $("prev-week").onclick = () => setOffset(offset - 1);
  $("next-week").onclick = () => setOffset(offset + 1);
  $("this-week").onclick = () => setOffset(0);

  try {
    const artistsLoad = S.loadArtists();
    events = await S.loadEvents();
    for (const [k, v] of await artistsLoad) artists.set(k, v);
    render();
    details.fromHash();
  } catch (err) {
    $("week").innerHTML = `<div class="empty"><strong>Shows didn't load</strong>${S.esc(err.message)}</div>`;
  }
})();
