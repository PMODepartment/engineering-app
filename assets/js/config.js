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

  // ---- Where signing in lands -----------------------------------------------
  // ⚠️ HOME IS THE PORTFOLIO, NOT THE PROJECT LIST. Until org-wide modules existed,
  // "choose a project" was reasonably the first thing the app asked. It is not any
  // more: Portfolio and Initiatives are meaningful with nothing selected, and making
  // the project list the gate meant the only route to a module that needs no project
  // ran through choosing one. Landing on the Portfolio puts the department-level view
  // first and demotes picking a project to a step you take from it.
  //
  // ⚠️ `projects.html` STILL CLEARS THE SELECTION when it loads — it is still the
  // selection step, and that rule is unchanged. What changed is only where you arrive.
  //
  // ⚠️ Paths here are ROOT-RELATIVE. Callers inside modules/<key>/ must prefix
  // '../../' (AppAuth.redirect() and Nav already do).
  HOME: 'modules/portfolio/index.html',

  // ---- Engineering modules (the module launcher reads this list) ----
  // `key`     — folder name under /modules and DB table prefix
  // `path`    — entry page
  // `icon`    — icon name from assets/js/icons.js
  // `enabled` — flip to true as each module is delivered
  // `orgWide` — OPTIONAL, default false. A module that is NOT scoped to a single
  //             project. ⚠️ nav.js gates every project-scoped item behind a
  //             project selection, because those pages bounce straight back to
  //             projects.html otherwise. An org-wide module is meaningful with
  //             nothing selected, so gating it would make it unreachable from a
  //             cold start — set this and nav.js leaves it alone. The module
  //             itself must then also NOT redirect to projects.html.
  //
  // Future engineering modules (RFI Management, Technical Submittals, Design
  // Review, Document Transmittal, Method Statements, Inspection Requests, NCR
  // Management) are added here as new entries + a folder under /modules. No
  // shell changes are required — the launcher, nav and dashboard all read this
  // list. Follow docs/MODULE_GUIDE.md.
  MODULES: [
    { key: 'drawing-register',   name: 'Drawing Register',       path: 'modules/drawing-register/index.html',   icon: 'ruler',     enabled: true },
    { key: 'material-submittal', name: 'Material Submittal Log', path: 'modules/material-submittal/index.html', icon: 'box',       enabled: true },
    { key: 'method-register',    name: 'Method Register',        path: 'modules/method-register/index.html',    icon: 'clipboard', enabled: true },
    { key: 'value-engineering',  name: 'Value Engineering List', path: 'modules/value-engineering/index.html',  icon: 'calculator', enabled: true },
    // The RFA register (migration 0020). Project-scoped, so it IS gated when no
    // project is chosen — do not add `orgWide` here.
    { key: 'request-for-approval', name: 'Request for Approval', path: 'modules/request-for-approval/index.html', icon: 'fileText', enabled: true },
    // ⚠️ ORG-WIDE. See `orgWide` above before copying either of these lines — a module
    // marked org-wide must ALSO never redirect to projects.html from its own init(),
    // or it becomes unreachable from a cold start (nav does not gate it, so nothing
    // sets a project for it, so a redirect there is a dead end).
    { key: 'initiatives',        name: 'Initiatives',            path: 'modules/initiatives/index.html',        icon: 'bulb',      enabled: true, orgWide: true },
    // Cross-project engineering rollup: high-level Gantt + ISD status, grouped by
    // group head. Owns no table — it reads drawing_register with no project
    // predicate and lets RLS scope it.
    { key: 'portfolio',          name: 'Portfolio',              path: 'modules/portfolio/index.html',          icon: 'barChart',  enabled: true, orgWide: true },
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
      sessionStorage.removeItem('pd_group_head');
    }
  } catch (e) { /* private-mode sessionStorage — fall back to the selector */ }
})();
