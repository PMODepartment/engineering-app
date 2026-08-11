// ============================================================================
// Planners Dashboard — Shared UI helpers (UI)
// ----------------------------------------------------------------------------
// Toasts, the top user bar, and the shared sidebar shell. Modules call these so
// every screen looks and behaves consistently. Keep this dependency-free.
// ============================================================================

(function () {
  // ---- Toast ----
  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'pd-toast pd-toast-' + (type || 'info');
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 300);
    }, 3000);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- User bar (top-right): clickable avatar → dropdown with Sign out ----
  function renderUserBar(profile, mountId) {
    var mount = document.getElementById(mountId || 'user-bar');
    if (!mount || !profile) return;
    var label = profile.name || profile.email || 'U';
    var initials = label.trim().split(/\s+/).map(function (n) { return n[0]; }).join('').slice(0, 2).toUpperCase();
    mount.innerHTML =
      '<div class="pd-user">' +
        '<button class="pd-avatar" id="pd-avatar-btn" type="button" title="' + esc(label) + '" aria-label="Account menu">' + esc(initials) + '</button>' +
        '<div class="pd-usermenu" id="pd-usermenu">' +
          '<div class="pd-usermenu-head">' +
            '<div class="pd-usermenu-name">' + esc(label) + '</div>' +
            '<div class="pd-usermenu-role">' + esc((profile.role || '').replace(/_/g, ' ')) + '</div>' +
          '</div>' +
          '<button class="pd-usermenu-signout" id="pd-signout" type="button">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>' +
            'Sign out</button>' +
        '</div>' +
      '</div>';
    var btn = document.getElementById('pd-avatar-btn');
    var menu = document.getElementById('pd-usermenu');
    btn.onclick = function (e) { e.stopPropagation(); menu.classList.toggle('open'); };
    document.getElementById('pd-signout').onclick = function () { window.AppAuth.logout(); };
    document.addEventListener('click', function (e) {
      if (!menu.contains(e.target) && !btn.contains(e.target)) menu.classList.remove('open');
    });
  }

  // ---- Modal ----
  function modal(html, opts) {
    opts = opts || {};
    var overlay = document.createElement('div');
    overlay.className = 'pd-modal-overlay';
    overlay.innerHTML = '<div class="pd-modal">' + html + '</div>';
    document.body.appendChild(overlay);
    function close() { overlay.remove(); }
    if (!opts.noBackdropClose) {
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    }
    return { el: overlay, close: close };
  }

  // ---- Project selector (shared OPC folder browser) ------------------------
  // Upgrades a native project <select> into the Project-Schedule-style browser:
  // a FOLDER navigator that drills Workspace → Program → Group one level at a
  // time (scales to 100s of projects), with a breadcrumb and a search box that
  // flattens to matching projects across the whole tree. The <select> stays the
  // source of truth (its value + change events still fire), so existing
  // `sel.onchange` handlers keep working. The tree is built from PDb.getProjects
  // + PDb.getWorkspaces, but FILTERED to the ids present in the select's options
  // — so any module-level access filtering already applied to the options is
  // respected. Safe to call again to refresh. The trigger button copies the
  // select's classes/inline style so each module's per-topbar look carries.
  var _pdProjCache = null, _pdWsCache = null;   // per-page (one load), shared across instances
  function enhanceProjectSelect(sel) {
    if (!sel) return null;
    if (sel.__pdEnhanced) { sel.__pdEnhanced.refresh(); return sel.__pdEnhanced; }

    var wrap = document.createElement('div');
    wrap.className = 'pd-psel';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('pd-psel-native');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = (sel.className.replace('pd-psel-native', '').trim()) + ' pd-psel-btn';
    if (sel.getAttribute('style')) btn.setAttribute('style', sel.getAttribute('style'));
    if (sel.title) btn.title = sel.title;
    wrap.appendChild(btn);

    var pop = document.createElement('div');
    pop.className = 'pd-psel-pop';
    pop.hidden = true;
    wrap.appendChild(pop);

    var path = '', search = '', ws = [], projs = [];

    function labelFor(v) {
      var o = Array.prototype.filter.call(sel.options, function (o) { return o.value === v; })[0];
      return o ? o.textContent : '';
    }
    function syncBtn() {
      var t = labelFor(sel.value), ph = !t;
      var txt = t || (sel.options[0] ? sel.options[0].textContent : 'Select…');
      btn.innerHTML = '<span class="pd-psel-txt' + (ph ? ' pd-psel-ph' : '') + '">' + esc(txt) + '</span>' +
        '<span class="pd-psel-caret" data-ico="chevronDown" data-ico-size="14"></span>';
      if (window.Icons) Icons.hydrate(btn);
    }
    function ico(name, size) { return window.Icons ? Icons.svg(name, size) : ''; }
    function byName(a, b) { return String(a.name || a.id).localeCompare(String(b.name || b.id)); }
    function node(id) { return ws.filter(function (w) { return w.id === id; })[0]; }
    function crumbs(id) { var a = [], c = node(id); while (c) { a.unshift(c); c = c.parent_id ? node(c.parent_id) : null; } return a; }

    function head(pathId, q) {
      var bc = q ? '' : '<div class="pd-pss-crumbs"><span class="pd-pss-crumb" data-crumb="">All</span>' +
        crumbs(pathId).map(function (w) { return '<span class="pd-pss-sep">›</span><span class="pd-pss-crumb" data-crumb="' + esc(w.id) + '">' + esc(w.name) + '</span>'; }).join('') + '</div>';
      return '<div class="pd-pss-search"><input type="text" class="pd-pss-q" placeholder="Search all projects…" value="' + esc(q || search) + '">' + bc + '</div>';
    }
    function render() {
      var ids = {};
      Array.prototype.forEach.call(sel.options, function (o) { if (o.value) ids[o.value] = 1; });
      var P = projs.filter(function (p) { return ids[p.id]; });
      var cm = {}; ws.forEach(function (w) { var k = w.parent_id || ''; (cm[k] = cm[k] || []).push(w); });
      var pm = {}; P.forEach(function (p) { var k = p.workspace_id || ''; (pm[k] = pm[k] || []).push(p); });
      var memo = {};
      function descCount(id) { if (memo[id] != null) return memo[id]; var c = (pm[id] || []).length; (cm[id] || []).forEach(function (w) { c += descCount(w.id); }); return (memo[id] = c); }
      function projRow(p) { return '<div class="pd-pss-proj' + (p.id === sel.value ? ' sel' : '') + '" data-proj="' + esc(p.id) + '">' + ico('project', 14) + '<span>' + esc(p.name || p.id) + '</span></div>'; }
      var q = search.trim().toLowerCase(), body = '';
      if (q) {
        var matches = P.filter(function (p) { return (p.name || '').toLowerCase().indexOf(q) !== -1 || (p.id || '').toLowerCase().indexOf(q) !== -1; }).sort(byName);
        body = matches.length ? matches.map(projRow).join('') : '<div class="pd-pss-empty">No projects match “' + esc(search) + '”.</div>';
        pop.innerHTML = head('', q) + '<div class="pd-pss-tree">' + body + '</div>';
      } else {
        var folders = (cm[path] || []).slice().sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0) || String(a.name).localeCompare(String(b.name)); });
        var pr = (pm[path] || []).slice().sort(byName);
        body += folders.map(function (w) {
          var nt = w.node_type || 'workspace', n = descCount(w.id);
          return '<div class="pd-pss-folder" data-open="' + esc(w.id) + '">' + ico('folder', 15) +
            '<span class="pd-pss-name">' + esc(w.name) + '</span>' +
            '<span class="pd-pss-badge pd-pss-' + nt + '">' + nt + '</span>' +
            '<span class="pd-pss-count" title="' + n + ' project' + (n === 1 ? '' : 's') + '">' + n + '</span>' +
            '<span class="pd-pss-chev">›</span></div>';
        }).join('');
        body += pr.map(projRow).join('');
        if (!body) body = '<div class="pd-pss-empty">This folder is empty.</div>';
        pop.innerHTML = head(path, '') + '<div class="pd-pss-tree">' + body + '</div>';
      }
      var qi = pop.querySelector('.pd-pss-q');
      if (qi) qi.oninput = function () { var pos = qi.selectionStart; search = qi.value; render(); var q2 = pop.querySelector('.pd-pss-q'); if (q2) { q2.focus(); try { q2.setSelectionRange(pos, pos); } catch (e) {} } };
      pop.querySelectorAll('.pd-pss-crumb').forEach(function (c) { c.onclick = function (e) { e.stopPropagation(); path = c.dataset.crumb || ''; render(); }; });
      pop.querySelectorAll('.pd-pss-folder').forEach(function (f) { f.onclick = function (e) { e.stopPropagation(); path = f.dataset.open; render(); }; });
      pop.querySelectorAll('.pd-pss-proj').forEach(function (r) { r.onclick = function (e) { e.stopPropagation(); choose(r.dataset.proj); }; });
      if (window.Icons) Icons.hydrate(pop);
    }
    function choose(v) {
      if (v !== sel.value) { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      syncBtn(); close();
    }
    async function ensureData() {
      if (!_pdProjCache) { try { _pdProjCache = await PDb.getProjects(); } catch (e) { _pdProjCache = []; } }
      if (!_pdWsCache) { try { _pdWsCache = await PDb.getWorkspaces(); } catch (e) { _pdWsCache = []; } }
    }
    async function open() {
      pop.hidden = false; wrap.classList.add('open');
      if (!projs.length) pop.innerHTML = '<div class="pd-pss-empty">Loading…</div>';
      await ensureData(); projs = _pdProjCache || []; ws = _pdWsCache || [];
      search = ''; var cur = projs.filter(function (p) { return p.id === sel.value; })[0];
      path = cur ? (cur.workspace_id || '') : '';
      render();
      var qi = pop.querySelector('.pd-pss-q'); if (qi) setTimeout(function () { qi.focus(); }, 0);
    }
    function close() { pop.hidden = true; wrap.classList.remove('open'); }

    btn.onclick = function (e) { e.stopPropagation(); if (pop.hidden) open(); else close(); };
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !pop.hidden) { close(); btn.focus(); } });
    sel.addEventListener('change', syncBtn);   // stay in sync on programmatic value changes

    var api = { refresh: function () { syncBtn(); if (!pop.hidden) render(); }, close: close };
    sel.__pdEnhanced = api;
    syncBtn();
    return api;
  }

  // ---- Collapsible sidebar / mobile drawer ----
  // Auto-injects a hamburger toggle into the topbar of any shell page (a page
  // with both .pd-sidebar and .pd-topbar).
  //   Desktop (>820px): collapses the sidebar to a slim icon rail (persisted).
  //   Mobile  (≤820px): the sidebar is an off-canvas DRAWER — it slides over the
  //                     content behind a scrim, locks background scroll, and
  //                     dismisses on scrim tap / nav tap / Escape.
  // The 820px breakpoint must stay in sync with the drawer media query in
  // dashboard.css. Mobile state is deliberately NOT persisted: a drawer that
  // reopens itself on every page load would cover the content each time.
  var MOBILE_Q = '(max-width: 820px)';
  function isMobile() { return window.matchMedia(MOBILE_Q).matches; }

  function initShell() {
    var app = document.querySelector('.pd-app');
    var sidebar = document.querySelector('.pd-sidebar');
    var topbar = document.querySelector('.pd-topbar');
    if (!app || !sidebar || !topbar) return;
    // Fill the "Project Home" sub-caption with the current project (if the nav has that slot).
    var np = document.getElementById('nav-proj');
    if (np) { var pn = sessionStorage.getItem('pd_project_name') || sessionStorage.getItem('pd_project'); np.textContent = pn || 'None selected'; }
    if (topbar.querySelector('.pd-sidebar-toggle')) return;

    // Default to collapsed for a clean entry; only an explicit '0' keeps it open.
    // (On mobile the CSS re-expands the drawer — .pd-collapsed must not turn the
    // drawer into a label-less 64px rail.)
    if (localStorage.getItem('pd_sidebar_collapsed') !== '0') app.classList.add('pd-collapsed');

    var scrim = document.querySelector('.pd-scrim');
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.className = 'pd-scrim';
      document.body.appendChild(scrim);
    }

    function openDrawer(on) {
      sidebar.classList.toggle('open', on);
      scrim.classList.toggle('open', on);
      document.body.classList.toggle('pd-noscroll', on);
      btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
    function closeDrawer() { openDrawer(false); }

    var btn = document.createElement('button');
    btn.className = 'pd-sidebar-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Toggle menu');
    btn.setAttribute('aria-controls', sidebar.id || 'pd-sidebar');
    btn.setAttribute('aria-expanded', 'false');
    if (!sidebar.id) sidebar.id = 'pd-sidebar';
    btn.innerHTML = '<span></span><span></span><span></span>';
    btn.onclick = function () {
      if (isMobile()) {
        openDrawer(!sidebar.classList.contains('open'));
      } else {
        app.classList.toggle('pd-collapsed');
        localStorage.setItem('pd_sidebar_collapsed', app.classList.contains('pd-collapsed') ? '1' : '0');
      }
    };
    topbar.insertBefore(btn, topbar.firstChild);

    scrim.addEventListener('click', closeDrawer);
    // Tapping a nav link navigates; close so the drawer isn't left open behind
    // the next page's paint (and for same-page anchors, so content is visible).
    sidebar.addEventListener('click', function (e) {
      if (isMobile() && e.target.closest('a')) closeDrawer();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sidebar.classList.contains('open')) closeDrawer();
    });
    // Rotating a tablet from portrait to landscape can cross the breakpoint with
    // the drawer open — it would otherwise stay "open" as a docked sidebar with
    // the scrim and the body scroll lock still applied.
    window.addEventListener('resize', function () {
      if (!isMobile() && sidebar.classList.contains('open')) closeDrawer();
    });
  }

  // ---- Module topbar: two-row restructure for phones/tablets ----
  // Every module topbar is one flat flex row: back · title · project select ·
  // view tabs · tool cluster · theme toggle · #user-bar. On a phone that wraps
  // into four or five full-width rows and eats the whole screen before any
  // content shows (the tools row, then the avatar alone on its own line).
  //
  // Rather than patch 14 modules, wrap the children ONCE into two groups:
  //   .pd-tb-main  — back button, module icon, <h1>, theme toggle, #user-bar
  //   .pd-tb-tools — everything else (project select, tabs, buttons)
  // Both are `display: contents` by default, so on desktop the topbar is still
  // the exact same flat flex row it always was — the wrappers are invisible to
  // layout. Only below the mobile breakpoint do they become real rows (identity
  // on top, a single horizontally-scrolling strip of controls beneath).
  //
  // Safe because no CSS anywhere targets topbar children with a DIRECT-child
  // combinator (`.pd-topbar > x`) — those would break under display:contents.
  // Every module rule is a descendant selector. Check before adding one.
  function initModuleTopbar() {
    var topbar = document.querySelector('.pd-topbar');
    if (!topbar || topbar.querySelector(':scope > .pd-tb-main')) return;

    var kids = Array.prototype.slice.call(topbar.children);
    if (!kids.length) return;

    var main = document.createElement('div');
    main.className = 'pd-tb-main';
    var tools = document.createElement('div');
    tools.className = 'pd-tb-tools';

    kids.forEach(function (el, i) {
      // The identity cluster: the leading back button / hamburger, the module
      // icon + title, and the account controls that must never scroll away.
      var isLead = i === 0 && (el.tagName === 'A' || el.classList.contains('pd-sidebar-toggle'));
      // Project Schedule's title is a <button> view-switcher, not an <h1>, so
      // match on the class name too — otherwise its title scrolls away with the
      // tools and the identity row is left with just a back arrow and avatar.
      var isTitle = el.tagName === 'H1' || !!el.querySelector('h1') ||
                    /(^|[\s-])[\w-]*title/i.test(el.className || '');
      // The shell pages lead with the Megawide mark instead of a back link.
      var isMark = el.tagName === 'IMG';
      var isAccount = el.id === 'user-bar' || el.id === 'pd-theme-toggle';
      // ⚠️ The project selector stays with the CONTROLS, not the identity row.
      // It was briefly moved up beside the title, but the two cannot share a
      // 375px line: back + icon + title + theme + avatar consume ~295px of it,
      // leaving the selector about 56px — narrow enough to read "Meg…" and
      // nothing else. Below the title it gets the full width instead.
      (isLead || isMark || isTitle || isAccount ? main : tools).appendChild(el);
    });

    topbar.appendChild(main);
    if (tools.children.length) topbar.appendChild(tools);
    // Marks the topbar as restructured. ⚠️ The mobile CSS keys off THIS class,
    // never off `.pd-topbar` alone — the column layout assumes the two wrapper
    // rows exist. Applied to a plain topbar it turns every child into a
    // full-width row and stretches the logo <img> into a giant red bar.
    topbar.classList.add('pd-tb-split');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { initShell(); initModuleTopbar(); });
  } else { initShell(); initModuleTopbar(); }

  window.UI = { toast: toast, renderUserBar: renderUserBar, modal: modal, initShell: initShell,
                enhanceProjectSelect: enhanceProjectSelect, initModuleTopbar: initModuleTopbar };
})();
