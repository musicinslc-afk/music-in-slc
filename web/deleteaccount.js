// Delete your account: works from the Me page in the app, or on its own for someone who has
// removed the app. The database function delete_my_account() only ever deletes the caller.
(function () {
  const S = window.SLC;
  const $ = (id) => document.getElementById(id);
  // Everything this site keeps in the browser that belongs to a person
  const PERSONAL = ["slc.plans.v1", "slc.plans.queue.v1", "slc.addfriend.v1", "slc.taste.v1",
    "slc.similar.v1", "slc.you.v1", "slc.you.tab.v1"];
  const sb = S.live && window.supabase ? window.supabase.createClient(S.cfg.supabaseUrl, S.cfg.supabaseAnonKey) : null;
  let deleted = false;

  function show(id) {
    $("loading").hidden = true;
    for (const s of ["signed-out", "signed-in", "done"]) $(s).hidden = s !== id;
  }
  function note(el, ok, text) {
    el.hidden = false;
    el.className = `notice ${ok ? "ok" : "err"}`;
    el.textContent = text;
  }
  function render(user) {
    if (deleted) return;
    if (!user) { show("signed-out"); return; }
    $("acct-email").textContent = user.email || "";
    show("signed-in");
  }

  $("confirm").onchange = () => { $("delete-btn").disabled = !$("confirm").checked; };

  $("signin-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const msg = $("signin-msg");
    if (!sb) { note(msg, false, "Sign-in isn't available right now. Email us using the address below."); return; }
    const btn = ev.submitter;
    btn.disabled = true;
    const { error } = await sb.auth.signInWithOtp({
      email: $("signin-email").value.trim(),
      // shouldCreateUser: false so asking to delete never makes a new account
      options: { emailRedirectTo: new URL("delete-account.html", location.href).href, shouldCreateUser: false },
    });
    btn.disabled = false;
    note(msg, !error, error
      ? "We couldn't send a link. Check that this is the email you sign in with and try again in a minute, or email us using the address below."
      : "Check your email and open the link in this browser.");
  };

  $("delete-form").onsubmit = async (ev) => {
    ev.preventDefault();
    if (!$("confirm").checked) return;
    const btn = $("delete-btn");
    $("delete-error").hidden = true;
    btn.disabled = true;
    btn.textContent = "Deleting…";
    let error;
    try { ({ error } = await sb.rpc("delete_my_account")); } catch (err) { error = err; }
    if (error) {
      btn.disabled = false;
      btn.textContent = "Delete my account";
      note($("delete-error"), false, error.code === "42501"
        ? error.message
        : "Your account wasn't deleted. Try again, or email us using the address below.");
      return;
    }
    deleted = true;
    // The login no longer exists, so only this browser's copy of the session needs clearing
    await sb.auth.signOut({ scope: "local" }).catch(() => null);
    PERSONAL.forEach((k) => S.store.remove(k));
    $("intro").hidden = true;
    show("done");
    $("done").focus();
  };

  if (!sb) { render(null); return; }
  sb.auth.onAuthStateChange((_event, session) => render(session?.user));
  sb.auth.getSession().then(({ data }) => render(data.session?.user)).catch(() => render(null));
})();
