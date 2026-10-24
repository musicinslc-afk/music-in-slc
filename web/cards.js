// Show cards and nights, shared by the calendar and the You page.
(function () {
  const S = window.SLC;
  const D = window.SLCDetails;
  const P = () => window.SLCPlans;
  const T = () => window.SLCTaste;
  let artists = new Map();

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
    const tags = (e.genres || []).map((g) => `<span class="tag">${S.esc((window.SLC_GENRE_LABELS || {})[g] || g)}</span>`).join("");
    const age = S.AGE[e.age_restriction] ? `<span class="tag age">${S.AGE[e.age_restriction]}</span>` : "";
    const cancelled = e.status === "cancelled";
    const id = S.esc(e.id);
    return `<article class="show${e._match ? " matched" : ""}${cancelled ? " cancelled" : ""}${P() ? P().cardClass(e) : ""}" data-card="${id}">
      <div class="time">${S.esc(S.timeLabel(e.starts_at))}${e.doors_at ? `<small>doors ${S.esc(S.timeLabel(e.doors_at))}</small>` : ""}</div>
      <a class="thumb" href="#show-${id}" data-show="${id}" tabindex="-1" aria-hidden="true">${D.art(e, "thumb-img")}</a>
      <div class="show-main">
        <h3 class="title"><a href="#show-${id}" data-show="${id}">${S.esc(e.title)}</a></h3>
        ${support.length ? `<div class="support">with ${S.esc(support.join(", "))}</div>` : ""}
        <div class="where">${S.esc(e.venue_name)}${e.city && e.city !== "Salt Lake City" ? ` <span>· ${S.esc(e.city)}</span>` : ""}</div>
        ${D.cardLinks(e, artists)}
        <div class="tags">${cancelled ? '<span class="tag status">Cancelled</span>' : ""}${age}${tags}</div>
        ${e._match ? `<div class="match">${S.esc(e._match.reason)}</div>` : ""}
        ${P() ? P().html(e, "card") : ""}
      </div>
      <div class="show-side">
        ${price ? `<span class="price${price === "Free" ? " free" : ""}">${S.esc(price)}</span>` : ""}
        ${url && !cancelled ? `<a class="btn primary" href="${S.esc(url)}" target="_blank" rel="noopener">Tickets</a>` : ""}
      </div>
    </article>`;
  }

  function dayHtml(k, shows) {
    // Matches float to the top of each night when a profile is connected
    if (T()?.profile) shows.sort((a, b) => (b._match?.score || 0) - (a._match?.score || 0) || a.starts_at.localeCompare(b.starts_at));
    const d = shows[0].starts_at;
    const rel = relLabel(k);
    return `<section class="day" aria-label="${S.esc(S.fmtLong(d))}">
        <div class="stub"><span class="dow">${S.esc(S.fmtDow(d))}</span><span class="num">${S.esc(S.fmtNum(d))}</span><span class="mon">${S.esc(S.fmtMon(d))}</span>${rel ? `<span class="rel">${rel}</span>` : ""}${S.meter(shows.length)}</div>
        <div class="shows">${shows.map(showHtml).join("")}</div>
      </section>`;
  }

  window.SLCCards = { showHtml, dayHtml, relLabel, setArtists: (m) => { artists = m; } };
})();
