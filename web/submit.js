(async function () {
  const S = window.SLC;
  const $ = (id) => document.getElementById(id);
  const form = $("submit-form");
  $("inbox-addr").textContent = S.cfg.inboxAddress || "musicinslc@gmail.com";
  document.querySelectorAll(".inbox-addr").forEach((el) => { el.textContent = S.cfg.inboxAddress || "musicinslc@gmail.com"; });
  $("date").min = S.dayKey(Date.now());

  const genres = await S.loadGenres();
  $("genre-checks").innerHTML = genres.map((g) =>
    `<label><input type="checkbox" name="genre" value="${g.id}"> ${S.esc(g.label)}</label>`).join("");
  $("genre-checks").addEventListener("change", () => {
    const boxes = [...document.querySelectorAll('input[name="genre"]')];
    const n = boxes.filter((b) => b.checked).length;
    boxes.forEach((b) => { b.disabled = !b.checked && n >= 3; });
  });
  S.loadVenues().then((vs) => {
    $("venue-list").innerHTML = vs.map((v) => `<option value="${S.esc(v.name)}">`).join("");
  }).catch(() => {});
  $("free").addEventListener("change", (e) => { if (e.target.checked) $("price").value = "0"; });

  function fail(msg, field) {
    $("form-error").textContent = msg;
    $("form-error").hidden = false;
    if (field) $(field).focus();
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    $("form-error").hidden = true;
    const f = Object.fromEntries(new FormData(form));
    if ($("website").value) return; // bots fill the hidden field

    for (const [id, label] of [["title", "the headliner"], ["date", "the date"], ["time", "the show time"],
      ["venue", "the venue"], ["name", "your name"], ["email", "your email"]]) {
      if (!String(f[id] || "").trim()) return fail(`Add ${label}.`, id);
    }
    if (!$("email").checkValidity()) return fail("That email address doesn't look right.", "email");
    const ticket = f.ticket ? S.safeUrl(f.ticket.trim()) : null;
    if (f.ticket && !ticket) return fail("The ticket link should start with https://", "ticket");
    const artistUrl = f.artist_url ? S.safeUrl(f.artist_url.trim()) : null;
    if (f.artist_url && !artistUrl) return fail("The band link should start with https://", "artist-url");

    const [hh, mm] = f.time.split(":").map(Number);
    const starts = S.mountainTime(f.date, hh, mm);
    if (starts < Date.now() - 3600e3) return fail("That date has already passed.", "date");
    let doors = null;
    if (f.doors) { const [dh, dm] = f.doors.split(":").map(Number); doors = S.mountainTime(f.date, dh, dm).toISOString(); }

    const support = String(f.support || "").split(",").map((s) => s.trim()).filter(Boolean);
    const price = f.price === "" || f.price == null ? null : Number(f.price);
    const row = {
      fingerprint: "pending",               // replaced by the database
      title: f.title.trim(),
      artists: [f.title.trim(), ...support],
      venue_name: f.venue.trim(),
      city: f.city,
      starts_at: starts.toISOString(),
      doors_at: doors,
      price_min: Number.isFinite(price) ? price : null,
      is_free: Boolean(f.free) || price === 0,
      age_restriction: f.age || null,
      genres: [...document.querySelectorAll('input[name="genre"]:checked')].map((b) => b.value),
      ticket_url: ticket,
      artist_url: artistUrl,
      description: (f.description || "").trim() || null,
      status: "pending",
      source: "submission",
      submitter_name: f.name.trim(),
      submitter_email: f.email.trim(),
    };

    const btn = $("submit-btn");
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      const res = await S.submitShow(row);
      if (!res.ok) throw new Error("The calendar didn't accept that. Check the date and try again, or email the flyer instead.");
      form.hidden = true;
      $("thanks").hidden = false;
      $("thanks-msg").textContent = res.demo
        ? "This is the sample site, so nothing was saved. On the live site your show goes into the review queue."
        : `Got it. ${row.title} at ${row.venue_name} is in the review queue.`;
    } catch (err) {
      fail(err.message);
    } finally {
      btn.disabled = false; btn.textContent = "Send for review";
    }
  });

  $("another").onclick = () => {
    form.reset(); $("time").value = "20:00";
    form.hidden = false; $("thanks").hidden = true; $("title").focus();
  };
})();
