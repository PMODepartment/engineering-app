// ============================================================================
// Megawide Engineering App — Shared sidebar navigation (Nav)
// ----------------------------------------------------------------------------
// The Planners Dashboard repeats its sidebar markup in every shell page, so
// adding a module means editing every page. Here the nav is rendered from ONE
// definition instead: APP_CONFIG.MODULES supplies the engineering modules, and
// Perm decides what the current user may see. Adding a future module (RFI,
// Design Review, NCR…) is a one-line config change — the nav follows.
//
// Usage — every page has `<aside class="pd-sidebar" id="nav"></aside>` and calls
// Nav.render(profile, 'drawing-register') from inside AppAuth.requireLogin.
// The `active` argument is a nav key or a module key.
//
// Depth: module pages live at modules/<key>/index.html, so every href is
// prefixed with '../../' when the current path contains /modules/.
// ============================================================================

(function () {
  function prefix() { return /\/modules\//.test(location.pathname) ? '../../' : ''; }

  // `opts.needsProject` marks a project-scoped destination. With no project
  // chosen those pages just bounce straight back to projects.html, so rather
  // than offering a link that silently undoes itself, the item is rendered
  // inert and says why. Projects / Notifications / Administration are NOT
  // project-scoped and are never gated.
  function link(href, icon, label, sub, active, opts) {
    opts = opts || {};
    var cls = (active ? 'active' : '') + (opts.disabled ? ' pd-nav-disabled' : '');
    return '<a href="' + prefix() + (opts.disabled ? 'projects.html' : href) + '"' +
      (cls.trim() ? ' class="' + cls.trim() + '"' : '') +
      (opts.disabled ? ' aria-disabled="true"' : '') +
      ' title="' + Fmt.esc(opts.disabled ? 'Select a project first' : label) + '">' +
      '<span class="pd-navico" data-ico="' + icon + '"></span>' +
      '<span class="pd-navtxt">' + Fmt.esc(label) +
      (sub ? '<small class="pd-nav-sub">' + Fmt.esc(sub) + '</small>' : '') +
      '</span></a>';
  }

  function section(label) { return '<div class="pd-navsec">' + Fmt.esc(label) + '</div>'; }

  function render(profile, active) {
    var el = document.getElementById('nav');
    if (!el) return;
    var pn = sessionStorage.getItem('pd_project_name') || sessionStorage.getItem('pd_project');
    var html = '';

    html += '<div class="pd-brand">' +
      '<img class="pd-brand-logo" src="' + prefix() + 'assets/img/logo-white.png" alt="Megawide Construction">' +
      'Engineering App<small>Engineering Suite</small></div><nav>';

    // Landing on projects.html clears the selection (it IS the selection step),
    // so this is the live answer to "is a project in context?" — not a guess.
    var noProject = !sessionStorage.getItem('pd_project');

    // ⚠⚠ THE SIDEBAR IS SPLIT BY SCOPE, AND THAT SPLIT IS THE POINT.
    // Everything used to sit under one "Engineering" heading: the project list, the
    // project dashboard, five project-scoped registers and two org-wide modules, in
    // one undifferentiated run. Nothing on screen said which items belonged to the
    // project you had chosen and which were department-wide, so the only way to find
    // out was to click and see whether it bounced. Two labelled groups say it up front,
    // and the project group is TITLED WITH THE PROJECT so the scope is named rather
    // than inferred.
    //
    // ⚠️ An org-wide module must appear in the ORGANISATION group and must never be
    // gated — see `orgWide` in config.js. Putting one in the project group would be
    // wrong twice over: it would claim a scope the module does not have, and on a cold
    // start it would sit in a group that is entirely disabled.
    var orgMods = [], projMods = [];
    (APP_CONFIG.MODULES || []).forEach(function (m) {
      // A module the user's role cannot open is omitted entirely rather than
      // shown disabled — an inert row they can never use is just noise.
      if (!m.enabled || !Perm.canModule(profile, m.key)) return;
      (m.orgWide ? orgMods : projMods).push(m);
    });

    html += section('Organisation');
    // Org-wide modules lead, because with nothing selected they are the only things
    // here that actually work — and the app now lands on one of them.
    orgMods.forEach(function (m) {
      html += link(m.path, m.icon, m.name, null, active === m.key);
    });
    html += link('projects.html', 'grid', 'Projects',
      noProject ? null : 'Change the current project', active === 'projects');

    // ⚠️ The heading NAMES the project when there is one. "Project" over a list of
    // registers tells you nothing; "Project — Bauhinia Residences" tells you exactly
    // whose drawings you are about to open, which is the mistake this prevents.
    html += section(noProject ? 'Project — none selected' : 'Project — ' + pn);
    // On the Projects page the user is choosing a project, so the previously
    // selected one must not be advertised underneath Dashboard as if it were
    // already in context.
    html += link('dashboard.html', 'home', 'Dashboard',
      active === 'projects' ? null : (noProject ? 'Select a project first' : null),
      active === 'dashboard', { disabled: noProject });

    // ⚠️ Gating is per-module, NOT blanket — these are the project-scoped ones, so
    // they all gate together. They redirect to projects.html with nothing selected, so
    // offering a link that silently undoes itself reads as broken.
    projMods.forEach(function (m) {
      html += link(m.path, m.icon, m.name, null, active === m.key, { disabled: noProject });
    });

    html += section('System');
    html += link('notifications.html', 'bell', 'Notifications', null, active === 'notifications');
    if (Perm.can(profile, 'manage_config')) {
      html += link('admin.html', 'settings', 'Administration', null, active === 'admin');
    }
    html += '</nav>';

    // Cross-app link back to the Planners Dashboard. The two apps are siblings
    // with separate logins, so this opens in a new tab rather than navigating
    // the current session away.
    if (APP_CONFIG.PLANNING_APP_URL) {
      html += '<div class="pd-nav-foot">' +
        '<a class="pd-nav-sibling" href="' + Fmt.esc(APP_CONFIG.PLANNING_APP_URL) +
        '" target="_blank" rel="noopener" title="Opens Planners Dashboard in a new tab">' +
        '<span class="pd-navico" data-ico="externalLink"></span>' +
        '<span class="pd-navtxt">Planners Dashboard</span></a></div>';
    }

    el.innerHTML = html;
    if (window.Icons) Icons.hydrate(el);
    if (window.UI && UI.initShell) UI.initShell();
  }

  window.Nav = { render: render };
})();
