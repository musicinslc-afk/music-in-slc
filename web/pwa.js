// The installable app: registers the service worker, mirrors this browser's saved settings into
// IndexedDB (where the service worker can read them for the weekly push), shows an offline bar,
// and offers an "Add to home screen" card on the You page.
(function () {
  const VISITS = "slc.visits.v1";
  const DISMISSED = "slc.install.dismissed.v1";

  // ---------- IndexedDB mirror of slc.* settings ----------
  let dbPromise;
  function db() {
    if (!("indexedDB" in self)) return Promise.reject(new Error("no indexedDB"));
    dbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open("slc", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  function tx(mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction("kv", mode);
      fn(t.objectStore("kv"));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    })).catch(() => { /* private mode or blocked storage: localStorage still works */ });
  }
  const SLCDB = {
    put: (key, value) => tx("readwrite", (s) => s.put(value, key)),
    remove: (key) => tx("readwrite", (s) => s.delete(key)),
    get: (key) => db().then((d) => new Promise((resolve) => {
      const r = d.transaction("kv").objectStore("kv").get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    })).catch(() => undefined),
  };
  window.SLCDB = SLCDB;

  function mirrorAll() {
    let entries = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("slc.")) entries.push([k, JSON.parse(localStorage.getItem(k))]);
      }
    } catch { entries = []; }
    if (entries.length) tx("readwrite", (s) => entries.forEach(([k, v]) => s.put(v, k)));
  }

  // ---------- service worker ----------
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker not registered", err));
    });
  }

  // ---------- offline bar ----------
  let savedAt = null;
  const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "numeric", minute: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short", month: "short", day: "numeric" });
  function savedLabel(iso) {
    const d = new Date(iso);
    const sameDay = dayFmt.format(d) === dayFmt.format(new Date());
    return sameDay ? `at ${timeFmt.format(d).toLowerCase()}` : `on ${dayFmt.format(d)}`;
  }
  let bar;
  function renderBar() {
    const offline = navigator.onLine === false;
    if (!offline && !savedAt) { if (bar) bar.hidden = true; return; }
    if (!bar) {
      bar = Object.assign(document.createElement("div"), { className: "offline-bar", role: "status" });
      const header = document.querySelector(".site-header");
      if (header) header.after(bar); else document.body.prepend(bar);
    }
    bar.hidden = false;
    bar.textContent = savedAt
      ? `You're offline. Showing shows saved ${savedLabel(savedAt)}.`
      : "You're offline. Some things may not load until you reconnect.";
  }
  window.addEventListener("slc:saved-data", (e) => { savedAt = e.detail || null; renderBar(); });
  window.addEventListener("offline", renderBar);
  window.addEventListener("online", () => { savedAt = null; renderBar(); });

  // ---------- install card ----------
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; renderCard(); });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    const card = document.getElementById("install-card");
    if (card) card.hidden = true;
  });

  const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isIOSSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);

  function read(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
  function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } }

  const SHARE_ICON = '<svg class="ic-share" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/><path d="M6 11H5v10h14V11h-1" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

  function renderCard() {
    const card = document.getElementById("install-card");
    if (!card) return;
    const visits = read(VISITS, 0);
    const show = !standalone() && !read(DISMISSED, false) && visits >= 2 && (deferred || isIOSSafari);
    card.hidden = !show;
    if (!show) return;
    const body = card.querySelector(".install-body");
    if (deferred) {
      body.innerHTML = `<p>Open Music in SLC from your home screen like any other app. It works offline with the last shows you loaded.</p>
        <div class="you-inline"><button class="btn primary" type="button" id="install-go">Add to home screen</button>
        <button class="btn ghost" type="button" id="install-later">Not now</button></div>`;
      card.querySelector("#install-go").onclick = async () => {
        deferred.prompt();
        const choice = await deferred.userChoice.catch(() => null);
        deferred = null;
        if (choice?.outcome === "accepted") card.hidden = true; else renderCard();
      };
    } else {
      body.innerHTML = `<p>Open Music in SLC from your home screen like any other app. On iPhone, adding it is also what lets it send you a weekly pick of shows.</p>
        <ol class="install-steps">
          <li>Tap the Share button ${SHARE_ICON} at the bottom of Safari.</li>
          <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
          <li>Tap <strong>Add</strong>, then open Music in SLC from your home screen.</li>
        </ol>
        <div class="you-inline"><button class="btn ghost" type="button" id="install-later">Not now</button></div>`;
    }
    card.querySelector("#install-later").onclick = () => { write(DISMISSED, true); card.hidden = true; };
  }

  function countVisit() {
    if (sessionStorage.getItem("slc.counted")) return;
    try { sessionStorage.setItem("slc.counted", "1"); } catch { /* ignore */ }
    write(VISITS, read(VISITS, 0) + 1);
  }

  try { countVisit(); } catch { /* storage blocked */ }
  mirrorAll();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { renderBar(); renderCard(); });
  else { renderBar(); renderCard(); }
})();
