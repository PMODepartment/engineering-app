// ============================================================================
// Megawide Engineering App — Global Config
// ----------------------------------------------------------------------------
// Single source of truth for Supabase credentials and app-wide constants.
// Every page and every module loads THIS file first (before auth.js / db.js).
//
// ⚠️ This app runs on its OWN Supabase project, separate from the Planners
// Dashboard (bgupuqnkqhixpuctyder). The two projects have separate auth.users
// tables, so accounts do NOT carry over — a Planning App user must request
// access here once and be approved by an Engineering App admin. See
// docs/MIGRATION.md for the data/user migration procedure.
// ============================================================================

window.APP_CONFIG = {
  // ---- Supabase (Engineering App project) ----
  SUPABASE_URL: 'https://zkxzaijznutmiueeurbb.supabase.co',
  // Settings → API → API Keys → "publishable" key (sb_publishable_…). This key is
  // SAFE to expose (RLS protects the data). NEVER put the secret/service_role key here.
  SUPABASE_ANON_KEY: 'sb_publishable_nkj5aCgbCoo406osOgHPAA_hQPS9uzO',

  // ---- App ----
  APP_NAME: 'Engineering App',
  ORG: 'Megawide Construction Corporation',

  // ---- Sibling app (used by the cross-app links in the sidebar) ----
  PLANNING_APP_URL: 'https://pmodepartment.github.io/planning-app/',

  // ---- Engineering modules (the module launcher reads this list) ----
  // `key`     — folder name under /modules and DB table prefix
  // `path`    — entry page
  // `icon`    — icon name from assets/js/icons.js
  // `enabled` — flip to true as each module is delivered
  //
  // Future engineering modules (RFI Management, Technical Submittals, Design
  // Review, Document Transmittal, Method Statements, Inspection Requests, NCR
  // Management) are added here as new entries + a folder under /modules. No
  // shell changes are required — the launcher, nav and dashboard all read this
  // list. Follow docs/MODULE_GUIDE.md.
  MODULES: [
    { key: 'drawing-register',   name: 'Drawing Register',       path: 'modules/drawing-register/index.html',   icon: 'ruler', enabled: true },
    { key: 'material-submittal', name: 'Material Submittal Log', path: 'modules/material-submittal/index.html', icon: 'box',   enabled: true },
  ],
};

// ---------------------------------------------------------------------------
// Project hand-off from the Planners Dashboard.
// The Planning App's redirect stubs link here with ?project=<id>. Adopt it into
// the sessionStorage key every module and page reads (`pd_project`) so a user
// who clicks "Drawing Register" over there lands on the same project here,
// instead of being bounced to the project selector.
//
// This lives in config.js because config.js is the FIRST script on every page,
// so the value is in place before any page's own bootstrap reads it.
//
// ⚠️ Only the project id is adopted, and only from our own query string — never
// a name or any display text, which would be attacker-controlled content
// rendered into the topbar. The id is validated against the register's own
// format and the row is still fetched from the database, so a bogus id simply
// fails project access (RLS) rather than granting anything.
// ---------------------------------------------------------------------------
(function () {
  try {
    var m = /[?&]project=([^&]+)/.exec(location.search);
    if (!m) return;
    var pid = decodeURIComponent(m[1]);
    // Project ids are short uppercase codes (e.g. 'AVR101', 'BAU101-TEST').
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(pid)) return;
    if (sessionStorage.getItem('pd_project') !== pid) {
      sessionStorage.setItem('pd_project', pid);
      // The name is deliberately NOT carried over — the shell re-reads it from
      // the projects table, which is the trustworthy source.
      sessionStorage.removeItem('pd_project_name');
      sessionStorage.removeItem('pd_workspace');
    }
  } catch (e) { /* private-mode sessionStorage — fall back to the selector */ }
})();
