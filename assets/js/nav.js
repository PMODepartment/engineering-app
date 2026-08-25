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

  // ==========================================================================
  // MODULE SWITCHER \u2014 navigation for the SIDEBAR-LESS module pages
  // --------------------------------------------------------------------------
  // \u26a0\ufe0f Module pages carry no sidebar. That was a deliberate choice (full width for the
  // grids, matching the planning app's schedule), but it left a bare \u2190 arrow as the ONLY
  // way out of a module: to reach another register you went back, then clicked in again.
  // Worse, every one of those arrows pointed at `dashboard.html`, which is PROJECT-SCOPED
  // \u2014 so from an org-wide module with nothing selected the only navigation on the page
  // bounced you to the project selector. From the Portfolio, which is now where signing in
  // lands, the single visible control was a dead end.
  //
  // This renders a switcher into the topbar instead: the current module's name, and a menu
  // of everywhere else. Full width is preserved, because it REPLACES the arrow and the
  // <h1> rather than adding to them.
  //
  // \u26a0\ufe0f IT LIVES IN THIS FILE ON PURPOSE. The grouping (Organisation vs Project), the
  // per-module `orgWide` gating and the permission filter are exactly the sidebar's rules,
  // and this repo has paid repeatedly for the same rule expressed twice. Adding a module to
  // config.js must update both surfaces at once, and it does, because there is one list.
  // ==========================================================================
  function switcher(profile, activeKey) {
    var host = document.getElementById('modsw');
    if (!host) return;
    var pn = sessionStorage.getItem('pd_project_name') || sessionStorage.getItem('pd_project');
    var noProject = !sessionStorage.getItem('pd_project');

    var org = [], proj = [];
    (APP_CONFIG.MODULES || []).forEach(function (m) {
      if (!m.enabled || !Perm.canModule(profile, m.key)) return;
      (m.orgWide ? org : proj).push(m);
    });

    // What the button itself says. An unknown key (a page not in MODULES) still gets a
    // usable label rather than an empty button.
    var cur = (APP_CONFIG.MODULES || []).filter(function (m) { return m.key === activeKey; })[0];
    var curName = cur ? cur.name : (activeKey === 'dashboard' ? 'Dashboard' : 'Engineering App');
    var curIcon = cur ? cur.icon : 'grid';
    var curScope = cur ? (cur.orgWide ? 'Organisation' : (noProject ? 'Project' : pn)) : '';

    function item(href, icon, label, opts) {
      opts = opts || {};
      var dis = !!opts.disabled;
      return '<a class="pd-modsw-i' + (opts.cur ? ' cur' : '') + (dis ? ' dis' : '') + '" ' +
        'href="' + prefix() + (dis ? 'projects.html' : href) + '"' +
        (dis ? ' aria-disabled="true"' : '') +
        ' title="' + Fmt.esc(dis ? 'Select a project first' : label) + '">' +
        '<span class="pd-modsw-ii">' + (window.Icons ? Icons.svg(icon, 16) : '') + '</span>' +
        '<span>' + Fmt.esc(label) + '</span>' +
        (dis ? '<span class="pd-modsw-lock">needs a project</span>' : '') + '</a>';
    }

    var menu = '<div class="pd-modsw-h">Organisation</div>';
    org.forEach(function (m) {
      menu += item(m.path, m.icon, m.name, { cur: m.key === activeKey });
    });
    menu += item('projects.html', 'grid', 'Projects', { cur: activeKey === 'projects' });
    menu += '<div class="pd-modsw-h">' +
      Fmt.esc(noProject ? 'Project \u2014 none selected' : 'Project \u2014 ' + pn) + '</div>';
    menu += item('dashboard.html', 'home', 'Dashboard',
      { cur: activeKey === 'dashboard', disabled: noProject });
    proj.forEach(function (m) {
      menu += item(m.path, m.icon, m.name, { cur: m.key === activeKey, disabled: noProject });
    });

    host.innerHTML =
      // A labelled home, not a bare arrow: it says where it goes, and it goes to the
      // app's actual home rather than to a project-scoped dashboard.
      '<a class="pd-modhome" href="' + prefix() + APP_CONFIG.HOME + '" title="Engineering Portfolio \u2014 the home page">' +
        (window.Icons ? Icons.svg('home', 17) : '') + '</a>' +
      '<div class="pd-modsw">' +
        '<button class="pd-modsw-btn" id="modsw-btn" type="button" aria-haspopup="true" aria-expanded="false">' +
          '<span class="pd-modsw-ic">' + (window.Icons ? Icons.svg(curIcon, 19) : '') + '</span>' +
          '<span class="pd-modsw-t"><strong>' + Fmt.esc(curName) + '</strong>' +
            (curScope ? '<small>' + Fmt.esc(curScope) + '</small>' : '') + '</span>' +
          '<span class="pd-modsw-cv">\u25be</span>' +
        '</button>' +
        '<div class="pd-modsw-menu" id="modsw-menu">' + menu + '</div>' +
      '</div>';

    var btn = document.getElementById('modsw-btn');
    var box = document.getElementById('modsw-menu');
    function close() { box.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
    btn.onclick = function (e) {
      e.stopPropagation();
      var open = box.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    // Clicking anywhere else closes it; Escape does too, so it is not a mouse-only control.
    document.addEventListener('click', function (e) {
      if (!box.classList.contains('open')) return;
      if (!box.contains(e.target) && e.target !== btn) close();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  window.Nav = { render: render, switcher: switcher };
})();
