// Google Analytics 4. Loads only when SLC_CONFIG.gaMeasurementId is set, and never on the admin page
// or on localhost, so your own review work and local testing stay out of the numbers.
(function () {
  const id = (window.SLC_CONFIG || {}).gaMeasurementId;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!id || local || /admin\.html$/.test(location.pathname)) return;

  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  const installed = matchMedia("(display-mode: standalone)").matches || document.referrer.startsWith("android-app://");
  gtag("js", new Date());
  gtag("config", id, {
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    app_mode: installed ? "app" : "web",
  });

  // Events that show how people use the calendar.
  const showName = (el) => {
    const card = el.closest("article.show, dialog");
    const h = card && card.querySelector(".title, .sd-title");
    return h ? h.textContent.trim().slice(0, 100) : "";
  };
  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("a, button");
    if (!el) return;
    if (el.matches("a.btn.primary[target=_blank]") && /ticket/i.test(el.textContent)) {
      gtag("event", "ticket_click", { show_name: showName(el), link_url: el.href, page_path: location.pathname });
    } else if (el.dataset.rsvp) {
      gtag("event", "plan_mark", { plan: el.dataset.rsvp, show_id: el.dataset.id || "" });
    } else if (el.dataset.friend) {
      gtag("event", "friend_action", { action: el.dataset.friend });
    }
  }, true);
  document.addEventListener("submit", () => {
    if (/submit\.html$/.test(location.pathname)) gtag("event", "show_submitted");
  }, true);
})();
