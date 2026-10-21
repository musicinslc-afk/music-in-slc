// "For you": builds a listening profile from Last.fm or artists the visitor types in,
// then scores each show. Everything stays in the visitor's browser.
(function () {
  const { cfg, store } = window.SLC;
  const KEY = "slc.taste.v1";
  const SIM_KEY = "slc.similar.v1";
  const LASTFM = "https://ws.audioscrobbler.com/2.0/";

  const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "");

  // profile: { source, label, artists: {key: {name, weight}}, genres: {id: weight}, similar: {key: {name, weight, because}} }
  let profile = store.get(KEY, null);

  function save(p) { profile = p; if (p) store.set(KEY, p); else store.remove(KEY); }
  function emptyProfile(source, label) { return { source, label, artists: {}, genres: {}, similar: {} }; }
  function addArtist(p, name, weight) {
    const k = norm(name);
    if (!k) return;
    const cur = p.artists[k];
    p.artists[k] = { name, weight: Math.max(weight, cur ? cur.weight : 0) };
  }

  // ---------- genre mapping (same rules as the ingest job) ----------
  let genreRules = [];
  async function loadRules() {
    if (genreRules.length) return genreRules;
    const genres = await window.SLC.loadGenres();
    genreRules = genres.map((g) => ({
      id: g.id,
      res: g.keywords.map((k) => new RegExp(`(?<![a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`)),
    }));
    return genreRules;
  }
  function mapTag(tag) {
    const t = String(tag).toLowerCase();
    return genreRules.filter((r) => r.res.some((re) => re.test(t))).map((r) => r.id);
  }
  function addGenres(p, tags, weight) {
    for (const tag of tags) for (const id of mapTag(tag)) p.genres[id] = (p.genres[id] || 0) + weight;
  }

  // ---------- Last.fm ----------
  async function lastfm(method, params) {
    if (!cfg.lastfmApiKey) throw new Error("Last.fm isn't set up on this site yet.");
    const q = new URLSearchParams({ method, api_key: cfg.lastfmApiKey, format: "json", ...params });
    const r = await fetch(`${LASTFM}?${q}`);
    const d = await r.json();
    if (d.error) throw new Error(d.message || "Last.fm request failed");
    return d;
  }

  async function fromLastfm(username) {
    await loadRules();
    const d = await lastfm("user.gettopartists", { user: username, period: "6month", limit: 60 });
    const list = d.topartists?.artist || [];
    if (!list.length) throw new Error(`No listening history found for "${username}". Check the username, or listen a bit more first.`);
    const p = emptyProfile("lastfm", `Last.fm: ${username}`);
    list.forEach((a, i) => addArtist(p, a.name, 1 - i / list.length / 2));
    const top = list.slice(0, 12);
    const tagLists = await Promise.all(top.map((a) => lastfm("artist.gettoptags", { artist: a.name }).catch(() => null)));
    tagLists.forEach((t, i) => addGenres(p, (t?.toptags?.tag || []).slice(0, 5).map((x) => x.name), 1 - i / 24));
    await expandSimilar(p);
    return p;
  }

  async function expandSimilar(p, limit = 10) {
    if (!cfg.lastfmApiKey) return;
    const cache = store.get(SIM_KEY, {});
    const seeds = Object.values(p.artists).sort((a, b) => b.weight - a.weight).slice(0, limit);
    await Promise.all(seeds.map(async (seed) => {
      const k = norm(seed.name);
      if (!cache[k]) {
        try {
          const d = await lastfm("artist.getsimilar", { artist: seed.name, limit: 40, autocorrect: 1 });
          cache[k] = (d.similarartists?.artist || []).map((a) => [a.name, Number(a.match) || 0]);
        } catch { cache[k] = []; }
      }
      for (const [name, match] of cache[k]) {
        const sk = norm(name);
        if (p.artists[sk]) continue;
        const w = match * seed.weight;
        if (!p.similar[sk] || p.similar[sk].weight < w) p.similar[sk] = { name, weight: w, because: seed.name };
      }
    }));
    store.set(SIM_KEY, cache);
  }

  // ---------- typed-in artists and genres ----------
  async function fromManual(text, genreIds) {
    await loadRules();
    const names = String(text || "").split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 40);
    const p = emptyProfile("manual", "Your picks");
    names.forEach((n, i) => addArtist(p, n, 1 - i / 80));
    for (const id of genreIds || []) p.genres[id] = (p.genres[id] || 0) + 1;
    if (names.length) {
      await expandSimilar(p, 8);
      if (cfg.lastfmApiKey) {
        const tagLists = await Promise.all(names.slice(0, 8).map((n) => lastfm("artist.gettoptags", { artist: n }).catch(() => null)));
        tagLists.forEach((t) => addGenres(p, (t?.toptags?.tag || []).slice(0, 4).map((x) => x.name), 0.6));
      }
    }
    if (!names.length && !(genreIds || []).length) throw new Error("Add a few artists or pick at least one genre.");
    return p;
  }

  // ---------- scoring ----------
  function score(show) {
    if (!profile) return null;
    let best = { score: 0, reason: "" };
    const lineup = (show.artists && show.artists.length ? show.artists : [show.title]);
    lineup.forEach((name, i) => {
      const k = norm(name);
      const billing = i === 0 ? 1 : 0.75;
      const a = profile.artists[k];
      if (a) {
        const s = 70 + 30 * a.weight * billing;
        if (s > best.score) best = { score: s, reason: i === 0 ? `You listen to ${a.name}` : `${a.name} is on the bill` };
      }
      const sim = profile.similar[k];
      if (sim) {
        const s = 25 + 45 * sim.weight * billing;
        if (s > best.score) best = { score: s, reason: `Similar to ${sim.because}` };
      }
    });
    const gMax = Math.max(1, ...Object.values(profile.genres));
    const gScore = (show.genres || []).reduce((acc, g) => acc + (profile.genres[g] || 0) / gMax, 0);
    if (gScore > 0) {
      const s = Math.min(40, 18 * gScore);
      if (s > best.score) {
        const g = (show.genres || []).filter((x) => profile.genres[x]).slice(0, 2);
        best = { score: s, reason: `Fits your ${g.map((x) => window.SLC_GENRE_LABELS?.[x] || x).join(" and ")} taste` };
      } else {
        best.score += Math.min(10, 5 * gScore);
      }
    }
    return best.score >= 15 ? best : null;
  }

  function summary() {
    if (!profile) return "";
    const artists = Object.values(profile.artists).sort((a, b) => b.weight - a.weight).slice(0, 3).map((a) => a.name);
    const genres = Object.entries(profile.genres).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([g]) => window.SLC_GENRE_LABELS?.[g] || g);
    const parts = [];
    if (artists.length) parts.push(artists.join(", "));
    if (genres.length) parts.push(genres.join(", "));
    return { label: profile.label, text: parts.join(" · "), similarCount: Object.keys(profile.similar).length };
  }

  window.SLCTaste = {
    get profile() { return profile; }, save, score, summary,
    fromLastfm, fromManual,
    hasLastfm: () => Boolean(cfg.lastfmApiKey),
  };
})();
