/* Initiatives — modules/initiatives/module.js

   ⚠️ THIS IS THE ONLY ORG-WIDE MODULE IN THE APP. Every sibling register is
   scoped to one project and redirects to projects.html when none is selected.
   This one does the opposite on purpose: an initiative is a department-level
   programme that MAY carry a project link, so the topbar selector is a FILTER
   over `project_id` (All projects / Not project-linked / a project), not the
   page's context. Three things follow, and each has bitten a sibling module in
   the form it would take here:

     1. ⚠️ NO REDIRECT, EVER. `init()` must not bounce to projects.html when
        `pd_project` is empty — the register is meaningful with no project
        chosen, and bouncing would make the module unreachable from a cold start.
     2. ⚠️ THE SELECTOR IS DELIBERATELY NOT `UI.enhanceProjectSelect`. That
        helper turns a <select> into a group-head browser built from the projects
        table, and it can only ever offer real projects — so "All projects" and
        "Not project-linked" would be selectable once and then unreachable, with
        no way back. A plain <select> is the correct control here.
     3. ⚠️ It still never falls back to `projects[0]`. The stored `pd_project` is
        adopted as the INITIAL filter only when it is a project the user can
        actually access; anything else opens on "All projects" rather than
        silently adopting whichever project sorts first.

   ⚠️ NO SOURCE WORKBOOK — the schema was designed, not transcribed (owner
   confirmed there is no existing tracker). The Overview therefore carries a
   METHOD note rather than a reconciliation note: it states how each figure is
   built so someone holding their own spreadsheet can see where a difference
   would come from.

   ⚠️ TWO NUMBERS ARE DELIBERATELY NOT AGGREGATED THE OBVIOUS WAY:

     progress_pct  is human-entered judgement — there is no task breakdown to
                   roll up from — so it is averaged over IN PROGRESS rows only.
                   Averaging it over everything reports a portfolio of ideas as
                   "34% done", which is meaningless.
     benefit_value is peso-denominated and only meaningful when benefit_type is
                   'Cost'. `costBenefit()` sums ONLY those rows; adding a peso
                   figure attached to a SAFETY initiative into the same total is
                   a category error, and the form only offers the field for Cost. */
window.Initiatives = (function () {
  'use strict';

  var TABLE = 'initiatives';
  var sb = function () { return window.__sb || (window.__sb = supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY)); };
  var esc = function (s) { return Fmt.esc(s == null ? '' : String(s)); };
  function ico(name, size) { return (window.Icons && Icons.svg) ? Icons.svg(name, size || 15) : ''; }

  // `active` = being worked on now; `closed` = finished with, either way.
  // A status belongs to at most one bucket, which is what stops a row being
  // counted twice in the KPI row.
  var STATUSES = [
    { name: 'Idea',        cls: 'in-s-idea' },
    { name: 'Planned',     cls: 'in-s-plan' },
    { name: 'In Progress', cls: 'in-s-prog', active: true },
    { name: 'On Hold',     cls: 'in-s-hold' },
    { name: 'Completed',   cls: 'in-s-done', closed: true, done: true },
    { name: 'Cancelled',   cls: 'in-s-canc', closed: true }
  ];
  var STATUS_ORDER = STATUSES.map(function (s) { return s.name; });

  var CATEGORIES = ['Process Improvement', 'Digitalisation', 'Cost Optimisation', 'Quality',
    'Safety', 'Sustainability', 'Capability & Training', 'Standardisation'];
  var BENEFITS = ['Cost', 'Time', 'Quality', 'Safety', 'Compliance', 'Capability'];

  // ⚠️ The filter's two non-project sentinels. They are not project ids and must
  // never be written to a row — `patch.project_id` is separate from this.
  var ALL = '', NOPROJ = '__none__';

  var UID = null, rows = [], canWrite = false, isAdmin = false;
  var view = 'overview', projects = [], projName = {};
  var filters = { q: '', project: ALL, category: '', status: '', department: '', hideClosed: false };

  // ---- helpers -------------------------------------------------------------
  var MNAME = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function fmtDate(s) {
    if (!s) return '';
    var p = String(s).slice(0, 10).split('-');
    if (p.length !== 3 || isNaN(+p[0])) return esc(s);
    return String(+p[2]).padStart(2, '0') + '-' + MNAME[+p[1] - 1] + '-' + String(p[0]).slice(2);
  }
  // ⚠️ LOCAL getters here, and that is correct — this reads the wall clock, not a
  // spreadsheet cell. The importer's rule (never local getters) applies to values
  // SheetJS returns as UTC instants; `toISOString()` on today's date would put
  // Manila a day behind for its first eight hours and under-report overdue.
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }
  function num(v) { return (v === null || v === undefined || v === '' || isNaN(+v)) ? null : +v; }
  function statusOf(r) { return (r.status || '').trim(); }
  function statusMeta(n) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].name === n) return STATUSES[i];
    return null;
  }
  function isClosed(r) { var m = statusMeta(statusOf(r)); return !!(m && m.closed); }
  function isActive(r) { var m = statusMeta(statusOf(r)); return !!(m && m.active); }
  // Overdue = a target date in the past on something not yet closed. A closed
  // initiative cannot be overdue however late it finished — that is history, and
  // `completed_date` records it.
  function isOverdue(r) {
    if (isClosed(r) || !r.target_date) return false;
    return String(r.target_date).slice(0, 10) < todayISO();
  }
  function progressOf(r) {
    var p = num(r.progress_pct);
    if (p == null) return statusOf(r) === 'Completed' ? 100 : null;
    return Math.max(0, Math.min(100, p));
  }

  // ==========================================================================
  // Overview maths
  // ==========================================================================
  function stats(list) {
    var s = { count: 0, active: 0, closed: 0, done: 0, cancelled: 0, overdue: 0,
      costBenefit: 0, costRows: 0, progSum: 0, progN: 0, unlinked: 0 };
    list.forEach(function (r) {
      s.count++;
      if (isActive(r)) s.active++;
      if (isClosed(r)) s.closed++;
      if (statusOf(r) === 'Completed') s.done++;
      if (statusOf(r) === 'Cancelled') s.cancelled++;
      if (isOverdue(r)) s.overdue++;
      if (!r.project_id) s.unlinked++;
      // ⚠️ Cost benefit ONLY from Cost-type initiatives. See the header note.
      if ((r.benefit_type || '') === 'Cost') {
        var v = num(r.benefit_value);
        if (v != null) { s.costBenefit += v; s.costRows++; }
      }
      // ⚠️ Progress averaged over IN PROGRESS rows only.
      if (isActive(r)) {
        var p = progressOf(r);
        if (p != null) { s.progSum += p; s.progN++; }
      }
    });
    s.avgProgress = s.progN ? s.progSum / s.progN : null;
    s.completionRate = (s.done + s.cancelled) ? s.done / (s.done + s.cancelled) : null;
    return s;
  }

  function groupBy(list, key) {
    var m = {}, order = [];
    list.forEach(function (r) {
      var k = (r[key] || '').trim() || '(unspecified)';
      if (!m[k]) { m[k] = []; order.push(k); }
      m[k].push(r);
    });
    return order.sort().map(function (k) { return { key: k, rows: m[k], st: stats(m[k]) }; });
  }

  // The project filter, applied before anything else — every Overview figure is
  // computed over THIS list so the two tabs can never disagree.
  function scoped() {
    if (filters.project === ALL) return rows;
    if (filters.project === NOPROJ) return rows.filter(function (r) { return !r.project_id; });
    return rows.filter(function (r) { return r.project_id === filters.project; });
  }

  // ==========================================================================
  // Load
  // ==========================================================================
  async function load() {
    var host = document.getElementById('in-view');
    host.innerHTML = skeletonHTML();
    // ⚠️ NO `.eq('project_id', …)` — this table is org-wide and RLS already
    // limits the rows to what the user may see (unattached, plus attached to
    // projects they can access). The project filter is applied client-side.
    // Keyset-paginated: PostgREST caps a select at 1000 rows and returns NO error.
    var out = [], last = null;
    try {
      for (var i = 0; i < 40; i++) {
        var q = sb().from(TABLE).select('*').order('id').limit(1000);
        if (last) q = q.gt('id', last);
        var res = await q;
        if (res.error) throw res.error;
        var batch = res.data || [];
        out = out.concat(batch);
        if (batch.length < 1000) break;
        last = batch[batch.length - 1].id;
      }
    } catch (e) {
      host.innerHTML = '<div class="pd-card in-empty"><h3>Could not load initiatives</h3><p>' +
        esc(e.message || e) + '</p><p class="in-mut">If the table is missing, run ' +
        '<code>migrations/0015-initiatives.sql</code>.</p></div>';
      return;
    }
    // ⚠️ Paginate by `id`, sort for DISPLAY afterwards — sort_order is nullable
    // and non-unique, so it cannot drive a keyset cursor.
    rows = out.sort(function (a, b) {
      var sa = a.sort_order == null ? 1e9 : a.sort_order, sbb = b.sort_order == null ? 1e9 : b.sort_order;
      if (sa !== sbb) return sa - sbb;
      return String(a.init_no || '').localeCompare(String(b.init_no || ''), undefined, { numeric: true });
    });
    syncFilterOptions();
    render();
  }

  function skeletonHTML() {
    var out = '';
    for (var i = 0; i < 8; i++) {
      out += '<div class="in-sk-row"><span class="in-sk" style="width:10%"></span>' +
        '<span class="in-sk" style="width:44%"></span><span class="in-sk" style="width:16%"></span>' +
        '<span class="in-sk" style="width:12%"></span></div>';
    }
    return '<div class="pd-card in-skcard" aria-busy="true">' +
      '<div class="in-sk-head"><span class="in-spin"></span>Loading initiatives…</div>' + out + '</div>';
  }

  // ==========================================================================
  // Render
  // ==========================================================================
  function render() {
    document.getElementById('in-filters').style.display = view === 'registry' ? '' : 'none';
    document.body.classList.toggle('in-fit', view === 'registry');
    if (view === 'overview') renderOverview(); else renderRegistry();
    syncClearFilt();
  }

  function kpi(val, label, sub, tone) {
    return '<div class="pd-card in-kpi' + (tone ? ' ' + tone : '') + '">' +
      '<div class="in-kpi-val">' + esc(val) + '</div>' +
      '<div class="in-kpi-lbl">' + esc(label) + '</div>' +
      (sub ? '<div class="in-kpi-sub">' + esc(sub) + '</div>' : '') + '</div>';
  }
  function pct(n) { return (n * 100).toFixed(0) + '%'; }
  function bar(p) {
    return '<span class="in-bar" title="' + (p == null ? 'no progress recorded' : p + '%') + '">' +
      '<span class="in-bar-fill" style="width:' + (p == null ? 0 : p) + '%"></span></span>' +
      '<span class="in-bar-txt">' + (p == null ? '—' : p + '%') + '</span>';
  }

  function renderOverview() {
    var host = document.getElementById('in-view');
    if (!rows.length) { host.innerHTML = emptyHTML(); wireEmpty(); return; }
    var list = scoped(), T = stats(list);
    if (!list.length) {
      host.innerHTML = '<div class="pd-card in-empty"><h3>No initiatives in this view</h3>' +
        '<p>Nothing matches the current project filter. Switch it back to ' +
        '<strong>All projects</strong> to see everything.</p></div>';
      return;
    }

    var h = '<div class="in-kpis">' +
      kpi(T.count, 'Initiatives', T.unlinked + ' not project-linked') +
      kpi(T.active, 'In progress', T.avgProgress == null ? 'no progress recorded'
        : Math.round(T.avgProgress) + '% average progress') +
      kpi(T.done, 'Completed', T.completionRate == null ? 'none closed yet'
        : pct(T.completionRate) + ' of closed items', 'good') +
      kpi(T.overdue, 'Overdue', 'past target and still open', T.overdue ? 'bad' : '') +
      kpi(Fmt.moneyShort(T.costBenefit), 'Cost benefit', T.costRows + ' cost-type initiative' + (T.costRows === 1 ? '' : 's')) +
      kpi(T.cancelled, 'Cancelled', 'closed without delivering', T.cancelled ? 'warn' : '') +
      '</div>';

    // ---- by status / by category ----
    h += '<div class="in-grid2">';
    h += '<div class="pd-card in-panel"><h3>By status</h3><table class="in-mini"><tbody>';
    STATUS_ORDER.forEach(function (name) {
      var sub = list.filter(function (r) { return statusOf(r) === name; });
      var meta = statusMeta(name);
      h += '<tr' + (sub.length ? ' class="in-drill" data-status="' + esc(name) + '"' : '') + '>' +
        '<td><span class="in-pill ' + meta.cls + '">' + esc(name) + '</span></td>' +
        '<td class="in-r in-b">' + sub.length + '</td>' +
        '<td class="in-r in-mut">' + (list.length ? Math.round(sub.length / list.length * 100) + '%' : '—') + '</td></tr>';
    });
    var noStatus = list.filter(function (r) { return !statusOf(r); }).length;
    if (noStatus) {
      h += '<tr><td><span class="in-mut">(no status)</span></td>' +
        '<td class="in-r in-b">' + noStatus + '</td><td class="in-r in-mut">—</td></tr>';
    }
    h += '</tbody></table></div>';

    h += '<div class="pd-card in-panel"><h3>By category</h3><table class="in-mini"><tbody>';
    var byCat = groupBy(list, 'category');
    byCat.forEach(function (g) {
      h += '<tr class="in-drill" data-category="' + esc(g.key) + '">' +
        '<td>' + esc(g.key) + '</td>' +
        '<td class="in-r in-b">' + g.st.count + '</td>' +
        '<td class="in-r in-mut">' + g.st.active + ' active</td></tr>';
    });
    h += '</tbody></table></div></div>';

    // ---- by department ----
    h += '<div class="pd-card in-tablecard"><table class="in-sumtable"><thead><tr>' +
      '<th>Department</th><th class="in-r">Initiatives</th><th class="in-r">In progress</th>' +
      '<th class="in-r">Completed</th><th class="in-r">Cancelled</th><th class="in-r">Overdue</th>' +
      '<th class="in-r">Avg progress</th><th class="in-r">Cost benefit</th></tr></thead><tbody>';
    var byDept = groupBy(list, 'department');
    byDept.forEach(function (g) {
      h += '<tr class="in-sumrow" data-dept="' + esc(g.key) + '">' +
        '<td class="in-b">' + esc(g.key) + '</td>' +
        '<td class="in-r in-b">' + g.st.count + '</td>' +
        '<td class="in-r">' + g.st.active + '</td>' +
        '<td class="in-r">' + g.st.done + '</td>' +
        '<td class="in-r">' + g.st.cancelled + '</td>' +
        '<td class="in-r' + (g.st.overdue ? ' in-neg' : '') + '">' + g.st.overdue + '</td>' +
        '<td class="in-r in-mut">' + (g.st.avgProgress == null ? '—' : Math.round(g.st.avgProgress) + '%') + '</td>' +
        '<td class="in-r">' + (g.st.costRows ? esc(Fmt.moneyShort(g.st.costBenefit)) : '<span class="in-mut">—</span>') + '</td></tr>';
    });
    h += '<tr class="in-sumtotal"><td>TOTAL</td><td class="in-r">' + T.count + '</td>' +
      '<td class="in-r">' + T.active + '</td><td class="in-r">' + T.done + '</td>' +
      '<td class="in-r">' + T.cancelled + '</td><td class="in-r">' + T.overdue + '</td>' +
      '<td class="in-r">' + (T.avgProgress == null ? '—' : Math.round(T.avgProgress) + '%') + '</td>' +
      '<td class="in-r">' + esc(Fmt.moneyShort(T.costBenefit)) + '</td></tr>';
    h += '</tbody></table></div>';

    h += methodNoteHTML(T, list);
    host.innerHTML = h;
    if (window.Icons && Icons.hydrate) Icons.hydrate(host);
    host.querySelectorAll('.in-sumrow').forEach(function (tr) {
      tr.onclick = function () { drillTo('department', tr.dataset.dept); };
    });
    host.querySelectorAll('.in-drill').forEach(function (tr) {
      tr.onclick = function () {
        if (tr.dataset.status != null) drillTo('status', tr.dataset.status);
        else drillTo('category', tr.dataset.category);
      };
    });
  }

  function methodNoteHTML(T, list) {
    var notes = [
      '<li><strong>Average progress covers In Progress items only.</strong> ' +
        '<code>progress_pct</code> is entered by hand — there is no task breakdown beneath an ' +
        'initiative to roll up from — so averaging it across ideas and cancelled work would ' +
        'report a number that means nothing. ' +
        (T.progN ? T.progN + ' of ' + T.active + ' in-progress item' + (T.active === 1 ? '' : 's') +
          ' carr' + (T.progN === 1 ? 'ies' : 'y') + ' a figure.' : 'No in-progress item carries one yet.') + '</li>',
      '<li><strong>Cost benefit sums only Cost-type initiatives.</strong> ' +
        'A peso value attached to a Safety or Capability initiative is a different kind of number ' +
        'and is never added in — ' + T.costRows + ' of ' + T.count + ' item' + (T.count === 1 ? '' : 's') +
        ' contribute' + (T.costRows === 1 ? 's' : '') + ' to the total.</li>',
      '<li><strong>Overdue means past target and still open.</strong> A completed or cancelled ' +
        'initiative is never overdue however late it closed; <code>completed_date</code> is what ' +
        'records that.</li>'
    ];
    if (T.unlinked !== list.length && T.unlinked) {
      notes.push('<li><strong>This register spans projects.</strong> ' + T.unlinked +
        ' of ' + list.length + ' initiatives carry no project link and are visible to every ' +
        'approved user; the rest are visible only to people who can access the project they ' +
        'are pinned to.</li>');
    }
    return '<div class="pd-card in-note"><div class="in-note-hd">' + ico('bulb', 15) +
      ' How these figures are built</div><ul>' + notes.join('') + '</ul></div>';
  }

  // ⚠️ A drill whose destination count cannot match the number just clicked is
  // worse than no drill at all, so each one clears the OTHER filters — but it
  // KEEPS the project filter, because every Overview figure was already computed
  // over that scope. Clearing it here would land on a bigger number than the one
  // clicked, which is the exact failure the rule exists to prevent.
  function drillTo(kind, value) {
    var keepProject = filters.project;
    filters = { q: '', project: keepProject, category: '', status: '', department: '', hideClosed: false };
    if (kind === 'status') filters.status = value;
    else if (kind === 'category') filters.category = value === '(unspecified)' ? '' : value;
    else filters.department = value === '(unspecified)' ? '' : value;
    var q = document.getElementById('in-f-search'); if (q) q.value = '';
    setSel('in-f-status', filters.status);
    setSel('in-f-category', filters.category);
    setSel('in-f-department', filters.department);
    document.getElementById('in-f-hideclosed').checked = false;
    switchTab('registry');
  }
  // ⚠️ A <select> silently ignores a value none of its options carry, so the
  // filter would apply while the control still read "All statuses".
  function setSel(id, v) {
    var s = document.getElementById(id);
    if (!s) return;
    if (v && !Array.prototype.some.call(s.options, function (o) { return o.value === v; })) {
      s.insertAdjacentHTML('beforeend', '<option value="' + esc(v) + '">' + esc(v) + '</option>');
    }
    s.value = v || '';
  }

  // ---- Registry ------------------------------------------------------------
  function matches(r) {
    if (filters.hideClosed && isClosed(r)) return false;
    if (filters.category && (r.category || '') !== filters.category) return false;
    if (filters.status && statusOf(r) !== filters.status) return false;
    if (filters.department && (r.department || '') !== filters.department) return false;
    if (filters.q) {
      var hay = [r.init_no, r.title, r.description, r.category, r.department,
        r.owner_name, r.sponsor, r.kpi_metric, r.benefit_note, r.remarks]
        .filter(Boolean).join(' ').toLowerCase();
      if (hay.indexOf(filters.q.toLowerCase()) === -1) return false;
    }
    return true;
  }
  function anyFilter() {
    return !!(filters.q || filters.category || filters.status || filters.department ||
      filters.hideClosed || filters.project !== ALL);
  }

  // ⚠️ HEAD is the SINGLE SOURCE OF TRUTH for the column count — the empty state
  // spans it. A hardcoded number skews the table the moment a column is added.
  function headCells() {
    var H = ['<th class="in-fz1">No.</th>', '<th class="in-fz2">Initiative</th>',
      '<th>Category</th>', '<th>Department</th>', '<th>Owner</th>', '<th>Project</th>',
      '<th>Status</th>', '<th class="in-progcol">Progress</th>', '<th class="in-r">Pri</th>',
      '<th>Start</th>', '<th>Target</th>', '<th>Completed</th>',
      '<th>Benefit</th>', '<th class="in-r">Value</th>', '<th>KPI</th>',
      '<th class="in-doccol">Ref</th>'];
    if (canWrite) H.push('<th class="in-actcol"></th>');
    return H;
  }

  function renderRegistry() {
    var host = document.getElementById('in-view');
    if (!rows.length) { host.innerHTML = emptyHTML(); wireEmpty(); return; }
    var pool = scoped();
    var shown = pool.filter(matches);
    document.getElementById('in-count').textContent =
      'Showing ' + shown.length + ' of ' + pool.length +
      (pool.length === rows.length ? '' : ' (' + rows.length + ' in all projects)');

    var HEAD = headCells(), SPAN = HEAD.length;
    var h = '<div class="pd-card in-tablecard"><table class="in-table"><thead><tr>' +
      HEAD.join('') + '</tr></thead><tbody>';
    if (!shown.length) {
      h += '<tr><td colspan="' + SPAN + '" style="text-align:center;padding:34px;" class="in-mut">' +
        'No initiatives match these filters.</td></tr>';
    }
    shown.forEach(function (r) {
      var s = statusOf(r), meta = statusMeta(s), p = progressOf(r);
      var over = isOverdue(r);
      h += '<tr data-id="' + esc(r.id) + '"' + (isClosed(r) ? ' class="in-closed"' : '') + '>' +
        '<td class="in-fz1"><span class="in-code">' + esc(r.init_no || '—') + '</span></td>' +
        '<td class="in-fz2"><div class="in-item">' + esc(r.title || '(untitled)') + '</div>' +
          (r.description ? '<div class="in-sub">' + esc(String(r.description).slice(0, 120)) +
            (String(r.description).length > 120 ? '…' : '') + '</div>' : '') + '</td>' +
        '<td class="in-nowrap">' + esc(r.category || '') + '</td>' +
        '<td class="in-nowrap">' + esc(r.department || '') + '</td>' +
        '<td class="in-nowrap">' + esc(r.owner_name || '') + '</td>' +
        // ⚠️ The project NAME is resolved from the projects table, never stored
        // on the row — projects are read-only here and renamed upstream.
        '<td class="in-nowrap">' + (r.project_id
          ? '<span class="in-projtag" title="' + esc(r.project_id) + '">' +
            esc(projName[r.project_id] || r.project_id) + '</span>'
          : '<span class="in-mut in-orgtag">org-wide</span>') + '</td>' +
        '<td>' + (s ? '<span class="in-pill ' + (meta ? meta.cls : 'in-s-idea') + '">' + esc(s) + '</span>'
          : '<span class="in-mut">—</span>') + '</td>' +
        '<td class="in-progcol">' + bar(p) + '</td>' +
        '<td class="in-r">' + (r.priority ? '<span class="in-pri in-pri-' + r.priority + '">' + r.priority + '</span>' : '') + '</td>' +
        '<td class="in-nowrap in-mut">' + fmtDate(r.start_date) + '</td>' +
        '<td class="in-nowrap' + (over ? ' in-neg in-b' : ' in-mut') + '"' +
          (over ? ' title="Past target and still open"' : '') + '>' + fmtDate(r.target_date) + '</td>' +
        '<td class="in-nowrap in-mut">' + fmtDate(r.completed_date) + '</td>' +
        '<td class="in-nowrap">' + (r.benefit_type
          ? '<span class="in-btype">' + esc(r.benefit_type) + '</span>' : '<span class="in-mut">—</span>') + '</td>' +
        // ⚠️ Value is shown ONLY for Cost-type rows, matching what the totals do.
        // Printing a peso figure beside a Safety benefit would invite someone to
        // add up a column the module deliberately refuses to add up.
        '<td class="in-r">' + ((r.benefit_type === 'Cost' && num(r.benefit_value) != null)
          ? esc(Fmt.moneyShort(num(r.benefit_value))) : '<span class="in-mut">—</span>') + '</td>' +
        '<td class="in-nowrap in-kpicell" title="' + esc(kpiTitle(r)) + '">' + esc(r.kpi_metric || '') + '</td>' +
        '<td class="in-doccol">' + (r.reference_link
          ? '<a class="in-filebtn" href="' + esc(r.reference_link) + '" target="_blank" rel="noopener" title="Open the reference">' + ico('link', 14) + '</a>'
          : '<span class="in-mut">—</span>') + '</td>' +
        (canWrite ? '<td class="in-actcol"><button class="pd-btn in-iconbtn" data-edit="' + esc(r.id) + '" title="Edit">' + ico('pencil', 15) + '</button> ' +
          '<button class="pd-btn in-iconbtn in-iconbtn-del" data-del="' + esc(r.id) + '" title="Delete">' + ico('trash', 15) + '</button></td>' : '') +
        '</tr>';
    });
    h += '</tbody></table></div>';
    host.innerHTML = h;
    if (window.Icons && Icons.hydrate) Icons.hydrate(host);
    host.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); openForm(rows.find(function (r) { return String(r.id) === b.dataset.edit; })); };
    });
    host.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); delRow(b.dataset.del); };
    });
    host.querySelectorAll('.in-filebtn').forEach(function (a) { a.onclick = function (e) { e.stopPropagation(); }; });
  }

  function kpiTitle(r) {
    if (!r.kpi_metric) return '';
    var b = num(r.kpi_baseline), t = num(r.kpi_target), c = num(r.kpi_current);
    var bits = [];
    if (b != null) bits.push('baseline ' + b);
    if (c != null) bits.push('now ' + c);
    if (t != null) bits.push('target ' + t);
    return r.kpi_metric + (bits.length ? ' — ' + bits.join(', ') : '');
  }

  function emptyHTML() {
    return '<div class="pd-card in-empty"><h3>No initiatives yet</h3>' +
      '<p>Initiatives are department-level programmes — a new standard, a tool, a training ' +
      'push. They do not need a project, and the ones that have no project link are visible ' +
      'to everyone. Add one, or import an existing tracker.</p>' +
      (canWrite ? '<p style="margin-top:14px;"><button class="pd-btn pd-btn-primary" id="in-e-add">Add an initiative</button> ' +
        '<button class="pd-btn" id="in-e-imp">Import from Excel</button></p>' : '') + '</div>';
  }
  function wireEmpty() {
    var a = document.getElementById('in-e-add'); if (a) a.onclick = function () { openForm(null); };
    var b = document.getElementById('in-e-imp'); if (b) b.onclick = function () { document.getElementById('in-file').click(); };
  }

  // ==========================================================================
  // CRUD
  // ==========================================================================
  function openForm(r) {
    if (!canWrite) return;
    r = r || {};
    var isNew = !r.id;
    function fld(label, inner, hint) {
      return '<label class="in-fld"><span>' + esc(label) + '</span>' + inner +
        (hint ? '<small>' + esc(hint) + '</small>' : '') + '</label>';
    }
    function txt(k, v, type, step) {
      return '<input class="pd-input" data-k="' + k + '" type="' + (type || 'text') + '"' +
        (step ? ' step="' + step + '"' : '') + ' value="' + esc(v == null ? '' : v) + '" />';
    }
    function sel(k, list, cur, blank) {
      return '<select class="pd-select" data-k="' + k + '">' +
        (blank ? '<option value="">' + esc(blank === true ? '—' : blank) + '</option>' : '') +
        list.map(function (o) {
          var val = Array.isArray(o) ? o[0] : o, lab = Array.isArray(o) ? o[1] : o;
          return '<option value="' + esc(val) + '"' + (String(cur || '') === String(val) ? ' selected' : '') + '>' + esc(lab) + '</option>';
        }).join('') + '</select>';
    }
    // ⚠️ The project field OFFERS a blank, and blank is the norm. Only projects
    // the user can access are listed — RLS refuses an insert against any other,
    // so offering them would produce a save that fails for no visible reason.
    var projOpts = projects.map(function (p) { return [p.id, p.name || p.id]; });

    var m = UI.modal(
      '<div class="pd-modal-header"><h2 style="margin:0;">' + (isNew ? 'Add' : 'Edit') + ' initiative</h2>' +
        '<button class="pd-btn" id="in-x">&times;</button></div>' +
      '<div class="in-form">' +
        fld('No.', txt('init_no', r.init_no)) +
        fld('Category', sel('category', CATEGORIES, r.category, true)) +
        fld('Department', txt('department', r.department)) +
        '<label class="in-fld in-fld-wide"><span>Title</span>' +
          '<input class="pd-input" data-k="title" value="' + esc(r.title || '') + '" /></label>' +
        '<label class="in-fld in-fld-wide"><span>Description</span>' +
          '<textarea class="pd-input" data-k="description" rows="3">' + esc(r.description || '') + '</textarea></label>' +
        '<div class="in-fld in-fld-wide">' +
          '<span>Project (optional)</span>' +
          sel('project_id', projOpts, r.project_id, '— none: org-wide —') +
          '<small>Leave blank for a company-wide initiative. Attaching a project ' +
          'restricts who can see it to people with access to that project.</small></div>' +

        '<div class="in-fld in-fld-wide in-sectlbl">Delivery</div>' +
        fld('Status', sel('status', STATUS_ORDER, statusOf(r), true)) +
        fld('Progress (%)', txt('progress_pct', r.progress_pct, 'number', '1'), 'your own judgement — nothing rolls this up') +
        fld('Priority', sel('priority', [1, 2, 3], r.priority, true)) +
        fld('Owner', txt('owner_name', r.owner_name), 'accountable for delivery') +
        fld('Sponsor', txt('sponsor', r.sponsor)) +
        fld('Start date', txt('start_date', (r.start_date || '').slice(0, 10), 'date')) +
        fld('Target date', txt('target_date', (r.target_date || '').slice(0, 10), 'date')) +
        fld('Completed date', txt('completed_date', (r.completed_date || '').slice(0, 10), 'date')) +

        '<div class="in-fld in-fld-wide in-sectlbl">Benefit</div>' +
        fld('Benefit type', sel('benefit_type', BENEFITS, r.benefit_type, true)) +
        fld('Value (₱)', txt('benefit_value', r.benefit_value, 'number', '0.01'),
            'Cost-type initiatives only — nothing else is totalled') +
        '<label class="in-fld in-fld-wide"><span>What "better" looks like</span>' +
          '<input class="pd-input" data-k="benefit_note" value="' + esc(r.benefit_note || '') + '" /></label>' +

        '<div class="in-fld in-fld-wide in-sectlbl">The one number that says whether it worked</div>' +
        '<label class="in-fld in-fld-wide"><span>KPI</span>' +
          '<input class="pd-input" data-k="kpi_metric" value="' + esc(r.kpi_metric || '') +
          '" placeholder="e.g. days from RFI raised to answered" /></label>' +
        fld('Baseline', txt('kpi_baseline', r.kpi_baseline, 'number', 'any')) +
        fld('Current', txt('kpi_current', r.kpi_current, 'number', 'any')) +
        fld('Target', txt('kpi_target', r.kpi_target, 'number', 'any')) +

        '<label class="in-fld in-fld-wide"><span>Reference link</span>' +
          '<input class="pd-input" data-k="reference_link" value="' + esc(r.reference_link || '') + '" /></label>' +
        '<label class="in-fld in-fld-wide"><span>Remarks</span>' +
          '<input class="pd-input" data-k="remarks" value="' + esc(r.remarks || '') + '" /></label>' +
      '</div>' +
      '<div class="pd-modal-actions"><button class="pd-btn" id="in-cancel">Cancel</button>' +
        '<button class="pd-btn pd-btn-primary" id="in-save">Save</button></div>', { noBackdropClose: true });

    // The value field is only meaningful for a Cost benefit, so it says so
    // rather than silently contributing nothing to the total.
    var btSel = m.el.querySelector('[data-k="benefit_type"]');
    var bvFld = m.el.querySelector('[data-k="benefit_value"]').closest('.in-fld');
    function syncBenefit() {
      var isCost = btSel.value === 'Cost';
      bvFld.classList.toggle('in-fld-dim', !isCost);
      bvFld.querySelector('small').textContent = isCost
        ? 'counted in the Cost benefit total'
        : 'not totalled — only Cost-type initiatives are';
    }
    btSel.addEventListener('change', syncBenefit);
    syncBenefit();

    m.el.querySelector('#in-x').onclick = m.close;
    m.el.querySelector('#in-cancel').onclick = m.close;
    m.el.querySelector('#in-save').onclick = async function () {
      var patch = {};
      m.el.querySelectorAll('[data-k]').forEach(function (el) {
        patch[el.dataset.k] = el.value === '' ? null : el.value;
      });
      ['benefit_value', 'kpi_baseline', 'kpi_target', 'kpi_current'].forEach(function (k) {
        patch[k] = patch[k] == null ? null : num(patch[k]);
      });
      ['priority', 'progress_pct'].forEach(function (k) {
        patch[k] = patch[k] == null ? null : parseInt(patch[k], 10);
        if (isNaN(patch[k])) patch[k] = null;
      });
      if (!patch.title) { UI.toast('A title is required.', 'error'); return; }
      // ⚠️ The DB constrains progress_pct to 0-100 and would reject 150 with a
      // raw check-constraint error. Clamp here so the message is ours.
      if (patch.progress_pct != null) patch.progress_pct = Math.max(0, Math.min(100, patch.progress_pct));
      try {
        if (isNew) {
          patch.created_by = UID;
          var ins = await sb().from(TABLE).insert(patch).select().single();
          if (ins.error) throw ins.error;
          rows.push(ins.data);
        } else {
          var up = await sb().from(TABLE).update(patch).eq('id', r.id);
          if (up.error) throw up.error;
          Object.assign(r, patch);
        }
        m.close(); syncFilterOptions(); render();
        UI.toast(isNew ? 'Initiative added.' : 'Saved.');
      } catch (e) {
        var msg = String(e.message || e);
        // The RLS insert/update check refuses a project the user cannot access.
        if (/row-level security|42501/.test(msg) && patch.project_id) {
          UI.toast('You do not have access to that project, so the initiative cannot be attached to it.', 'error');
        } else UI.toast('Save failed: ' + msg, 'error');
      }
    };
  }

  async function delRow(id) {
    var r = rows.find(function (x) { return String(x.id) === String(id); });
    if (!r) return;
    if (!confirm('Delete "' + (r.title || r.init_no || 'this initiative') + '"?')) return;
    try {
      var res = await sb().from(TABLE).delete().eq('id', id);
      if (res.error) throw res.error;
      rows = rows.filter(function (x) { return String(x.id) !== String(id); });
      render(); UI.toast('Deleted.');
    } catch (e) { UI.toast('Delete failed: ' + (e.message || e), 'error'); }
  }

  // ⚠️ "Clear" here is NOT the sibling registers' "clear this project's rows".
  // The table is org-wide, so the destructive scope depends on the current
  // filter, and a button that silently means "everything in the company" is a
  // trap. It clears exactly what the project filter selects, names that scope in
  // the dialog, and requires it to be typed back.
  async function clearAll() {
    if (!isAdmin) return;
    var list = scoped();
    var scope = filters.project === ALL ? 'ALL' :
      filters.project === NOPROJ ? 'ORG-WIDE' : filters.project;
    var label = filters.project === ALL ? 'every initiative you can see, across all projects' :
      filters.project === NOPROJ ? 'every initiative with no project link' :
      'every initiative attached to ' + scope;
    var m = UI.modal('<h2 style="margin-top:0;">Clear initiatives</h2>' +
      '<p>This deletes <strong>' + list.length + '</strong> row' + (list.length === 1 ? '' : 's') +
      ' — ' + esc(label) + '.</p>' +
      '<p>Type <code>' + esc(scope) + '</code> to confirm:</p><input class="pd-input" id="in-confirm" />' +
      '<div class="pd-modal-actions"><button class="pd-btn" id="in-cc">Cancel</button>' +
      '<button class="pd-btn pd-btn-danger" id="in-cok">Delete them</button></div>', { noBackdropClose: true });
    m.el.querySelector('#in-cc').onclick = m.close;
    m.el.querySelector('#in-cok').onclick = async function () {
      if (m.el.querySelector('#in-confirm').value.trim() !== scope) { UI.toast('That does not match.', 'error'); return; }
      try {
        // Delete by the ids actually on screen rather than by a filter
        // expression — the two cannot drift apart that way, and `is null` vs
        // `eq` is exactly the kind of predicate that gets mistranslated.
        var ids = list.map(function (r) { return r.id; });
        for (var i = 0; i < ids.length; i += 200) {
          var res = await sb().from(TABLE).delete().in('id', ids.slice(i, i + 200));
          if (res.error) throw res.error;
        }
        var gone = {}; ids.forEach(function (i2) { gone[i2] = 1; });
        rows = rows.filter(function (r) { return !gone[r.id]; });
        m.close(); syncFilterOptions(); render(); UI.toast('Deleted ' + ids.length + ' initiatives.');
      } catch (e) { UI.toast('Clear failed: ' + (e.message || e), 'error'); }
    };
  }

  // ==========================================================================
  // Import — HEADER-MAPPED, because there is no known layout
  // ==========================================================================
  // ⚠️ Same reasoning as the Value Engineering importer: with no source workbook,
  // reading by column index would be a guess dressed up as a rule. Headers are
  // normalised, matched against a synonym table, and the resulting mapping is
  // SHOWN before anything is written. Unmapped columns are reported, never
  // silently dropped.
  var SYN = {
    init_no: ['no', 'ref', 'ref no', 'id', 'initiative no', 'initiative id', 'code', 'item no'],
    title: ['title', 'initiative', 'initiative title', 'name', 'item'],
    description: ['description', 'details', 'scope', 'summary', 'objective'],
    category: ['category', 'type', 'theme', 'pillar', 'classification'],
    department: ['department', 'dept', 'section', 'division', 'team', 'unit'],
    owner_name: ['owner', 'initiative owner', 'responsible', 'lead', 'accountable', 'assigned to'],
    sponsor: ['sponsor', 'champion', 'endorser'],
    project_id: ['project', 'project id', 'project code'],
    status: ['status', 'progress status', 'state'],
    priority: ['priority', 'pri'],
    progress_pct: ['progress', 'progress %', 'percent complete', '% complete', 'completion'],
    start_date: ['start date', 'start', 'date started', 'kickoff'],
    target_date: ['target date', 'target', 'due date', 'deadline', 'completion target'],
    completed_date: ['completed date', 'date completed', 'actual completion', 'closed date'],
    benefit_type: ['benefit type', 'benefit', 'benefit category', 'impact type'],
    benefit_value: ['value', 'benefit value', 'savings', 'estimated savings', 'amount'],
    benefit_note: ['expected benefit', 'benefit description', 'outcome', 'expected outcome'],
    kpi_metric: ['kpi', 'metric', 'measure', 'kpi metric', 'success measure'],
    kpi_baseline: ['baseline', 'kpi baseline', 'as is'],
    kpi_target: ['kpi target', 'target value', 'goal'],
    kpi_current: ['current', 'kpi current', 'actual', 'current value'],
    reference_link: ['link', 'reference', 'reference link', 'document link', 'url'],
    remarks: ['remarks', 'notes', 'comment', 'comments', 'status update']
  };
  function normHdr(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[‘’]/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();
  }
  // ⚠️ THE SYNONYM TABLE IS NORMALISED THROUGH normHdr TOO, once, at load.
  // Headers are normalised before comparison, so a synonym written with any
  // punctuation — "progress %", "% complete" — could NEVER match its own column:
  // the header arrived as "progress" and the literal still carried its sign. It
  // failed silently, dropping the column into `unmapped` as though the sheet had
  // not carried it at all. The Value Engineering importer had the identical bug
  // and is fixed the same way; the harness caught it, reading the source did not.
  var SYN_N = {};
  Object.keys(SYN).forEach(function (f) {
    SYN_N[f] = SYN[f].map(normHdr).filter(Boolean);
  });

  // ⚠️ First match wins and SYN is walked in declaration order, so a sheet with
  // both "Target date" and "KPI target" maps each to its own field rather than
  // letting the looser synonym swallow the tighter one.
  function mapHeaders(hdrRow) {
    var map = {}, used = {}, unmapped = [];
    hdrRow.forEach(function (raw, idx) {
      var h = normHdr(raw);
      if (!h) return;
      var hit = null;
      Object.keys(SYN_N).some(function (field) {
        if (used[field]) return false;
        if (SYN_N[field].indexOf(h) !== -1) { hit = field; return true; }
        return false;
      });
      if (hit) { map[hit] = idx; used[hit] = 1; }
      else unmapped.push(String(raw).trim());
    });
    return { map: map, unmapped: unmapped };
  }

  function gridOf(ws) {
    var R = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    var maxC = Math.min(R.e.c, 60), maxR = Math.min(R.e.r, 4000), out = [];
    for (var r = R.s.r; r <= maxR; r++) {
      var row = [];
      for (var c = R.s.c; c <= maxC; c++) {
        var cell = ws[XLSX.utils.encode_cell({ r: r, c: c })];
        // ⚠️ FORMATTED TEXT (cell.w), never the raw value — SheetJS returns the
        // cell displaying 06-Aug-26 as 2026-08-05T15:59:17Z, so local getters
        // land a day out east of Greenwich.
        row.push(cell ? (cell.w != null ? String(cell.w).trim() : String(cell.v).trim()) : '');
      }
      out.push(row);
    }
    return out;
  }
  function parseDate(v) {
    if (!v || v === '-') return null;
    var s = String(v).trim(), m;
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = /^(\d{1,2})[-\/ ]([A-Za-z]{3})[a-z]*[-\/ ](\d{2,4})$/.exec(s);
    if (m) {
      var mi = MNAME.indexOf(m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase());
      if (mi >= 0) {
        var y = +m[3]; if (y < 100) y += 2000;
        return y + '-' + String(mi + 1).padStart(2, '0') + '-' + String(+m[1]).padStart(2, '0');
      }
    }
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return m[3] + '-' + String(+m[2]).padStart(2, '0') + '-' + String(+m[1]).padStart(2, '0');
    return null;
  }
  function realDate(d) {
    if (!d) return null;
    var y = +String(d).slice(0, 4);
    return (y < 2015 || y > 2100) ? null : d;
  }
  function parseMoney(v) {
    if (v == null || v === '') return null;
    var s = String(v).trim();
    if (!s || s === '-' || s === '—') return null;
    var neg = /^\(.*\)$/.test(s);
    s = s.replace(/[()]/g, '').replace(/[^\d.\-]/g, '');
    if (!s || s === '-' || s === '.') return null;
    var n = parseFloat(s);
    if (isNaN(n)) return null;
    return neg ? -n : n;
  }
  // "45%", "0.45" and "45" all mean the same thing in a progress column. A bare
  // decimal below 1 is read as a fraction; anything else as a percentage.
  function parsePct(v) {
    if (v == null || v === '') return null;
    var s = String(v).trim();
    var hadSign = s.indexOf('%') !== -1;
    var n = parseFloat(s.replace(/[^\d.\-]/g, ''));
    if (isNaN(n)) return null;
    if (!hadSign && n > 0 && n <= 1) n = n * 100;
    return Math.max(0, Math.min(100, Math.round(n)));
  }
  function normStatus(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s || s === '-') return null;
    var lo = s.toLowerCase();
    for (var i = 0; i < STATUS_ORDER.length; i++) {
      if (STATUS_ORDER[i].toLowerCase() === lo) return STATUS_ORDER[i];
    }
    if (/cancel|abandon|dropped/.test(lo)) return 'Cancelled';
    if (/complet|done|closed|deliver/.test(lo)) return 'Completed';
    if (/hold|defer|park|suspend/.test(lo)) return 'On Hold';
    if (/progress|ongoing|wip|started|active|implement/.test(lo)) return 'In Progress';
    if (/plan|approved|scheduled|backlog/.test(lo)) return 'Planned';
    if (/idea|concept|proposed|new/.test(lo)) return 'Idea';
    return s;
  }
  function pick(list, v) {
    var lo = String(v == null ? '' : v).trim().toLowerCase();
    if (!lo || lo === '-') return null;
    for (var i = 0; i < list.length; i++) if (list[i].toLowerCase() === lo) return list[i];
    for (var j = 0; j < list.length; j++) if (lo.indexOf(list[j].toLowerCase()) !== -1) return list[j];
    return String(v).trim();
  }

  function parseSheet(g) {
    // Header row = the first of the top 30 that maps a title AND at least one
    // other real field. Requiring two stops a decorative banner row being read
    // as headers.
    var best = null;
    for (var i = 0; i < Math.min(g.length, 30); i++) {
      var m = mapHeaders(g[i]);
      if (m.map.title != null && Object.keys(m.map).length >= 2) { best = { hdr: i, m: m }; break; }
    }
    if (!best) return null;
    var map = best.m.map, recs = [], order = 0;
    // ⚠️ A project code in the sheet is only accepted if it is a project the
    // user can actually access. Anything else becomes NULL (org-wide) rather
    // than being sent to the database, where RLS would reject the whole batch
    // for one bad cell — and the import report says how many were dropped.
    var okProj = {}; projects.forEach(function (p) { okProj[String(p.id).toUpperCase()] = p.id; });
    var droppedProjects = [];
    for (var r = best.hdr + 1; r < g.length; r++) {
      var row = g[r];
      var title = map.title != null ? String(row[map.title] || '').trim() : '';
      if (!title) continue;
      if (/^(prepared|checked|reviewed|approved|noted)\s+(and\s+checked\s+)?by/i.test(title)) break;
      function cell(k) { return map[k] == null ? '' : row[map[k]]; }
      var rawProj = String(cell('project_id') || '').trim();
      var proj = rawProj ? (okProj[rawProj.toUpperCase()] || null) : null;
      if (rawProj && !proj && droppedProjects.indexOf(rawProj) === -1) droppedProjects.push(rawProj);
      recs.push({
        init_no: String(cell('init_no') || '').trim() || null,
        title: title,
        description: String(cell('description') || '').trim() || null,
        category: pick(CATEGORIES, cell('category')),
        department: String(cell('department') || '').trim() || null,
        owner_name: String(cell('owner_name') || '').trim() || null,
        sponsor: String(cell('sponsor') || '').trim() || null,
        project_id: proj,
        status: normStatus(cell('status')),
        priority: /^[123]$/.test(String(cell('priority') || '').trim()) ? +cell('priority') : null,
        progress_pct: parsePct(cell('progress_pct')),
        start_date: realDate(parseDate(cell('start_date'))),
        target_date: realDate(parseDate(cell('target_date'))),
        completed_date: realDate(parseDate(cell('completed_date'))),
        benefit_type: pick(BENEFITS, cell('benefit_type')),
        benefit_value: parseMoney(cell('benefit_value')),
        benefit_note: String(cell('benefit_note') || '').trim() || null,
        kpi_metric: String(cell('kpi_metric') || '').trim() || null,
        kpi_baseline: parseMoney(cell('kpi_baseline')),
        kpi_target: parseMoney(cell('kpi_target')),
        kpi_current: parseMoney(cell('kpi_current')),
        reference_link: (String(cell('reference_link') || '').trim().indexOf('http') === 0)
          ? String(cell('reference_link')).trim() : null,
        remarks: String(cell('remarks') || '').trim() || null,
        sort_order: order++
      });
    }
    return { hdr: best.hdr, map: map, unmapped: best.m.unmapped, records: recs,
      droppedProjects: droppedProjects };
  }

  function parseWorkbook(wb) {
    var best = null;
    wb.SheetNames.forEach(function (nm) {
      var got = parseSheet(gridOf(wb.Sheets[nm]));
      if (got && got.records.length && (!best || got.records.length > best.records.length)) {
        best = { sheet: nm, hdr: got.hdr, map: got.map, unmapped: got.unmapped,
          records: got.records, droppedProjects: got.droppedProjects };
      }
    });
    return best;
  }

  async function onFile(e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    var m = UI.modal('<h2 style="margin-top:0;">Import initiatives</h2><p id="in-imp-msg">Reading…</p>',
      { noBackdropClose: true });
    var msg = m.el.querySelector('#in-imp-msg');
    try {
      var buf = await f.arrayBuffer();
      var wb = XLSX.read(buf, { type: 'array', cellDates: false, sheetRows: 4000 });
      var got = parseWorkbook(wb);
      if (!got) {
        msg.innerHTML = 'No usable header row found. The importer looks for a row carrying a ' +
          '<strong>title</strong> column plus at least one other recognised heading. Rename ' +
          'your headings or add the initiatives by hand.';
        return;
      }
      var mapped = Object.keys(got.map).sort().map(function (k) {
        return '<li><code>' + esc(k) + '</code> ← column ' +
          esc(XLSX.utils.encode_col(got.map[k])) + '</li>';
      }).join('');
      msg.innerHTML = 'Sheet <strong>' + esc(got.sheet) + '</strong>, headers on row ' +
        (got.hdr + 1) + ' — <strong>' + got.records.length + '</strong> initiatives.' +
        '<div class="in-impmap"><strong>Detected mapping</strong><ul>' + mapped + '</ul>' +
        (got.unmapped.length ? '<p class="in-mut"><strong>Ignored columns:</strong> ' +
          esc(got.unmapped.join(', ')) + '</p>' : '') +
        (got.droppedProjects.length ? '<p class="in-warn"><strong>Unrecognised project codes</strong> — ' +
          esc(got.droppedProjects.join(', ')) + '. Rows carrying these import as ' +
          '<strong>org-wide</strong> rather than failing.</p>' : '') + '</div>' +
        // ⚠️ NO "replace everything" default here. The table is org-wide, so a
        // replace would delete other departments' initiatives — the sibling
        // registers can offer it safely only because their delete is scoped to
        // one project. Import is ADD-ONLY.
        '<p class="in-mut" style="margin-top:10px;">Imported initiatives are <strong>added</strong>. ' +
        'This register spans the whole organisation, so there is deliberately no ' +
        '“replace everything” option — clear what you mean to clear from the toolbar first.</p>' +
        '<div class="pd-modal-actions"><button class="pd-btn" id="in-imp-cancel">Cancel</button>' +
        '<button class="pd-btn pd-btn-primary" id="in-imp-go">Import</button></div>';
      m.el.querySelector('#in-imp-cancel').onclick = m.close;
      m.el.querySelector('#in-imp-go').onclick = async function () {
        msg.textContent = 'Importing…';
        try {
          // ⚠️ Give every object the SAME key set. PostgREST bulk-inserts an
          // array by taking the UNION of its keys and sends NULL for any a row
          // omits — it does NOT fall back to the column DEFAULT.
          var keys = {};
          got.records.forEach(function (r) { Object.keys(r).forEach(function (k) { keys[k] = 1; }); });
          var allKeys = Object.keys(keys);
          var payload = got.records.map(function (r) {
            var o = { created_by: UID };
            allKeys.forEach(function (k) { o[k] = r[k] === undefined ? null : r[k]; });
            return o;
          });
          for (var i = 0; i < payload.length; i += 200) {
            var res = await sb().from(TABLE).insert(payload.slice(i, i + 200));
            if (res.error) throw res.error;
            msg.textContent = 'Importing… ' + Math.min(i + 200, payload.length) + ' / ' + payload.length;
            await new Promise(function (r2) { setTimeout(r2, 0); });
          }
          m.close(); UI.toast('Imported ' + got.records.length + ' initiatives.');
          await load();
        } catch (err) { msg.textContent = 'Import failed: ' + (err.message || err); }
      };
    } catch (err) { msg.textContent = 'Could not read the workbook: ' + (err.message || err); }
  }

  // ---- export --------------------------------------------------------------
  // Exports the CURRENT project scope, and says so in the file name — an export
  // that silently included every department would be a surprise.
  function exportExcel() {
    var list = scoped(), T = stats(list);
    var sum = groupBy(list, 'department').map(function (g) {
      return { Department: g.key, Initiatives: g.st.count, 'In progress': g.st.active,
        Completed: g.st.done, Cancelled: g.st.cancelled, Overdue: g.st.overdue,
        'Avg progress %': g.st.avgProgress == null ? '' : Math.round(g.st.avgProgress),
        'Cost benefit': g.st.costBenefit };
    });
    sum.push({ Department: 'TOTAL', Initiatives: T.count, 'In progress': T.active,
      Completed: T.done, Cancelled: T.cancelled, Overdue: T.overdue,
      'Avg progress %': T.avgProgress == null ? '' : Math.round(T.avgProgress),
      'Cost benefit': T.costBenefit });

    var reg = list.map(function (r) {
      return { 'No.': r.init_no || '', Title: r.title || '', Description: r.description || '',
        Category: r.category || '', Department: r.department || '', Owner: r.owner_name || '',
        Sponsor: r.sponsor || '',
        Project: r.project_id ? (projName[r.project_id] || r.project_id) : 'org-wide',
        'Project id': r.project_id || '', Status: statusOf(r), Priority: r.priority || '',
        'Progress %': progressOf(r) == null ? '' : progressOf(r),
        'Start date': r.start_date || '', 'Target date': r.target_date || '',
        'Completed date': r.completed_date || '', Overdue: isOverdue(r) ? 'Yes' : '',
        'Benefit type': r.benefit_type || '',
        // ⚠️ Blank for non-Cost rows, matching what the totals do — an exported
        // column that mixes benefit types invites a SUM() the module refuses.
        'Benefit value': (r.benefit_type === 'Cost') ? num(r.benefit_value) : '',
        'Expected benefit': r.benefit_note || '', KPI: r.kpi_metric || '',
        'KPI baseline': num(r.kpi_baseline), 'KPI current': num(r.kpi_current),
        'KPI target': num(r.kpi_target),
        Reference: r.reference_link || '', Remarks: r.remarks || '' };
    });
    var scope = filters.project === ALL ? 'All projects'
      : filters.project === NOPROJ ? 'Org-wide' : (projName[filters.project] || filters.project);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sum), 'SUMMARY');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reg), 'Initiatives');
    XLSX.writeFile(wb, 'Initiatives - ' + scope + '.xlsx');
  }

  // ==========================================================================
  // Shell
  // ==========================================================================
  function switchTab(v) {
    view = v;
    document.querySelectorAll('.in-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.view === v);
    });
    render();
  }
  function syncClearFilt() {
    var b = document.getElementById('in-f-clear');
    if (b) b.hidden = !anyFilter();
  }
  function syncFilterOptions() {
    function present(key) {
      var m = {};
      rows.forEach(function (r) { if (r[key]) m[r[key]] = 1; });
      return m;
    }
    var pc = present('category');
    var cats = CATEGORIES.filter(function (c) { return pc[c]; })
      .concat(Object.keys(pc).filter(function (c) { return CATEGORIES.indexOf(c) === -1; }).sort());
    var c = document.getElementById('in-f-category');
    c.innerHTML = '<option value="">All categories</option>' +
      cats.map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + '</option>'; }).join('');
    setSel('in-f-category', filters.category);

    var s = document.getElementById('in-f-status');
    s.innerHTML = '<option value="">All statuses</option>' +
      STATUS_ORDER.map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('');
    setSel('in-f-status', filters.status);

    var pd = present('department');
    var d = document.getElementById('in-f-department');
    d.innerHTML = '<option value="">All departments</option>' +
      Object.keys(pd).sort().map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + '</option>'; }).join('');
    setSel('in-f-department', filters.department);
  }

  async function init(user, profile) {
    UID = (user && user.id) || (profile && profile.id) || null;
    isAdmin = !!(profile && (profile.role === 'admin' || profile.role === 'super_admin'));
    canWrite = !!(profile && ['super_admin', 'admin', 'planner', 'user'].indexOf(profile.role) !== -1);
    UI.initShell();

    document.getElementById('in-clear').style.display = isAdmin ? '' : 'none';
    if (!canWrite) {
      ['in-add', 'in-import'].forEach(function (id) { var b = document.getElementById(id); if (b) b.style.display = 'none'; });
    }

    try { projects = (await PDb.getProjects()) || []; } catch (e) { projects = []; }
    projects = projects.filter(function (p) { return !AppAuth.canAccessProject || AppAuth.canAccessProject(profile, p.id); });
    projects.forEach(function (p) { projName[p.id] = p.name || p.id; });

    // ⚠️ A FILTER, not the page's context — hence the two sentinel options and
    // the plain <select> (see the header note on why enhanceProjectSelect is
    // wrong here). It does NOT write pd_project: leaving this module must not
    // change which project the rest of the app thinks you are in.
    var selEl = document.getElementById('in-project');
    selEl.innerHTML = '<option value="">All projects</option>' +
      '<option value="' + NOPROJ + '">Not project-linked</option>' +
      projects.map(function (p) {
        return '<option value="' + esc(p.id) + '">' + esc(p.name || p.id) + '</option>';
      }).join('');
    // Adopt the app-wide selection as the opening filter when it is a project
    // this user can really access — never `projects[0]`, and never a redirect.
    var stored = sessionStorage.getItem('pd_project');
    filters.project = (stored && projects.some(function (p) { return String(p.id) === String(stored); }))
      ? stored : ALL;
    selEl.value = filters.project;
    selEl.addEventListener('change', function () {
      filters.project = selEl.value;
      render();
    });

    document.querySelectorAll('.in-tab').forEach(function (t) {
      t.onclick = function () { switchTab(t.dataset.view); };
    });
    document.getElementById('in-add').onclick = function () { openForm(null); };
    document.getElementById('in-import').onclick = function () { document.getElementById('in-file').click(); };
    document.getElementById('in-file').addEventListener('change', onFile);
    document.getElementById('in-export').onclick = exportExcel;
    document.getElementById('in-print').onclick = function () { setTimeout(function () { window.print(); }, 60); };
    document.getElementById('in-clear').onclick = clearAll;

    var q = document.getElementById('in-f-search'), tmr = null;
    q.addEventListener('input', function () {
      clearTimeout(tmr);
      tmr = setTimeout(function () { filters.q = q.value; render(); }, 160);
    });
    document.getElementById('in-f-category').addEventListener('change', function (e) { filters.category = e.target.value; render(); });
    document.getElementById('in-f-status').addEventListener('change', function (e) { filters.status = e.target.value; render(); });
    document.getElementById('in-f-department').addEventListener('change', function (e) { filters.department = e.target.value; render(); });
    document.getElementById('in-f-hideclosed').addEventListener('change', function (e) { filters.hideClosed = e.target.checked; render(); });
    document.getElementById('in-f-clear').onclick = function () {
      // ⚠️ Clearing the FILTERS does not reset the project scope — that control
      // lives in the topbar beside the tabs, not in this bar, and silently
      // widening it to every project would change what the Overview totals mean.
      filters = { q: '', project: filters.project, category: '', status: '', department: '', hideClosed: false };
      q.value = '';
      ['in-f-category', 'in-f-status', 'in-f-department'].forEach(function (id) { document.getElementById(id).value = ''; });
      document.getElementById('in-f-hideclosed').checked = false;
      render();
    };

    await load();
  }

  return {
    init: init,
    // Exposed so a verification harness runs the SHIPPED functions rather than a
    // reimplementation of them — the arrangement every sibling register uses.
    _internals: { stats: stats, groupBy: groupBy, scoped: scoped, isOverdue: isOverdue,
      progressOf: progressOf, todayISO: todayISO, parseWorkbook: parseWorkbook,
      parseSheet: parseSheet, mapHeaders: mapHeaders, normHdr: normHdr, parseDate: parseDate,
      realDate: realDate, parseMoney: parseMoney, parsePct: parsePct, normStatus: normStatus,
      pick: pick, matches: matches, headCells: headCells, render: render, switchTab: switchTab,
      setRows: function (x) { rows = x; },
      setProjects: function (x) { projects = x; projName = {}; x.forEach(function (p) { projName[p.id] = p.name || p.id; }); },
      setFilters: function (x) { filters = x; },
      setCanWrite: function (x) { canWrite = x; },
      STATUSES: STATUSES, CATEGORIES: CATEGORIES, BENEFITS: BENEFITS, SYN: SYN,
      ALL: ALL, NOPROJ: NOPROJ }
  };
})();
