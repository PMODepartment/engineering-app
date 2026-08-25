// ============================================================================
// Planners Dashboard — Shared Auth (AppAuth)
// ----------------------------------------------------------------------------
// Wraps Supabase Auth + the `users` profile table. Every page (shell AND every
// module) uses this so there is ONE login across the whole dashboard.
//
// Load order on every page:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="assets/js/config.js"></script>
//   <script src="assets/js/auth.js"></script>
//   <script src="assets/js/db.js"></script>
//   <script src="assets/js/ui.js"></script>
//
// Module pages live one level deeper (modules/<name>/index.html), so they load
// the same files with a ../../ prefix. See MODULE_CONTRACT.md.
// ============================================================================

(function () {
  // Create the Supabase client once, synchronously, on the window.
  if (!window.__sb) {
    var c = window.APP_CONFIG || {};
    window.__sb = window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY);
  }

  function getSB() { return window.__sb; }

  // Roles, highest → lowest privilege.
  var ROLES = ['super_admin', 'admin', 'planner', 'user', 'viewer'];
  var AUTO_APPROVE = ['super_admin', 'admin', 'planner'];

  async function loadProfile(user) {
    // Always fetch fresh: admin edits (name/role/status) must take effect
    // without forcing the user to log out. This call is cheap.
    var { data, error } = await getSB()
      .from('users').select('*').eq('id', user.id).single();
    if (error || !data) return null;
    return data;
  }

  function redirect(page) {
    // Works from both the shell (root) and modules (../../) — compute prefix.
    var depth = (location.pathname.match(/\/modules\//)) ? '../../' : '';
    location.href = depth + page;
  }

  // ensureProfile(user): self-heal — if an auth user has no profile row yet
  // (e.g. created via email confirmation, or an earlier insert failed), create
  // a pending one so they go to pending.html instead of looping on login.
  async function ensureProfile(user) {
    var ins = await getSB().from('users').insert({
      id: user.id, email: user.email,
      name: (user.user_metadata && user.user_metadata.name) || user.email,
      role: 'user', status: 'pending', projects: [],
    }).select().single();
    if (!ins.error && ins.data) return ins.data;
    // Insert may race / already exist — re-read.
    var re = await getSB().from('users').select('*').eq('id', user.id).single();
    return re.error ? null : re.data;
  }

  // requireLogin(cb): ensures an approved, signed-in user; else redirects.
  // IMPORTANT: a sessioned user with a missing/unapproved profile must NEVER be
  // sent back to index.html — index.html bounces sessions to dashboard, which
  // would create an infinite loop. Send them to pending.html (or sign out).
  async function requireLogin(cb) {
    var { data: { session } } = await getSB().auth.getSession();
    if (!session) return redirect('index.html');

    var profile = await loadProfile(session.user);
    if (!profile) profile = await ensureProfile(session.user);   // self-heal
    if (!profile) {                 // truly cannot load/create → break the loop
      await getSB().auth.signOut();
      return redirect('index.html');
    }
    if (profile.status !== 'approved') return redirect('pending.html');

    window.__profile = profile;
    window.__role = profile.role;
    if (cb) cb(session.user, profile);
  }

  // requireRole(roles, cb): like requireLogin but also gates on role membership.
  async function requireRole(roles, cb) {
    return requireLogin(function (user, profile) {
      if (roles.indexOf(profile.role) === -1) {
        alert('You do not have access to this page.');
        // Home, not the project list: being refused a page is not a reason to make
        // someone choose a project before they can see anything.
        return redirect(APP_CONFIG.HOME);
      }
      if (cb) cb(user, profile);
    });
  }

  function requireAdmin(cb) { return requireRole(['super_admin', 'admin'], cb); }

  function isAutoApprove(profile) {
    return AUTO_APPROVE.indexOf((profile || {}).role) !== -1;
  }

  // canAccessProject(profile, projectId): admins see all; others by assignment.
  function canAccessProject(profile, projectId) {
    if (!profile) return false;
    if (profile.role === 'super_admin' || profile.role === 'admin') return true;
    return (profile.projects || []).indexOf(projectId) !== -1;
  }

  async function login(email, password) {
    return getSB().auth.signInWithPassword({ email: email, password: password });
  }

  // loginWithMicrosoft(): redirects to Microsoft (Azure AD) via Supabase's
  // "azure" OAuth provider. On return, Supabase completes the session from the
  // URL automatically (detectSessionInUrl, on by default) — the landing page just
  // calls requireLogin() as usual, which self-heals a profile row for a first-time
  // Microsoft sign-in the same way email sign-up does.
  //
  // ⚠⚠ THE RETURN URL IS DELIBERATELY STILL projects.html, NOT APP_CONFIG.HOME.
  // Supabase only completes a session for a redirect URL that is on the project's
  // allow-list, and `projects.html` is the one that has been there and working.
  // Pointing this at a new path without adding it to that list first would break
  // Microsoft sign-in outright — an external config change this code cannot make or
  // verify. `projects.html` forwards an OAuth return on to HOME instead, so every
  // sign-in route still ends at the same place. If the allow-list is ever updated to
  // include the module path, this can be simplified — not before.
  async function loginWithMicrosoft() {
    return getSB().auth.signInWithOAuth({
      provider: 'azure',
      options: {
        redirectTo: location.origin + location.pathname.replace(/index\.html$/, '') + 'projects.html',
        scopes: 'email',
      },
    });
  }

  async function register(email, password, name) {
    var res = await getSB().auth.signUp({ email: email, password: password });
    if (res.error) return res;
    // Create the pending profile row.
    if (res.data && res.data.user) {
      await getSB().from('users').insert({
        id: res.data.user.id, email: email, name: name,
        role: 'user', status: 'pending', projects: [],
      });
    }
    return res;
  }

  async function logout() {
    await getSB().auth.signOut();
    redirect('index.html');
  }

  window.AppAuth = {
    getSB: getSB, ROLES: ROLES,
    requireLogin: requireLogin, requireRole: requireRole, requireAdmin: requireAdmin,
    isAutoApprove: isAutoApprove, canAccessProject: canAccessProject,
    login: login, loginWithMicrosoft: loginWithMicrosoft, register: register, logout: logout,
  };
  window.getSB = getSB;
})();
