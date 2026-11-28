(async function () {
  const S = window.SLC;
  const $ = (id) => document.getElementById(id);
  const form = $("submit-form");

  // City lists for the venue and special event panels match the single show list
  for (const id of ["v-city", "e-city"]) $(id).innerHTML = $("city").innerHTML;
  $("e-start").min = $("e-end").min = S.dayKey(Date.now());

  // Step 1 "I am", step 2 "Submitting"; the matching fields appear after both
  const ROLES = { artist: "Artist", venue: "Venue", promoter: "Promoter", fan: "Fan" };
  const picked = (name) => document.querySelector(`#chooser input[name="${name}"]:checked`)?.value || "";
  const SEND = { single: "Send for review", show_list: "Send list", venue: "Send venue", special_event: "Send event", question: "Send question" };
  function showStep() {
    const role = picked("role"), kind = picked("kind");
    $("kind-step").hidden = !role;
    form.hidden = !(role && kind);
    form.querySelectorAll(".panel").forEach((el) => { el.hidden = el.dataset.kind !== kind; });
    $("form-error").hidden = true;
    $("submit-btn").textContent = SEND[kind] || SEND.single;
    $("submit-hint").textContent = kind === "question" ? "We'll reply by email."
      : "We check every submission before it goes live.";
  }
  $("chooser").addEventListener("change", showStep);
  showStep();   // the browser may restore choices after Back

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
    const role = picked("role"), kind = picked("kind");
    if (!role || !kind) return;
    if (kind !== "single") return sendRequest(role, kind, f);

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
      submitter_notes: `I am: ${ROLES[role]}`,
    };

    const btn = $("submit-btn");
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      const res = await S.submitShow(row);
      if (!res.ok) throw new Error("The calendar didn't accept that. Check the date and try again, or email the flyer instead.");
      thank(res.demo
        ? "This is the sample site, so nothing was saved. On the live site your show goes into the review queue."
        : `Got it. ${row.title} at ${row.venue_name} is in the review queue.`);
      gaSent(role, kind);
    } catch (err) {
      fail(err.message);
    } finally {
      btn.disabled = false; btn.textContent = SEND.single;
    }
  });

  function thank(msg) {
    $("chooser").hidden = true;
    form.hidden = true;
    $("thanks").hidden = false;
    $("thanks-msg").textContent = msg;
  }
  const gaSent = (role, kind) => window.gtag && window.gtag("event", "show_submitted", { submitter_role: role, submission_type: kind });

  // Everything other than a single show: lists, venues, special events and questions
  const LABELS = { list_url: "Link", address: "Address", city: "City", website: "Website", calendar: "Shows posted at",
    capacity: "Capacity", ages: "Ages", start: "Starts", end: "Ends", place: "Location", lineup: "Lineup", url: "Link" };

  function buildRequest(kind, f) {
    const v = (name) => String(f[name] || "").trim();
    const need = (list) => list.find(([name]) => !v(name));
    const links = [];
    let subject, message, details, missing;
    if (kind === "show_list") {
      if (!v("list_text") && !v("list_url")) return { error: "Paste your list or add a link to it.", field: "list-text" };
      links.push(["list_url", "list-url"]);
      subject = "List of shows"; message = v("list_text"); details = { list_url: v("list_url") };
    } else if (kind === "venue") {
      missing = need([["v_name", "v-name", "the venue name"], ["v_address", "v-address", "the street address"]]);
      links.push(["v_website", "v-website"], ["v_calendar", "v-calendar"]);
      subject = v("v_name"); message = v("v_notes");
      details = { address: v("v_address"), city: v("v_city"), website: v("v_website"), calendar: v("v_calendar"),
        capacity: v("v_capacity"), ages: v("v_ages") };
    } else if (kind === "special_event") {
      missing = need([["e_name", "e-name", "the event name"], ["e_start", "e-start", "the start date"], ["e_place", "e-place", "the location"]]);
      if (!missing && v("e_start") < S.dayKey(Date.now()) && (v("e_end") || v("e_start")) < S.dayKey(Date.now())) return { error: "That date has already passed.", field: "e-start" };
      if (!missing && v("e_end") && v("e_end") < v("e_start")) return { error: "The end date is before the start date.", field: "e-end" };
      links.push(["e_url", "e-url"]);
      subject = v("e_name"); message = v("e_notes");
      details = { start: v("e_start"), end: v("e_end"), place: v("e_place"), city: v("e_city"), lineup: v("e_lineup"), url: v("e_url") };
    } else {
      missing = need([["q_text", "q-text", "your question"]]);
      subject = "Question"; message = v("q_text"); details = {};
    }
    if (missing) return { error: `Add ${missing[2]}.`, field: missing[1] };
    for (const [name, id] of links) {
      if (v(name) && !S.safeUrl(v(name))) return { error: "Links should start with https://", field: id };
    }
    for (const k of Object.keys(details)) if (!details[k]) delete details[k];
    return { subject, message: message || null, details };
  }

  // If the database can't take it, offer the same content as a ready-to-send email
  function mailtoFor(row) {
    const body = [`I am: ${ROLES[row.submitter_role]}`, `Name: ${row.name}`, `Email: ${row.email}`,
      ...Object.entries(row.details).map(([k, val]) => `${LABELS[k] || k}: ${val}`), "", row.message || ""].join("\n");
    return `mailto:${S.cfg.inboxAddress || "musicinslc@gmail.com"}?subject=${encodeURIComponent(`Music in SLC: ${row.subject}`)}&body=${encodeURIComponent(body.slice(0, 1500))}`;
  }

  async function sendRequest(role, kind, f) {
    const made = buildRequest(kind, f);
    if (made.error) return fail(made.error, made.field);
    if (!String(f.name || "").trim()) return fail("Add your name.", "name");
    if (!String(f.email || "").trim()) return fail("Add your email.", "email");
    if (!$("email").checkValidity()) return fail("That email address doesn't look right.", "email");
    const row = { kind, submitter_role: role, name: f.name.trim(), email: f.email.trim(),
      subject: made.subject, message: made.message, details: made.details };

    const btn = $("submit-btn");
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      const res = await S.submitRequest(row);
      if (!res.ok) throw new Error();
      thank(res.demo ? "This is the sample site, so nothing was saved."
        : kind === "question" ? "Got it. We'll reply by email."
        : "Got it. We'll look it over and email you if we need anything.");
      gaSent(role, kind);
    } catch {
      fail("That didn't send. ");
      const a = document.createElement("a");
      a.href = mailtoFor(row); a.textContent = "Send it by email instead.";
      $("form-error").append(a);
    } finally {
      btn.disabled = false; btn.textContent = SEND[kind];
    }
  }

  $("another").onclick = () => {
    const keep = [$("name").value, $("email").value];
    form.reset(); $("time").value = "20:00";
    [$("name").value, $("email").value] = keep;
    document.querySelectorAll('input[name="genre"]').forEach((b) => { b.disabled = false; });
    document.querySelectorAll('#chooser input[name="kind"]').forEach((b) => { b.checked = false; });
    $("thanks").hidden = true; $("chooser").hidden = false;
    showStep();
  };
})();
