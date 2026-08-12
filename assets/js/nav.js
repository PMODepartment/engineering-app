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

  function link(href, icon, label, sub, active) {
    return '<a href="' + prefix() + href + '"' + (active ? ' class="active"' : '') +
      ' title="' + Fmt.esc(label) + '">' +
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

    html += section('Engineering');
    html += link('projects.html', 'grid', 'Projects', null, active === 'projects');
    // On the Projects page the user is choosing a project, so the previously
    // selected one must not be advertised underneath Dashboard as if it were
    // already in context.
    html += link('dashboard.html', 'home', 'Dashboard',
      active === 'projects' ? null : (pn || 'No project selected'), active === 'dashboard');

    // Engineering modules — config-driven, permission-filtered. A module the
    // user's role cannot open is omitted entirely rather than shown disabled.
    (APP_CONFIG.MODULES || []).forEach(function (m) {
      if (!m.enabled || !Perm.canModule(profile, m.key)) return;
      html += link(m.path, m.icon, m.name, null, active === m.key);
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
