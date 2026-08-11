// ============================================================================
// Megawide Engineering App — Permissions (Perm)
// ----------------------------------------------------------------------------
// Maps the EXISTING Planners Dashboard role set (super_admin / admin / planner /
// user / viewer) onto engineering ACTIONS. No new role system is introduced —
// this is a thin, declarative capability layer over the same roles, so a user's
// role means the same thing in both apps.
//
// ⚠️ THIS FILE IS A UX LAYER ONLY. It decides what to SHOW. Every capability
// below has a matching server-side guard in Postgres (RLS policies and the
// status-transition trigger in migrations/0001-engineering-core.sql). Never
// treat a hidden button as access control — the database is the authority.
//
//   Capability          super_admin  admin  planner  user   viewer
//   view                    ✓          ✓       ✓      ✓       ✓
//   create / edit           ✓          ✓       ✓      ✓       ✗
//   upload                  ✓          ✓       ✓      ✓       ✗
//   submit                  ✓          ✓       ✓      ✓       ✗
//   review / approve        ✓          ✓       ✓      ✗       ✗
//   delete / archive        ✓          ✓      own    own       ✗
//   export / download       ✓          ✓       ✓      ✓       ✓
//   manage_config           ✓          ✓       ✗      ✗       ✗
//
// "own" = the row's created_by must equal the current user (enforced by RLS).
// Project scope is orthogonal: every capability also requires the user to have
// access to the row's project (admins have all projects; others by assignment
// in users.projects[]). Use Perm.can(profile, action, row) for row-aware checks.
// ============================================================================

(function () {
  var ADMINS   = ['super_admin', 'admin'];
  var PLANNERS = ['super_admin', 'admin', 'planner'];
  var WRITERS  = ['super_admin', 'admin', 'planner', 'user'];   // everyone except viewer

  function role(profile) { return (profile || window.__profile || {}).role || ''; }
  function has(list, profile) { return list.indexOf(role(profile)) !== -1; }

  // Capability table. Each entry answers "may this role do this at all?".
  var CAPS = {
    view:           function (p) { return !!role(p); },
    create:         function (p) { return has(WRITERS, p); },
    edit:           function (p) { return has(WRITERS, p); },
    submit:         function (p) { return has(WRITERS, p); },
    upload:         function (p) { return has(WRITERS, p); },
    review:         function (p) { return has(PLANNERS, p); },
    approve:        function (p) { return has(PLANNERS, p); },
    reject:         function (p) { return has(PLANNERS, p); },
    download:       function (p) { return !!role(p); },
    export:         function (p) { return !!role(p); },
    archive:        function (p) { return has(WRITERS, p); },
    delete:         function (p) { return has(WRITERS, p); },
    manage_config:  function (p) { return has(ADMINS, p); },
    manage_users:   function (p) { return has(ADMINS, p); },
  };

  // Actions that a non-admin may only perform on rows they created. Mirrors the
  // RLS update/delete policy: is_writer() AND (created_by = auth.uid() OR is_admin()).
  var OWN_ONLY = { delete: 1, archive: 1 };

  // can(profile, action, row):
  //   row omitted → "could this role ever do this?" (use for toolbar buttons)
  //   row given   → also checks project access and row ownership
  function can(profile, action, row) {
    profile = profile || window.__profile;
    var fn = CAPS[action];
    if (!fn) return false;                       // unknown action → deny
    if (!profile || profile.status !== 'approved') return false;
    if (!fn(profile)) return false;

    if (row) {
      if (row.project_id && window.AppAuth &&
          !AppAuth.canAccessProject(profile, row.project_id)) return false;
      if (OWN_ONLY[action] && !has(ADMINS, profile) &&
          row.created_by && row.created_by !== profile.id) return false;
    }
    return true;
  }

  // canModule(profile, moduleKey): may this user open the module at all?
  // Today every approved user may view every engineering module (project
  // assignment is what actually scopes their data, exactly as in the Planning
  // App). Per-module role restrictions belong here — add
  // `MODULE_ROLES['rfi'] = PLANNERS` and both the nav and the launcher follow.
  var MODULE_ROLES = {};
  function canModule(profile, key) {
    profile = profile || window.__profile;
    if (!profile || profile.status !== 'approved') return false;
    var allowed = MODULE_ROLES[key];
    return allowed ? allowed.indexOf(role(profile)) !== -1 : true;
  }

  // applyReadonly(rootEl, profile): hides/disables every element tagged with
  // data-perm="<action>" the user lacks. Lets module markup stay declarative:
  //   <button data-perm="approve">Approve</button>
  // data-perm-mode="disable" keeps the control visible but inert (better than
  // hiding when its absence would make a toolbar look broken).
  function applyReadonly(rootEl, profile) {
    (rootEl || document).querySelectorAll('[data-perm]').forEach(function (el) {
      if (can(profile, el.getAttribute('data-perm'))) return;
      if (el.getAttribute('data-perm-mode') === 'disable') {
        el.disabled = true;
        el.title = 'Your role does not permit this action.';
        el.classList.add('pd-perm-denied');
      } else {
        el.style.display = 'none';
      }
    });
  }

  window.Perm = {
    can: can, canModule: canModule, applyReadonly: applyReadonly,
    isAdmin:   function (p) { return has(ADMINS, p); },
    isPlanner: function (p) { return has(PLANNERS, p); },
    isViewer:  function (p) { return role(p) === 'viewer'; },
    ROLES: { ADMINS: ADMINS, PLANNERS: PLANNERS, WRITERS: WRITERS },
  };
})();
