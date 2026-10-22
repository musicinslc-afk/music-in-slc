// Show details: the full flyer, every act on the bill with their links, tickets, share and
// add-to-calendar. Opens from a card and has its own address (#show-<id>) so it can be shared.
(function () {
  const S = window.SLC;

  function art(e, cls) {
    const img = S.safeUrl(e.image_url) || (String(e.image_url || "").startsWith("data:image/svg+xml") ? e.image_url : null);
    const name = (e.artists && e.artists[0]) || e.title;
    const tile = `<span class="tile ${cls}" style="${S.tileStyle(name)}" aria-hidden="true">${S.esc(S.initials(name))}</span>`;
    if (!img) return tile;
    // A picture that fails to load falls back to the initials tile
    return `<img class="${cls}${e.image_kind === "photo" ? " is-photo" : ""}" src="${S.esc(img)}" alt="" loading="lazy" decoding="async"
      referrerpolicy="no-referrer" onerror="this.outerHTML=this.nextElementSibling.innerHTML"><template>${tile}</template>`;
  }

  function chips(links, max = 99) {
    return links.slice(0, max).map((l) =>
      `<a class="blink blink-${l.kind}" href="${S.esc(l.url)}" target="_blank" rel="noopener">${S.esc(l.label)}</a>`).join("");
  }

  // The headliner's links, for the card
  function cardLinks(e, artists) {
    const head = (e.artists && e.artists[0]) || e.title;
    const links = S.bandLinks(artists, head);
    return links.length ? `<div class="blinks" aria-label="${S.esc(head)} links">${chips(links, 3)}</div>` : "";
  }

  function host(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
  }

  // Venue street addresses, loaded once, so the map pins the building rather than guessing from the name
  let venuesPromise;
  function venueAddresses() {
    venuesPromise ||= S.loadVenues().then((vs) => {
      const m = new Map();
      for (const v of vs || []) if (v.name && v.address) m.set(v.name.toLowerCase(), v);
      return m;
    }).catch(() => new Map());
    return venuesPromise;
  }

  function mapQuery(e, venues) {
    const v = venues && venues.get(String(e.venue_name || "").toLowerCase());
    const city = (v && v.city) || e.city || "Salt Lake City";
    return v ? `${e.venue_name}, ${v.address}, ${city}, UT` : `${e.venue_name}, ${city}, UT`;
  }

  function mapBlock(e, venues) {
    if (!e.venue_name) return "";
    const v = venues && venues.get(String(e.venue_name).toLowerCase());
    const q = encodeURIComponent(mapQuery(e, venues));
    const open = `https://www.google.com/maps/search/?api=1&query=${q}`;
    const dirs = `https://www.google.com/maps/dir/?api=1&destination=${q}`;
    return `<div class="sd-map">
      <a class="sd-map-frame" href="${open}" target="_blank" rel="noopener" aria-label="Open ${S.esc(e.venue_name)} in Google Maps">
        <iframe src="https://maps.google.com/maps?q=${q}&z=15&output=embed" title="Map of ${S.esc(e.venue_name)}"
          loading="lazy" referrerpolicy="no-referrer-when-downgrade" tabindex="-1" aria-hidden="true"></iframe>
      </a>
      <div class="sd-map-text">
        <span class="sd-map-addr">${v ? `${S.esc(v.address)}${v.city ? `, ${S.esc(v.city)}` : ""}` : S.esc(e.venue_name)}</span>
        <a class="sd-map-dirs" href="${dirs}" target="_blank" rel="noopener">Directions</a>
      </div>
    </div>`;
  }

  function create({ find, artists }) {
    const dlg = document.createElement("dialog");
    dlg.className = "show-dialog";
    dlg.setAttribute("aria-labelledby", "sd-title");
    document.body.appendChild(dlg);
    let current = null, pushed = false, venueCache = null;
    venueAddresses().then((m) => {
      venueCache = m;
      const slot = dlg.querySelector(".sd-map-slot");
      if (current && slot && m.has(String(current.venue_name || "").toLowerCase())) slot.innerHTML = mapBlock(current, m);
    });

    function render(e) {
      const support = (e.artists || []).filter((a) => a && a.toLowerCase() !== e.title.toLowerCase());
      const acts = [...new Set([...(e.artists || []).slice(0, 1), ...support])].filter(Boolean);
      const cancelled = e.status === "cancelled";
      const ticket = S.safeUrl(e.ticket_url);
      const price = S.priceLabel(e);
      const age = S.AGE[e.age_restriction];
      const tags = (e.genres || []).map((g) => `<span class="tag">${S.esc((window.SLC_GENRE_LABELS || {})[g] || g)}</span>`).join("");
      const when = `${S.fmtLong(e.starts_at)} · ${S.timeLabel(e.starts_at)}${e.doors_at ? ` (doors ${S.timeLabel(e.doors_at)})` : ""}`;
      const credit = S.safeUrl(e.image_url) && ticket ? `<figcaption class="sd-credit">${e.image_kind === "photo" ? "Photo" : "Flyer"} via <a href="${S.esc(ticket)}" target="_blank" rel="noopener">${S.esc(host(ticket))}</a></figcaption>` : "";
      const actRows = acts.map((a, i) => {
        const links = S.bandLinks(artists, a);
        return `<li><span class="sd-act${i === 0 ? " head" : ""}">${S.esc(a)}</span>${links.length ? `<span class="blinks">${chips(links)}</span>` : ""}</li>`;
      }).join("");
      dlg.innerHTML = `<form method="dialog" class="sd-close-row"><button class="sd-close" aria-label="Close">×</button></form>
      <div class="sd-grid">
        <figure class="sd-art">${art(e, "sd-img")}${credit}</figure>
        <div class="sd-info">
          <p class="sd-when">${S.esc(when)}</p>
          <h2 class="sd-title" id="sd-title">${S.esc(e.title)}</h2>
          <p class="sd-where">${S.esc(e.venue_name)}${e.city && e.city !== "Salt Lake City" ? ` <span>· ${S.esc(e.city)}</span>` : ""}</p>
          <div class="tags">${cancelled ? '<span class="tag status">Cancelled</span>' : ""}${price ? `<span class="tag price-tag${price === "Free" ? " free" : ""}">${S.esc(price)}</span>` : ""}${age ? `<span class="tag age">${S.esc(age)}</span>` : ""}${tags}</div>
          ${actRows ? `<h3 class="sd-label">On the bill</h3><ul class="sd-acts">${actRows}</ul>` : ""}
          ${e.description ? `<p class="sd-desc">${S.esc(e.description)}</p>` : ""}
          <div class="sd-actions">
            ${ticket && !cancelled ? `<a class="btn primary" href="${S.esc(ticket)}" target="_blank" rel="noopener">Tickets and info</a>` : ""}
            ${cancelled ? "" : '<button class="btn" type="button" data-act="ics">Add to calendar</button>'}
            <button class="btn" type="button" data-act="share">Share</button>
          </div>
          <p class="sd-note" aria-live="polite"></p>
          <div class="sd-map-slot">${mapBlock(e, venueCache)}</div>
        </div>
      </div>`;
      dlg.querySelector('[data-act="ics"]')?.addEventListener("click", () => downloadIcs(e));
      dlg.querySelector('[data-act="share"]').addEventListener("click", () => share(e));
    }

    function open(e, { push = true } = {}) {
      if (!e) return;
      current = e;
      render(e);
      if (!dlg.open) dlg.showModal();
      dlg.scrollTop = 0;
      const hash = `#show-${e.id}`;
      if (location.hash !== hash) {
        if (push) { history.pushState({ show: e.id }, "", hash); pushed = true; }
        else history.replaceState(history.state, "", hash);
      }
    }

    dlg.addEventListener("close", () => {
      current = null;
      if (!location.hash.startsWith("#show-")) return;
      if (pushed) { pushed = false; history.back(); }
      else history.replaceState(null, "", location.pathname + location.search);
    });
    dlg.addEventListener("click", (ev) => { if (ev.target === dlg) dlg.close(); }); // backdrop

    function fromHash() {
      const m = location.hash.match(/^#show-(.+)$/);
      if (m) {
        const e = find(decodeURIComponent(m[1]));
        if (e && current?.id !== e.id) open(e, { push: false });
      } else if (dlg.open) {
        pushed = false;
        dlg.close();
      }
    }
    window.addEventListener("popstate", fromHash);

    // Cards: any element with data-show opens that show
    document.addEventListener("click", (ev) => {
      const el = ev.target.closest("[data-show]");
      if (!el || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
      const e = find(el.dataset.show);
      if (!e) return;
      ev.preventDefault();
      open(e);
    });

    function link(e) { return `${location.origin}${location.pathname}#show-${encodeURIComponent(e.id)}`; }

    async function share(e) {
      const note = dlg.querySelector(".sd-note");
      const data = { title: e.title, text: `${e.title} at ${e.venue_name}, ${S.fmtLong(e.starts_at)}`, url: link(e) };
      try {
        if (navigator.share) { await navigator.share(data); return; }
        await navigator.clipboard.writeText(data.url);
        note.textContent = "Link copied.";
      } catch (err) {
        if (err && err.name === "AbortError") return;
        note.textContent = `Copy this link: ${data.url}`;
      }
    }

    function downloadIcs(e) {
      const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const txt = (s) => String(s || "").replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n");
      const start = new Date(e.starts_at);
      const end = new Date(start.getTime() + 3 * 3600e3);
      const lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Music in SLC//EN", "BEGIN:VEVENT",
        `UID:${e.id}@musicinslc`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`,
        `SUMMARY:${txt(e.title)}`, `LOCATION:${txt([e.venue_name, e.city].filter(Boolean).join(", "))}`,
        `DESCRIPTION:${txt([(e.artists || []).join(", "), S.safeUrl(e.ticket_url) || ""].filter(Boolean).join("\n"))}`,
        `URL:${link(e)}`, "END:VEVENT", "END:VCALENDAR",
      ];
      const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${e.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "show"}.ics`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }

    return { open, fromHash, close: () => dlg.close() };
  }

  window.SLCDetails = { create, art, cardLinks };
})();
