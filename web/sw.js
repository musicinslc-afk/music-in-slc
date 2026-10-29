// Music in SLC service worker: keeps the app shell and the last loaded shows on the phone,
// so the installed app opens offline. The site workflow stamps VERSION with the commit on each deploy.
const VERSION = "dev";
const SHELL = `slc-shell-${VERSION}`;
const DATA = "slc-data-v2";
const LIBS = "slc-libs-v1";
const PAGES = ["index.html", "week.html", "venues.html", "you.html", "submit.html"];
const EXTRA = ["manifest.webmanifest", "genres.json", "venues.json", "icons/icon-192.png", "icons/apple-touch-icon.png"];
const DATA_PATHS = /\/rest\/v1\/(events|venues|artists)\b/;
const LIB_HOSTS = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

// Cache each page plus every local script, style and image it references (they carry ?v=<commit>).
async function precache() {
  const cache = await caches.open(SHELL);
  const urls = new Set(EXTRA);
  for (const page of PAGES) {
    try {
      const res = await fetch(page, { cache: "no-cache" });
      if (!res.ok) continue;
      const html = await res.clone().text();
      await cache.put(page, res);
      for (const m of html.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css|svg|png|json)(?:\?[^"]*)?)"/g)) urls.add(m[1]);
    } catch { /* offline during install: runtime caching fills in later */ }
  }
  await Promise.all([...urls].map((u) => cache.add(u).catch(() => null)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, DATA, LIBS]);
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));

// Pages: network first so a deploy shows up right away; the saved copy when offline or slow.
async function page(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await Promise.race([fetch(request), timeout(5000)]);
    if (res.ok) {
      const name = new URL(request.url).pathname.replace(/^\//, "") || "index.html";
      cache.put(name, res.clone());
    }
    return res;
  } catch {
    const url = new URL(request.url);
    const name = url.pathname.replace(/^\//, "") || "index.html";
    return (await cache.match(name)) || (await cache.match(request, { ignoreSearch: true })) ||
      (await cache.match("index.html")) || Response.error();
  }
}

// Shows, venues and band links: network first, stamped with the time they were saved.
// Queries carry a "since" timestamp that changes on every load, so the saved copy is keyed without it.
const dataKey = (url) => url.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "now");
async function data(request) {
  const cache = await caches.open(DATA);
  const key = dataKey(request.url);
  try {
    const res = await fetch(request);
    if (res.ok) {
      const body = await res.clone().blob();
      const headers = new Headers(res.headers);
      headers.set("x-slc-saved-at", new Date().toISOString());
      cache.put(key, new Response(body, { status: res.status, headers }));
    }
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

// Local files and libraries: serve the saved copy, refresh it in the background.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const fresh = fetch(request).then((res) => {
    if (res.ok || res.type === "opaque") cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await fresh) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (request.mode === "navigate" && url.origin === location.origin) return event.respondWith(page(request));
  if (DATA_PATHS.test(url.pathname) && url.hostname.endsWith(".supabase.co")) return event.respondWith(data(request));
  if (url.origin === location.origin) return event.respondWith(staleWhileRevalidate(request, SHELL));
  if (LIB_HOSTS.includes(url.hostname)) return event.respondWith(staleWhileRevalidate(request, LIBS));
});
