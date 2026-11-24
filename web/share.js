// Quick share: draws a Music in SLC branded card (a 1080 x 1920 story image) for one show or for your plans,
// then opens a share sheet: the phone's own share menu with the image (Instagram and Facebook stories, Messages),
// save image, copy link, and one-tap posts to Facebook, X, Bluesky and Threads.
(function () {
  const S = window.SLC;
  const W = 1080, H = 1920, PAD = 80;
  // Everything that matters sits in the middle 1080 x 1350: what a 4:5 Instagram feed post keeps, and clear of
  // the profile bar and reply box that cover the top and bottom of a story. Outside it is only background.
  const SAFE_TOP = 285, SAFE_BOT = 1635;
  const C = {
    bg: "#0B0614", surface: "#17102A", ink: "#F7F2FF", muted: "#B8AAD9",
    violet: "#9D4DFF", magenta: "#FF2BD6", cyan: "#29E6FF",
  };
  const DISPLAY = '"Sora", "Helvetica Neue", Arial, sans-serif';
  const BODY = '"Inter", "Segoe UI", system-ui, sans-serif';
  const TAPE = '"Permanent Marker", "Marker Felt", cursive';
  const SITE = "musicinslc.com";

  // ---------- drawing helpers ----------
  async function fonts() {
    if (!document.fonts) return;
    await Promise.all([`800 100px ${DISPLAY}`, `600 40px ${BODY}`, `400 40px ${BODY}`, `400 60px ${TAPE}`]
      .map((f) => document.fonts.load(f).catch(() => null)));
  }

  // The ridge mark: the same LED level meters as ridge.svg, read from the file so the two never drift apart
  let ridgePromise;
  function ridgeBars() {
    ridgePromise ||= fetch("ridge.svg").then((r) => r.text()).then((svg) => {
      const groups = svg.split("<g ");
      const rects = (s) => [...(s || "").matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
        .map((m) => m.slice(1, 5).map(Number));
      return { bars: rects(groups[1]), peaks: rects(groups[2]) };
    }).catch(() => ({ bars: [], peaks: [] }));
    return ridgePromise;
  }

  // Draws the ridge into a box. The meters climb violet, run hot magenta and peak cyan, like the site banner.
  function drawRidge(ctx, ridge, x, y, w, h, { base = true } = {}) {
    const vx = 8, vy = 30, vw = 284, vh = 128;   // ridge.svg viewBox
    const sx = w / vw, sy = h / vh;
    const top = y + (40 - vy) * sy, bottom = y + (150 - vy) * sy;
    const g = ctx.createLinearGradient(0, bottom, 0, top);
    g.addColorStop(0, C.violet); g.addColorStop(0.5, C.violet); g.addColorStop(0.5, C.magenta);
    g.addColorStop(0.78, C.magenta); g.addColorStop(0.78, C.cyan); g.addColorStop(1, C.cyan);
    ctx.fillStyle = g;
    for (const [rx, ry, rw, rh] of ridge.bars) ctx.fillRect(x + (rx - vx) * sx, y + (ry - vy) * sy, Math.max(1, rw * sx - 0.5), rh * sy);
    ctx.fillStyle = C.ink;
    for (const [rx, ry, rw, rh] of ridge.peaks) ctx.fillRect(x + (rx - vx) * sx, y + (ry - vy) * sy, Math.max(1, rw * sx - 0.5), Math.max(2, rh * sy));
    if (base) ctx.fillRect(x + (12 - vx) * sx, y + (152 - vy) * sy, 274 * sx, Math.max(2, 2 * sy));
  }

  // Text printed slightly out of register: magenta to the left, cyan to the right
  function splitText(ctx, text, x, y, off) {
    ctx.fillStyle = C.magenta; ctx.fillText(text, x - off, y);
    ctx.fillStyle = C.cyan; ctx.fillText(text, x + off, y);
    ctx.fillStyle = C.ink; ctx.fillText(text, x, y);
  }

  function setFont(ctx, weight, size, family, spacing = 0) {
    ctx.font = `${weight} ${size}px ${family}`;
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacing}px`;
  }

  function wrap(ctx, text, width) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width <= width || !line) line = test;
      else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    return lines;
  }

  function ellipsize(ctx, text, width) {
    if (ctx.measureText(text).width <= width) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > width) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
  }

  // The biggest size (from max down to min) that fits the text in the given number of lines
  function fitLines(ctx, text, width, maxLines, max, min, family) {
    for (let size = max; size >= min; size -= 4) {
      setFont(ctx, 800, size, family, -size * 0.01);
      const lines = wrap(ctx, text, width);
      if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= width)) return { size, lines };
    }
    setFont(ctx, 800, min, family, -min * 0.01);
    const lines = wrap(ctx, text, width).slice(0, maxLines);
    lines[maxLines - 1] = ellipsize(ctx, lines[maxLines - 1] || "", width);
    return { size: min, lines };
  }

  // Flyers come from venue sites that don't allow drawing them into an image, so they go through a public
  // image proxy that does. If neither works the card uses the initials tile, like the site.
  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }
  const proxied = (url) => `https://wsrv.nl/?url=${encodeURIComponent(url.replace(/^https?:\/\//, ""))}&w=1000&h=1000&fit=inside&output=png`;
  async function flyer(e) {
    const url = S.safeUrl(e.image_url);
    if (!url) return null;
    const direct = await loadImage(url);
    if (direct && usable(direct)) return direct;
    const viaProxy = await loadImage(proxied(url));
    return viaProxy && usable(viaProxy) ? viaProxy : null;
  }
  // An image the browser will let us read back out of the canvas
  function usable(img) {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      const x = c.getContext("2d");
      x.drawImage(img, 0, 0, 1, 1);
      x.getImageData(0, 0, 1, 1);
      return true;
    } catch { return false; }
  }

  function tileColor(name) {
    const m = S.tileStyle(name).match(/#[0-9a-f]{6}/i);
    return m ? m[0] : C.violet;
  }

  // A square of art with the out-of-register frame
  function drawArt(ctx, e, img, x, y, size, off) {
    ctx.fillStyle = C.magenta; ctx.fillRect(x - off, y - off, size, size);
    ctx.fillStyle = C.cyan; ctx.fillRect(x + off, y + off, size, size);
    ctx.fillStyle = C.surface; ctx.fillRect(x, y, size, size);
    if (img) {
      const cover = e.image_kind === "photo";
      const s = cover ? Math.max(size / img.width, size / img.height) : Math.min(size / img.width, size / img.height);
      const w = img.width * s, h = img.height * s;
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, size, size); ctx.clip();
      ctx.drawImage(img, x + (size - w) / 2, y + (size - h) / 2, w, h);
      ctx.restore();
    } else {
      const name = (e.artists && e.artists[0]) || e.title;
      const g = ctx.createLinearGradient(x, y, x + size, y + size);
      g.addColorStop(0, tileColor(name)); g.addColorStop(1, C.bg);
      ctx.fillStyle = g; ctx.fillRect(x, y, size, size);
      setFont(ctx, 800, size * 0.42, DISPLAY, -size * 0.01);
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      splitText(ctx, S.initials(name), x + size / 2, y + size / 2 + size * 0.02, Math.max(3, size * 0.012));
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    }
  }

  // Background, the wordmark at the top of the safe area, and the ridge and address at its bottom
  function frame(ctx, ridge) {
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, 1000);
    glow.addColorStop(0, "rgba(163, 91, 255, 0.28)"); glow.addColorStop(1, "rgba(11, 6, 20, 0)");
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

    // Background only: faint ridges in the strips Instagram covers or crops
    ctx.globalAlpha = 0.22;
    drawRidge(ctx, ridge, -6, 40, W + 12, 200, { base: false });
    drawRidge(ctx, ridge, -6, SAFE_BOT + 50, W + 12, 200, { base: false });
    ctx.globalAlpha = 1;

    // Wordmark, centered and large: ridge, MUSIC IN over SLC
    setFont(ctx, 800, 132, DISPLAY, -5);
    const slcW = ctx.measureText("SLC").width;
    setFont(ctx, 800, 40, DISPLAY, 12);
    const inW = ctx.measureText("MUSIC IN").width;
    const rw = 280, rh = 126, gap = 30;
    const x0 = (W - (rw + gap + Math.max(slcW, inW))) / 2;
    const base = SAFE_TOP + 155;
    drawRidge(ctx, ridge, x0, base - rh, rw, rh);
    ctx.fillStyle = C.ink; ctx.fillText("MUSIC IN", x0 + rw + gap + 4, base - 104);
    setFont(ctx, 800, 132, DISPLAY, -5);
    splitText(ctx, "SLC", x0 + rw + gap, base, 6);

    // Bottom of the safe area: the ridge across the width, then the address on a white bar
    const barH = 120, barTop = SAFE_BOT - barH;
    ctx.globalAlpha = 0.95;
    drawRidge(ctx, ridge, -6, barTop - 96, W + 12, 96, { base: false });
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.ink; ctx.fillRect(0, barTop, W, barH);
    setFont(ctx, 600, 26, BODY, 6);
    ctx.fillStyle = C.bg; ctx.textAlign = "center";
    ctx.fillText("FIND LIVE MUSIC IN SALT LAKE", W / 2, barTop + 42);
    setFont(ctx, 800, 58, DISPLAY, -1);
    ctx.fillText(SITE.toUpperCase(), W / 2, barTop + 100);
    ctx.textAlign = "left";
  }

  // White tape with marker lettering, like the venue labels on the site
  function tape(ctx, text, x, y) {
    setFont(ctx, 400, 64, TAPE, 1);
    const w = ctx.measureText(text).width + 64;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(-0.035);
    ctx.fillStyle = C.magenta; ctx.fillRect(-6, -6, w, 96);
    ctx.fillStyle = C.cyan; ctx.fillRect(6, 6, w, 96);
    ctx.fillStyle = C.ink; ctx.fillRect(0, 0, w, 96);
    ctx.fillStyle = C.bg; ctx.fillText(text, 32, 72);
    ctx.restore();
  }

  function whenLine(e) {
    const d = new Date(e.starts_at);
    const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short", month: "short", day: "numeric" }).format(d);
    return `${day} · ${S.timeLabel(e.starts_at)}`.toUpperCase();
  }

  const TAPES = { going: "I'M GOING", maybe: "THINKING ABOUT IT" };

  // ---------- one show ----------
  async function showCard(e, status) {
    const [ridge, img] = await Promise.all([ridgeBars(), flyer(e), fonts()]);
    const cv = Object.assign(document.createElement("canvas"), { width: W, height: H });
    const ctx = cv.getContext("2d");
    frame(ctx, ridge);
    tape(ctx, TAPES[status] || "SEE YOU THERE?", PAD, SAFE_TOP + 196);

    const size = 470, ax = (W - size) / 2, ay = SAFE_TOP + 330;
    drawArt(ctx, e, img, ax, ay, size, 12);

    let y = ay + size + 66;
    setFont(ctx, 600, 40, BODY, 3);
    ctx.fillStyle = C.cyan; ctx.fillText(whenLine(e), PAD, y);
    const t = fitLines(ctx, e.title.toUpperCase(), W - PAD * 2, 2, 80, 44, DISPLAY);
    y += 28;
    for (const line of t.lines) { y += t.size * 0.94; splitText(ctx, line, PAD, y, Math.max(3, t.size * 0.03)); }
    setFont(ctx, 600, 40, BODY, 0);
    ctx.fillStyle = C.ink;
    y += 56;
    const where = [e.venue_name, e.city && e.city !== "Salt Lake City" ? e.city : ""].filter(Boolean).join(" · ");
    ctx.fillText(ellipsize(ctx, where, W - PAD * 2), PAD, y);
    return cv;
  }

  // ---------- your plans ----------
  async function plansCard(rows, who) {
    const shown = rows.slice(0, 5);
    const [ridge, imgs] = await Promise.all([ridgeBars(), Promise.all(shown.map(({ e }) => flyer(e))), fonts()]);
    const cv = Object.assign(document.createElement("canvas"), { width: W, height: H });
    const ctx = cv.getContext("2d");
    frame(ctx, ridge);
    tape(ctx, "WHERE I'LL BE", PAD, SAFE_TOP + 196);
    if (who) {
      setFont(ctx, 600, 32, BODY, 0);
      ctx.fillStyle = C.muted; ctx.fillText(ellipsize(ctx, who, W - PAD * 2), PAD, SAFE_TOP + 340);
    }

    const rowH = 146, thumb = 120, top = SAFE_TOP + (who ? 372 : 330);
    shown.forEach(({ e, status }, i) => {
      const y = top + i * rowH;
      drawArt(ctx, e, imgs[i], PAD + 6, y, thumb, 6);
      const tx = PAD + thumb + 44, tw = W - tx - PAD;
      setFont(ctx, 600, 26, BODY, 2);
      ctx.fillStyle = C.cyan;
      const when = whenLine(e);
      ctx.fillText(when, tx, y + 30);
      if (status === "maybe") {
        const wx = tx + ctx.measureText(when).width + 18;
        ctx.fillStyle = C.magenta; ctx.fillText("MAYBE", wx, y + 30);
      }
      const t = fitLines(ctx, e.title.toUpperCase(), tw, 1, 48, 32, DISPLAY);
      ctx.fillStyle = C.ink; ctx.fillText(t.lines[0], tx, y + 30 + t.size + 6);
      setFont(ctx, 500, 28, BODY, 0);
      ctx.fillStyle = C.muted; ctx.fillText(ellipsize(ctx, e.venue_name, tw), tx, y + 116);
    });
    if (rows.length > shown.length) {
      setFont(ctx, 600, 30, BODY, 0);
      ctx.fillStyle = C.ink;
      ctx.fillText(`+ ${rows.length - shown.length} more on ${SITE}`, PAD + 6, top + shown.length * rowH + 8);
    }
    return cv;
  }

  function toBlob(cv) {
    return new Promise((resolve) => {
      try { cv.toBlob((b) => resolve(b), "image/png"); } catch { resolve(null); }
    });
  }

  // ---------- the share sheet ----------
  let dlg;
  function sheet() {
    if (dlg) return dlg;
    dlg = document.createElement("dialog");
    dlg.className = "share-sheet";
    dlg.setAttribute("aria-labelledby", "ss-title");
    document.body.appendChild(dlg);
    dlg.addEventListener("click", (ev) => { if (ev.target === dlg) dlg.close(); });
    dlg.addEventListener("close", () => {
      const img = dlg.querySelector(".ss-preview img");
      if (img?.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
    });
    return dlg;
  }

  const SOCIAL = [
    ["facebook", "Facebook", (t, u) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(u)}`],
    ["x", "X", (t, u) => `https://x.com/intent/post?text=${encodeURIComponent(t)}&url=${encodeURIComponent(u)}`],
    ["bluesky", "Bluesky", (t, u) => `https://bsky.app/intent/compose?text=${encodeURIComponent(`${t} ${u}`)}`],
    ["threads", "Threads", (t, u) => `https://www.threads.net/intent/post?text=${encodeURIComponent(`${t} ${u}`)}`],
  ];

  async function open({ title, text, url, file, draw }) {
    const d = sheet();
    d.innerHTML = `<form method="dialog" class="sd-close-row"><button class="sd-close" aria-label="Close">×</button></form>
      <div class="ss-grid">
        <div class="ss-preview" aria-busy="true"><span class="ss-making">Making your card…</span></div>
        <div class="ss-side">
          <h2 class="ss-title" id="ss-title">${S.esc(title)}</h2>
          <p class="ss-text">${S.esc(text)}</p>
          <div class="ss-main">
            <button class="btn primary" type="button" data-ss="native" hidden>Share image</button>
            <button class="btn" type="button" data-ss="save" disabled>Save image</button>
            <button class="btn" type="button" data-ss="copy">Copy link</button>
          </div>
          <p class="ss-hint" data-ss-hint hidden>For an Instagram or Facebook story, save the image, then add it to your story from your photos.</p>
          <div class="ss-social" aria-label="Post to">
            <button class="ss-net ss-instagram" type="button" data-ss="instagram" disabled>Instagram</button>
            ${SOCIAL.map(([k, label, href]) => `<a class="ss-net ss-${k}" href="${S.esc(href(text, url))}" target="_blank" rel="noopener">${label}</a>`).join("")}
          </div>
          <p class="ss-note" aria-live="polite"></p>
        </div>
      </div>`;
    if (!d.open) d.showModal();
    const note = d.querySelector(".ss-note");
    const $ = (k) => d.querySelector(`[data-ss="${k}"]`);

    $("copy").onclick = async () => {
      try { await navigator.clipboard.writeText(url); note.textContent = "Link copied."; }
      catch { note.textContent = `Copy this link: ${url}`; }
    };

    let blob = null;
    try { blob = await toBlob(await draw()); } catch { blob = null; }
    if (!d.open) return;
    const preview = d.querySelector(".ss-preview");
    preview.removeAttribute("aria-busy");
    if (!blob) {
      preview.innerHTML = `<span class="ss-making">The image didn't draw on this browser. The link still works.</span>`;
      return;
    }
    const src = URL.createObjectURL(blob);
    preview.innerHTML = `<img src="${src}" alt="Share card: ${S.esc(text)}">`;
    const f = new File([blob], file, { type: "image/png" });

    const save = $("save");
    save.disabled = false;
    save.onclick = () => {
      const a = Object.assign(document.createElement("a"), { href: src, download: file });
      document.body.appendChild(a); a.click(); a.remove();
      note.textContent = "Saved. Add it to your story or post from your photos.";
    };
    const canFile = navigator.canShare && navigator.canShare({ files: [f] });
    // Instagram has no web share link. On phones, sharing the image alone puts Instagram (story, post or
    // message) in the share menu; elsewhere the image is saved to post from the phone.
    const ig = $("instagram");
    ig.disabled = false;
    ig.onclick = async () => {
      if (canFile) {
        try { await navigator.share({ files: [f] }); }
        catch (err) { if (err?.name !== "AbortError") note.textContent = "Sharing didn't work. Save the image and post it from Instagram."; }
      } else {
        save.onclick();
        note.textContent = "Saved. Open Instagram on your phone and add it to your story.";
      }
    };
    if (canFile) {
      const native = $("native");
      native.hidden = false;
      native.onclick = async () => {
        try { await navigator.share({ files: [f], title, text: `${text} ${url}` }); }
        catch (err) { if (err?.name !== "AbortError") note.textContent = "Sharing didn't work. Save the image instead."; }
      };
      native.focus();
    } else {
      d.querySelector("[data-ss-hint]").hidden = false;
    }
  }

  const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "show";
  const dateWords = (e) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "long", month: "long", day: "numeric" }).format(new Date(e.starts_at));

  // Share one show. status is "going", "maybe" or empty.
  function show(e, status) {
    const url = new URL(`index.html#show-${encodeURIComponent(e.id)}`, location.href).href;
    const lead = status === "going" ? "I'm going to" : status === "maybe" ? "Thinking about" : "Check out";
    const text = `${lead} ${e.title} at ${e.venue_name}, ${dateWords(e)}. Found on Music in SLC.`;
    return open({ title: status === "going" ? "Tell your friends" : "Share this show", text, url,
      file: `musicinslc-${slug(e.title)}.png`, draw: () => showCard(e, status) });
  }

  // Share your upcoming plans: rows are [{ e, status }]
  function plans(rows, { name, url } = {}) {
    const going = rows.filter((r) => r.status === "going").length;
    const text = going
      ? `Where I'll be: ${going} show${going === 1 ? "" : "s"} coming up. See my plans on Music in SLC.`
      : "Shows I'm thinking about. Come along? See my plans on Music in SLC.";
    return open({ title: "Share your plans", text, url: url || new URL("index.html", location.href).href,
      file: "musicinslc-my-shows.png", draw: () => plansCard(rows, name) });
  }

  window.SLCShare = { show, plans, showCard, plansCard };
})();
