/* Value Engineering List — modules/value-engineering/module.js

   ⚠️ NO SOURCE WORKBOOK. The three sibling registers were each transcribed from
   a real PMO workbook whose own formulas were the spec. There is no VE tracker
   to build against (owner confirmed), so every vocabulary and every derivation
   here was DESIGNED. Two things follow, and both are deliberate:

     1. The Summary shows no "reconciliation note", because there is no source
        to reconcile against. It shows a METHOD note instead — how each figure is
        built — so the first person to compare it with their own spreadsheet can
        see exactly where a difference would come from.
     2. The importer maps BY HEADER NAME with synonyms, not by column index.
        Every sibling importer reads by index precisely because it knows the
        layout; this one does not, so it detects the mapping, SHOWS it, and lets
        the user cancel before anything is written.

   ⚠️ POTENTIAL AND REALISED SAVINGS ARE DIFFERENT NUMBERS AND ARE NEVER ADDED.

     potential = baseline - proposed   a CLAIM, available as soon as it is raised
     realised  = baseline - actual     a FACT, only once actual_cost exists

   A VE register that reports one total always overstates itself: every proposal
   ever raised contributes its claim, including the rejected ones. So:
     - `savingOf`   is computed for any row with both costs;
     - `realisedOf` returns null unless the row has an actual cost;
     - `stats()` reports pipeline / approved / realised as three separate
       figures, and the module never sums them together anywhere. */
window.ValueEngineering = (function () {
  'use strict';

  var TABLE = 'value_engineering';
  var sb = function () { return window.__sb || (window.__sb = supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY)); };
  var esc = function (s) { return Fmt.esc(s == null ? '' : String(s)); };
  function ico(name, size) { return (window.Icons && Icons.svg) ? Icons.svg(name, size || 15) : ''; }

  // Lifecycle, in order. `open` = still in the pipeline; `won` = counted toward
  // approved value; `done` = realised. A status belongs to at most one bucket,
  // which is what stops a row being counted twice in the KPI row.
  var STATUSES = [
    { name: 'Proposed',     cls: 've-s-prop', open: true },
    { name: 'Under Review', cls: 've-s-rev',  open: true },
    { name: 'Endorsed',     cls: 've-s-end',  open: true },
    { name: 'Approved',     cls: 've-s-app',  won: true },
    { name: 'Implemented',  cls: 've-s-imp',  won: true, done: true },
    { name: 'On Hold',      cls: 've-s-hold', open: true },
    { name: 'Rejected',     cls: 've-s-rej' }
  ];
  var STATUS_ORDER = STATUSES.map(function (s) { return s.name; });

  var DISCIPLINES = ['Architectural', 'Structural', 'Civil', 'Mechanical', 'Electrical',
    'Plumbing', 'Fire Protection', 'Landscape', 'Temporary Works', 'Other'];
  var ORIGINS = ['Design', 'Site', 'Client', 'Consultant', 'Vendor', 'Subcontractor'];
  var QUALITY = ['None', 'Low', 'Medium', 'High'];

  var pid = null, UID = null, rows = [], canWrite = false, isAdmin = false;
  var view = 'summary', projects = [];
  var filters = { q: '', discipline: '', status: '', quality: '', hideRejected: false };

  // ---- helpers -------------------------------------------------------------
  var MNAME = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function fmtDate(s) {
    if (!s) return '';
    var p = String(s).slice(0, 10).split('-');
    if (p.length !== 3 || isNaN(+p[0])) return esc(s);
    return String(+p[2]).padStart(2, '0') + '-' + MNAME[+p[1] - 1] + '-' + String(p[0]).slice(2);
  }
  function num(v) { return (v === null || v === undefined || v === '' || isNaN(+v)) ? null : +v; }
  function money(n) { return n == null ? '<span class="ve-mut">—</span>' : esc(Fmt.moneyShort(n)); }
  function statusOf(r) { return (r.status || '').trim(); }
  function statusMeta(n) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].name === n) return STATUSES[i];
    return null;
  }

  // ⚠️ The two savings. See the header note — never add them together.
  function savingOf(r) {
    var b = num(r.baseline_cost), p = num(r.proposed_cost);
    return (b == null || p == null) ? null : b - p;
  }
  function realisedOf(r) {
    var b = num(r.baseline_cost), a = num(r.actual_cost);
    return (b == null || a == null) ? null : b - a;
  }
  function isWon(r) { var m = statusMeta(statusOf(r)); return !!(m && m.won); }
  function isOpen(r) { var m = statusMeta(statusOf(r)); return !!(m && m.open); }
  function isRejected(r) { return statusOf(r) === 'Rejected'; }

  // ==========================================================================
  // Summary maths
  // ==========================================================================
  // Every figure below is a plain sum over a named subset. There is no weighting
  // and no averaging of ratios anywhere — the trap the Method Register found in
  // its own source workbook, avoided here by construction.
  function stats(list) {
    var s = {
      count: list.length, open: 0, won: 0, implemented: 0, rejected: 0,
      pipeline: 0,        // potential saving of rows still in the pipeline
      approved: 0,        // potential saving of Approved + Implemented
      realised: 0,        // baseline - actual, Implemented rows with an actual cost
      rejectedValue: 0,   // potential saving that was turned down
      realisedOf: 0,      // approved potential the realised figure is measured against
      days: 0,            // net schedule impact of Approved + Implemented
      noCost: 0           // rows where no saving can be computed at all
    };
    list.forEach(function (r) {
      var sav = savingOf(r), real = realisedOf(r);
      if (sav == null) s.noCost++;
      if (isRejected(r)) { s.rejected++; if (sav != null) s.rejectedValue += sav; return; }
      if (isOpen(r)) { s.open++; if (sav != null) s.pipeline += sav; }
      if (isWon(r)) {
        s.won++;
        if (sav != null) s.approved += sav;
        s.days += num(r.schedule_impact_days) || 0;
      }
      if (statusOf(r) === 'Implemented') {
        s.implemented++;
        // ⚠️ Only rows that actually carry an actual cost contribute to BOTH
        // sides. Comparing a realised total against the full approved total
        // when half the rows have no actual cost yet reads as a shortfall that
        // is really just missing data.
        if (real != null) { s.realised += real; if (sav != null) s.realisedOf += sav; }
      }
    });
    s.acceptance = (s.won + s.rejected) ? s.won / (s.won + s.rejected) : 0;
    return s;
  }

  function groupBy(key) {
    var m = {}, order = [];
    rows.forEach(function (r) {
      var k = (r[key] || '').trim() || '(unspecified)';
      if (!m[k]) { m[k] = []; order.push(k); }
      m[k].push(r);
    });
    return order.sort().map(function (k) { return { key: k, rows: m[k], st: stats(m[k]) }; });
  }

  // ==========================================================================
  // Load
  // ==========================================================================
  async function load() {
    var host = document.getElementById('ve-view');
    host.innerHTML = skeletonHTML();
    // Keyset-paginated: PostgREST caps a select at 1000 rows and returns NO
    // error, which is how four Planning App modules silently truncated.
    var out = [], last = null;
    try {
      for (var i = 0; i < 40; i++) {
        var q = sb().from(TABLE).select('*').eq('project_id', pid).order('id').limit(1000);
        if (last) q = q.gt('id', last);
        var res = await q;
        if (res.error) throw res.error;
        var batch = res.data || [];
        out = out.concat(batch);
        if (batch.length < 1000) break;
        last = batch[batch.length - 1].id;
      }
    } catch (e) {
      host.innerHTML = '<div class="pd-card ve-empty"><h3>Could not load the VE list</h3><p>' +
        esc(e.message || e) + '</p><p class="ve-mut">If the table is missing, run ' +
        '<code>migrations/0014-value-engineering.sql</code>.</p></div>';
      return;
    }
    // ⚠️ Paginate by `id`, sort for DISPLAY afterwards. sort_order is nullable
    // and non-unique so it cannot drive a keyset cursor — the same correction
    // material-submittal's CLAUDE.md records.
    rows = out.sort(function (a, b) {
      var sa = a.sort_order == null ? 1e9 : a.sort_order, sbb = b.sort_order == null ? 1e9 : b.sort_order;
      if (sa !== sbb) return sa - sbb;
      return String(a.ve_no || '').localeCompare(String(b.ve_no || ''), undefined, { numeric: true });
    });
    syncFilterOptions();
    render();
  }

  function skeletonHTML() {
    var out = '';
    for (var i = 0; i < 8; i++) {
      out += '<div class="ve-sk-row"><span class="ve-sk" style="width:10%"></span>' +
        '<span class="ve-sk" style="width:42%"></span><span class="ve-sk" style="width:16%"></span>' +
        '<span class="ve-sk" style="width:14%"></span></div>';
    }
    return '<div class="pd-card ve-skcard" aria-busy="true">' +
      '<div class="ve-sk-head"><span class="ve-spin"></span>Loading VE list…</div>' + out + '</div>';
  }

  // ==========================================================================
  // Render
  // ==========================================================================
  function render() {
    document.getElementById('ve-filters').style.display = view === 'registry' ? '' : 'none';
    document.body.classList.toggle('ve-fit', view === 'registry');
    if (view === 'summary') renderSummary(); else renderRegistry();
    syncClearFilt();
  }

  function kpi(val, label, sub, tone) {
    return '<div class="pd-card ve-kpi' + (tone ? ' ' + tone : '') + '">' +
      '<div class="ve-kpi-val">' + esc(val) + '</div>' +
      '<div class="ve-kpi-lbl">' + esc(label) + '</div>' +
      (sub ? '<div class="ve-kpi-sub">' + esc(sub) + '</div>' : '') + '</div>';
  }
  function pct(n) { return (n * 100).toFixed(1) + '%'; }

  function renderSummary() {
    var host = document.getElementById('ve-view');
    if (!rows.length) { host.innerHTML = emptyHTML(); wireEmpty(); return; }
    var T = stats(rows);

    var h = '<div class="ve-kpis">' +
      kpi(T.count, 'Proposals', T.open + ' still open') +
      kpi(Fmt.moneyShort(T.pipeline), 'Pipeline saving', 'claimed, not yet decided') +
      kpi(Fmt.moneyShort(T.approved), 'Approved saving', T.won + ' approved or implemented', 'good') +
      kpi(Fmt.moneyShort(T.realised), 'Realised saving', 'measured against actual cost', 'good') +
      kpi(pct(T.acceptance), 'Acceptance rate', T.won + ' of ' + (T.won + T.rejected) + ' decided') +
      kpi((T.days > 0 ? '+' : '') + T.days + 'd', 'Programme impact',
          T.days > 0 ? 'approved VE costs time' : 'approved VE saves time',
          T.days > 0 ? 'bad' : '') +
      '</div>';

    // ---- by status ----
    h += '<div class="ve-grid2">';
    h += '<div class="pd-card ve-panel"><h3>By status</h3><table class="ve-mini"><tbody>';
    STATUS_ORDER.forEach(function (name) {
      var list = rows.filter(function (r) { return statusOf(r) === name; });
      var meta = statusMeta(name);
      var sv = list.reduce(function (a, r) { var v = savingOf(r); return a + (v || 0); }, 0);
      h += '<tr' + (list.length ? ' class="ve-drill" data-status="' + esc(name) + '"' : '') + '>' +
        '<td><span class="ve-pill ' + meta.cls + '">' + esc(name) + '</span></td>' +
        '<td class="ve-r ve-b">' + list.length + '</td>' +
        '<td class="ve-r ve-mut">' + (list.length ? esc(Fmt.moneyShort(sv)) : '—') + '</td></tr>';
    });
    var blank = rows.filter(function (r) { return !statusOf(r); }).length;
    if (blank) {
      h += '<tr><td><span class="ve-mut">(no status)</span></td>' +
        '<td class="ve-r ve-b">' + blank + '</td><td class="ve-r ve-mut">—</td></tr>';
    }
    h += '</tbody></table></div>';

    // ---- realised vs approved ----
    // ⚠️ Deliberately NOT a single "% achieved" number. The denominator is the
    // approved potential OF THE ROWS THAT HAVE AN ACTUAL COST — anything else
    // reports missing data as a shortfall.
    var pend = T.implemented - rows.filter(function (r) {
      return statusOf(r) === 'Implemented' && realisedOf(r) != null; }).length;
    h += '<div class="pd-card ve-panel"><h3>Claimed vs realised</h3>' +
      '<table class="ve-mini"><tbody>' +
      '<tr><td>Approved potential</td><td class="ve-r ve-b">' + esc(Fmt.moneyShort(T.approved)) + '</td></tr>' +
      '<tr><td>Of which measured</td><td class="ve-r">' + esc(Fmt.moneyShort(T.realisedOf)) + '</td></tr>' +
      '<tr><td>Realised (actual cost)</td><td class="ve-r ve-b">' + esc(Fmt.moneyShort(T.realised)) + '</td></tr>' +
      '<tr><td>Variance on measured</td><td class="ve-r ' +
        (T.realised - T.realisedOf < 0 ? 've-neg' : 've-pos') + '">' +
        esc(Fmt.moneyShort(T.realised - T.realisedOf)) + '</td></tr>' +
      '<tr><td class="ve-mut">Turned down</td><td class="ve-r ve-mut">' + esc(Fmt.moneyShort(T.rejectedValue)) + '</td></tr>' +
      '</tbody></table>' +
      (pend ? '<p class="ve-panel-note">' + pend + ' implemented item' + (pend === 1 ? '' : 's') +
        ' still ha' + (pend === 1 ? 's' : 've') + ' no actual cost, so ' +
        (pend === 1 ? 'it is' : 'they are') + ' excluded from both figures above.</p>' : '') +
      '</div></div>';

    // ---- by discipline ----
    h += '<div class="pd-card ve-tablecard"><table class="ve-sumtable"><thead><tr>' +
      '<th>Discipline</th><th class="ve-r">Items</th><th class="ve-r">Open</th>' +
      '<th class="ve-r">Approved</th><th class="ve-r">Rejected</th>' +
      '<th class="ve-r">Pipeline</th><th class="ve-r">Approved saving</th>' +
      '<th class="ve-r">Realised</th><th class="ve-r">Accepted</th></tr></thead><tbody>';
    var byDisc = groupBy('discipline');
    byDisc.forEach(function (g) {
      h += '<tr class="ve-sumrow" data-disc="' + esc(g.key) + '">' +
        '<td class="ve-b">' + esc(g.key) + '</td>' +
        '<td class="ve-r ve-b">' + g.st.count + '</td>' +
        '<td class="ve-r">' + g.st.open + '</td>' +
        '<td class="ve-r">' + g.st.won + '</td>' +
        '<td class="ve-r">' + g.st.rejected + '</td>' +
        '<td class="ve-r ve-mut">' + esc(Fmt.moneyShort(g.st.pipeline)) + '</td>' +
        '<td class="ve-r">' + esc(Fmt.moneyShort(g.st.approved)) + '</td>' +
        '<td class="ve-r">' + esc(Fmt.moneyShort(g.st.realised)) + '</td>' +
        '<td class="ve-r">' + ((g.st.won + g.st.rejected) ? esc(pct(g.st.acceptance)) : '—') + '</td></tr>';
    });
    h += '<tr class="ve-sumtotal"><td>TOTAL</td><td class="ve-r">' + T.count + '</td>' +
      '<td class="ve-r">' + T.open + '</td><td class="ve-r">' + T.won + '</td>' +
      '<td class="ve-r">' + T.rejected + '</td>' +
      '<td class="ve-r">' + esc(Fmt.moneyShort(T.pipeline)) + '</td>' +
      '<td class="ve-r">' + esc(Fmt.moneyShort(T.approved)) + '</td>' +
      '<td class="ve-r">' + esc(Fmt.moneyShort(T.realised)) + '</td>' +
      '<td class="ve-r">' + ((T.won + T.rejected) ? esc(pct(T.acceptance)) : '—') + '</td></tr>';
    h += '</tbody></table></div>';

    h += methodNoteHTML(T);
    host.innerHTML = h;
    if (window.Icons && Icons.hydrate) Icons.hydrate(host);
    host.querySelectorAll('.ve-sumrow').forEach(function (tr) {
      tr.onclick = function () { drillTo('discipline', tr.dataset.disc); };
    });
    host.querySelectorAll('.ve-drill').forEach(function (tr) {
      tr.onclick = function () { drillTo('status', tr.dataset.status); };
    });
  }

  // There is no source workbook to reconcile against, so this states the METHOD
  // instead — the same purpose the sibling registers' reconciliation notes serve:
  // make the arithmetic checkable by someone holding their own spreadsheet.
  function methodNoteHTML(T) {
    var notes = [
      '<li><strong>Pipeline, approved and realised are never added together.</strong> ' +
        'Pipeline is the claimed saving of items still being decided; approved is the claimed ' +
        'saving of Approved and Implemented items; realised is <code>baseline − actual</code>. ' +
        'The same item appears in at most one of the first two.</li>',
      '<li><strong>Rejected items contribute nothing but their own line.</strong> ' +
        esc(Fmt.moneyShort(T.rejectedValue)) + ' of claimed saving was turned down and is ' +
        'reported separately — a VE list that totals every proposal ever raised always ' +
        'overstates itself.</li>'
    ];
    if (T.noCost) {
      notes.push('<li><strong>' + T.noCost + ' item' + (T.noCost === 1 ? '' : 's') +
        ' carr' + (T.noCost === 1 ? 'ies' : 'y') + ' no cost pair,</strong> so no saving can be ' +
        'computed for ' + (T.noCost === 1 ? 'it' : 'them') + ' at all. ' +
        (T.noCost === 1 ? 'It is' : 'They are') + ' counted in the item totals but in none of ' +
        'the money figures. Fill in baseline and proposed cost to bring ' +
        (T.noCost === 1 ? 'it' : 'them') + ' in.</li>');
    }
    return '<div class="pd-card ve-note"><div class="ve-note-hd">' + ico('bulb', 15) +
      ' How these figures are built</div><ul>' + notes.join('') + '</ul></div>';
  }

  // ⚠️ A drill target whose count cannot match the number just clicked is worse
  // than no drill at all (the rule both sibling registers follow), so every
  // drill here clears the OTHER filters rather than intersecting with them.
  function drillTo(kind, value) {
    filters = { q: '', discipline: '', status: '', quality: '', hideRejected: false };
    if (kind === 'discipline') filters.discipline = value === '(unspecified)' ? '' : value;
    else filters.status = value;
    var q = document.getElementById('ve-f-search'); if (q) q.value = '';
    setSel('ve-f-discipline', filters.discipline);
    setSel('ve-f-status', filters.status);
    setSel('ve-f-quality', '');
    document.getElementById('ve-f-hiderej').checked = false;
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
    if (filters.hideRejected && isRejected(r)) return false;
    if (filters.discipline && (r.discipline || '') !== filters.discipline) return false;
    if (filters.status && statusOf(r) !== filters.status) return false;
    if (filters.quality && (r.quality_impact || '') !== filters.quality) return false;
    if (filters.q) {
      var hay = [r.ve_no, r.title, r.description, r.element, r.discipline,
        r.proposed_by, r.responsible, r.remarks].filter(Boolean).join(' ').toLowerCase();
      if (hay.indexOf(filters.q.toLowerCase()) === -1) return false;
    }
    return true;
  }
  function anyFilter() {
    return !!(filters.q || filters.discipline || filters.status || filters.quality || filters.hideRejected);
  }

  // ⚠️ HEAD is the SINGLE SOURCE OF TRUTH for the column count. The empty state
  // spans it; a hardcoded number silently skews the table the moment a column is
  // added, which is exactly what bit material-submittal.
  function headCells() {
    var H = ['<th class="ve-fz1">VE No.</th>', '<th class="ve-fz2">Proposal</th>',
      '<th>Discipline</th>', '<th>Element</th>',
      '<th class="ve-r">Baseline</th>', '<th class="ve-r">Proposed</th>',
      '<th class="ve-r">Potential</th>', '<th class="ve-r">Actual</th>',
      '<th class="ve-r">Realised</th>', '<th class="ve-r">Sched.</th>',
      '<th>Quality</th>', '<th>Status</th>', '<th class="ve-r">Pri</th>',
      '<th>Raised</th>', '<th>Decided</th>', '<th>Responsible</th>',
      '<th class="ve-doccol">Ref</th>'];
    if (canWrite) H.push('<th class="ve-actcol"></th>');
    return H;
  }

  function renderRegistry() {
    var host = document.getElementById('ve-view');
    if (!rows.length) { host.innerHTML = emptyHTML(); wireEmpty(); return; }
    var shown = rows.filter(matches);
    document.getElementById('ve-count').textContent = 'Showing ' + shown.length + ' of ' + rows.length;

    var HEAD = headCells(), SPAN = HEAD.length;
    var h = '<div class="pd-card ve-tablecard"><table class="ve-table"><thead><tr>' +
      HEAD.join('') + '</tr></thead><tbody>';
    if (!shown.length) {
      h += '<tr><td colspan="' + SPAN + '" style="text-align:center;padding:34px;" class="ve-mut">' +
        'No proposals match these filters.</td></tr>';
    }
    shown.forEach(function (r) {
      var s = statusOf(r), meta = statusMeta(s);
      var sav = savingOf(r), real = realisedOf(r);
      var days = num(r.schedule_impact_days);
      h += '<tr data-id="' + esc(r.id) + '"' + (isRejected(r) ? ' class="ve-rejected"' : '') + '>' +
        '<td class="ve-fz1"><span class="ve-code">' + esc(r.ve_no || '—') + '</span></td>' +
        '<td class="ve-fz2"><div class="ve-item">' + esc(r.title || '(untitled)') + '</div>' +
          (r.description ? '<div class="ve-sub">' + esc(String(r.description).slice(0, 120)) +
            (String(r.description).length > 120 ? '…' : '') + '</div>' : '') + '</td>' +
        '<td class="ve-nowrap">' + esc(r.discipline || '') + '</td>' +
        '<td class="ve-nowrap">' + esc(r.element || '') + '</td>' +
        '<td class="ve-r ve-mut">' + money(num(r.baseline_cost)) + '</td>' +
        '<td class="ve-r ve-mut">' + money(num(r.proposed_cost)) + '</td>' +
        '<td class="ve-r ve-b ' + (sav == null ? '' : sav < 0 ? 've-neg' : 've-pos') + '">' + money(sav) + '</td>' +
        '<td class="ve-r ve-mut">' + money(num(r.actual_cost)) + '</td>' +
        '<td class="ve-r ' + (real == null ? '' : real < 0 ? 've-neg' : 've-pos') + '">' + money(real) + '</td>' +
        '<td class="ve-r' + (days > 0 ? ' ve-neg' : days < 0 ? ' ve-pos' : '') + '">' +
          (days == null ? '<span class="ve-mut">—</span>' : (days > 0 ? '+' : '') + days + 'd') + '</td>' +
        '<td>' + (r.quality_impact
          ? '<span class="ve-qi ve-qi-' + esc(String(r.quality_impact).toLowerCase()) + '">' + esc(r.quality_impact) + '</span>'
          : '<span class="ve-mut">—</span>') + '</td>' +
        '<td>' + (s ? '<span class="ve-pill ' + (meta ? meta.cls : 've-s-prop') + '">' + esc(s) + '</span>'
          : '<span class="ve-mut">—</span>') + '</td>' +
        '<td class="ve-r">' + (r.priority ? '<span class="ve-pri ve-pri-' + r.priority + '">' + r.priority + '</span>' : '') + '</td>' +
        '<td class="ve-nowrap ve-mut">' + fmtDate(r.date_raised) + '</td>' +
        '<td class="ve-nowrap ve-mut">' + fmtDate(r.decision_date) + '</td>' +
        '<td class="ve-nowrap">' + esc(r.responsible || '') + '</td>' +
        '<td class="ve-doccol">' + (r.reference_link
          ? '<a class="ve-filebtn" href="' + esc(r.reference_link) + '" target="_blank" rel="noopener" title="Open the reference document">' + ico('link', 14) + '</a>'
          : '<span class="ve-mut">—</span>') + '</td>' +
        (canWrite ? '<td class="ve-actcol"><button class="pd-btn ve-iconbtn" data-edit="' + esc(r.id) + '" title="Edit">' + ico('pencil', 15) + '</button> ' +
          '<button class="pd-btn ve-iconbtn ve-iconbtn-del" data-del="' + esc(r.id) + '" title="Delete">' + ico('trash', 15) + '</button></td>' : '') +
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
    host.querySelectorAll('.ve-filebtn').forEach(function (a) { a.onclick = function (e) { e.stopPropagation(); }; });
  }

  function emptyHTML() {
    return '<div class="pd-card ve-empty"><h3>No value engineering proposals yet</h3>' +
      '<p>Add proposals one at a time, or import an existing VE spreadsheet — the ' +
      'importer maps your own column headings and shows you the mapping first.</p>' +
      (canWrite ? '<p style="margin-top:14px;"><button class="pd-btn pd-btn-primary" id="ve-e-add">Add a proposal</button> ' +
        '<button class="pd-btn" id="ve-e-imp">Import from Excel</button></p>' : '') + '</div>';
  }
  function wireEmpty() {
    var a = document.getElementById('ve-e-add'); if (a) a.onclick = function () { openForm(null); };
    var b = document.getElementById('ve-e-imp'); if (b) b.onclick = function () { document.getElementById('ve-file').click(); };
  }

  // ==========================================================================
  // CRUD
  // ==========================================================================
  function openForm(r) {
    if (!canWrite) return;
    r = r || {};
    var isNew = !r.id;
    function fld(label, inner, hint) {
      return '<label class="ve-fld"><span>' + esc(label) + '</span>' + inner +
        (hint ? '<small>' + esc(hint) + '</small>' : '') + '</label>';
    }
    function txt(k, v, type, step) {
      return '<input class="pd-input" data-k="' + k + '" type="' + (type || 'text') + '"' +
        (step ? ' step="' + step + '"' : '') + ' value="' + esc(v == null ? '' : v) + '" />';
    }
    function sel(k, list, cur, blank) {
      return '<select class="pd-select" data-k="' + k + '">' +
        (blank ? '<option value="">—</option>' : '') +
        list.map(function (o) {
          var val = Array.isArray(o) ? o[0] : o, lab = Array.isArray(o) ? o[1] : o;
          return '<option value="' + esc(val) + '"' + (String(cur || '') === String(val) ? ' selected' : '') + '>' + esc(lab) + '</option>';
        }).join('') + '</select>';
    }
    var m = UI.modal(
      '<div class="pd-modal-header"><h2 style="margin:0;">' + (isNew ? 'Add' : 'Edit') + ' VE proposal</h2>' +
        '<button class="pd-btn" id="ve-x">&times;</button></div>' +
      '<div class="ve-form">' +
        fld('VE No.', txt('ve_no', r.ve_no)) +
        fld('Discipline', sel('discipline', DISCIPLINES, r.discipline, true)) +
        fld('Element / work package', txt('element', r.element)) +
        '<label class="ve-fld ve-fld-wide"><span>Title</span>' +
          '<input class="pd-input" data-k="title" value="' + esc(r.title || '') + '" /></label>' +
        '<label class="ve-fld ve-fld-wide"><span>Proposal</span>' +
          '<textarea class="pd-input" data-k="description" rows="3">' + esc(r.description || '') + '</textarea></label>' +

        '<div class="ve-fld ve-fld-wide ve-sectlbl">Cost</div>' +
        fld('Baseline cost', txt('baseline_cost', r.baseline_cost, 'number', '0.01'), 'the design as tendered') +
        fld('Proposed cost', txt('proposed_cost', r.proposed_cost, 'number', '0.01'), 'the VE alternative') +
        fld('Actual cost', txt('actual_cost', r.actual_cost, 'number', '0.01'), 'leave blank until implemented') +
        '<div class="ve-fld ve-fld-wide ve-calc" id="ve-calc"></div>' +

        '<div class="ve-fld ve-fld-wide ve-sectlbl">Decision</div>' +
        fld('Status', sel('status', STATUS_ORDER, statusOf(r), true)) +
        fld('Decided by', txt('decision_by', r.decision_by)) +
        fld('Decision date', txt('decision_date', (r.decision_date || '').slice(0, 10), 'date')) +
        '<label class="ve-fld ve-fld-wide"><span>Reason (if rejected or held)</span>' +
          '<input class="pd-input" data-k="rejection_reason" value="' + esc(r.rejection_reason || '') + '" /></label>' +

        '<div class="ve-fld ve-fld-wide ve-sectlbl">Impact</div>' +
        fld('Schedule impact (days)', txt('schedule_impact_days', r.schedule_impact_days, 'number', '1'),
            'negative saves time, positive costs it') +
        fld('Quality impact', sel('quality_impact', QUALITY, r.quality_impact, true)) +
        fld('Priority', sel('priority', [1, 2, 3], r.priority, true)) +
        '<label class="ve-fld ve-fld-wide"><span>Risk notes</span>' +
          '<input class="pd-input" data-k="risk_notes" value="' + esc(r.risk_notes || '') + '" /></label>' +

        '<div class="ve-fld ve-fld-wide ve-sectlbl">Origin and ownership</div>' +
        fld('Raised by', txt('proposed_by', r.proposed_by)) +
        fld('Origin', sel('origin', ORIGINS, r.origin, true)) +
        fld('Date raised', txt('date_raised', (r.date_raised || '').slice(0, 10), 'date')) +
        fld('Responsible', txt('responsible', r.responsible)) +
        fld('Target date', txt('target_date', (r.target_date || '').slice(0, 10), 'date')) +
        '<label class="ve-fld ve-fld-wide"><span>Reference link</span>' +
          '<input class="pd-input" data-k="reference_link" value="' + esc(r.reference_link || '') + '" /></label>' +
        '<label class="ve-fld ve-fld-wide"><span>Remarks</span>' +
          '<input class="pd-input" data-k="remarks" value="' + esc(r.remarks || '') + '" /></label>' +
      '</div>' +
      '<div class="pd-modal-actions"><button class="pd-btn" id="ve-cancel">Cancel</button>' +
        '<button class="pd-btn pd-btn-primary" id="ve-save">Save</button></div>', { noBackdropClose: true });

    // Live saving preview — the whole point of the module, so it should not be
    // something the user has to do in their head while typing.
    function recalc() {
      function v(k) { var el = m.el.querySelector('[data-k="' + k + '"]'); return num(el && el.value); }
      var b = v('baseline_cost'), p = v('proposed_cost'), a = v('actual_cost');
      var pot = (b == null || p == null) ? null : b - p;
      var real = (b == null || a == null) ? null : b - a;
      m.el.querySelector('#ve-calc').innerHTML =
        '<span class="ve-calc-item"><small>Potential saving</small><strong class="' +
          (pot == null ? 've-mut' : pot < 0 ? 've-neg' : 've-pos') + '">' +
          (pot == null ? 'needs baseline + proposed' : esc(Fmt.money(pot))) + '</strong></span>' +
        '<span class="ve-calc-item"><small>Realised saving</small><strong class="' +
          (real == null ? 've-mut' : real < 0 ? 've-neg' : 've-pos') + '">' +
          (real == null ? 'needs an actual cost' : esc(Fmt.money(real))) + '</strong></span>';
    }
    ['baseline_cost', 'proposed_cost', 'actual_cost'].forEach(function (k) {
      m.el.querySelector('[data-k="' + k + '"]').addEventListener('input', recalc);
    });
    recalc();

    m.el.querySelector('#ve-x').onclick = m.close;
    m.el.querySelector('#ve-cancel').onclick = m.close;
    m.el.querySelector('#ve-save').onclick = async function () {
      var patch = {};
      m.el.querySelectorAll('[data-k]').forEach(function (el) {
        patch[el.dataset.k] = el.value === '' ? null : el.value;
      });
      ['baseline_cost', 'proposed_cost', 'actual_cost'].forEach(function (k) {
        patch[k] = patch[k] == null ? null : num(patch[k]);
      });
      ['priority', 'schedule_impact_days'].forEach(function (k) {
        patch[k] = patch[k] == null ? null : parseInt(patch[k], 10);
        if (isNaN(patch[k])) patch[k] = null;
      });
      if (!patch.title) { UI.toast('A title is required.', 'error'); return; }
      try {
        if (isNew) {
          patch.project_id = pid; patch.created_by = UID;
          var ins = await sb().from(TABLE).insert(patch).select().single();
          if (ins.error) throw ins.error;
          rows.push(ins.data);
        } else {
          var up = await sb().from(TABLE).update(patch).eq('id', r.id);
          if (up.error) throw up.error;
          Object.assign(r, patch);
        }
        m.close(); syncFilterOptions(); render();
        UI.toast(isNew ? 'Proposal added.' : 'Saved.');
      } catch (e) {
        // ⚠️ The approval guard (migration 0014) raises 42501 on a status move
        // into Approved / Endorsed / Implemented / Rejected by a non-planner.
        // Say what actually happened rather than printing a raw Postgres error.
        var msg = String(e.message || e);
        if (/42501|may not set status/.test(msg)) {
          UI.toast('Your role may not approve or reject a VE proposal — that needs planner or admin.', 'error');
        } else UI.toast('Save failed: ' + msg, 'error');
      }
    };
  }

  async function delRow(id) {
    var r = rows.find(function (x) { return String(x.id) === String(id); });
    if (!r) return;
    if (!confirm('Delete "' + (r.title || r.ve_no || 'this proposal') + '"?')) return;
    try {
      var res = await sb().from(TABLE).delete().eq('id', id);
      if (res.error) throw res.error;
      rows = rows.filter(function (x) { return String(x.id) !== String(id); });
      render(); UI.toast('Deleted.');
    } catch (e) { UI.toast('Delete failed: ' + (e.message || e), 'error'); }
  }

  async function clearAll() {
    if (!isAdmin) return;
    var m = UI.modal('<h2 style="margin-top:0;">Clear the VE list</h2>' +
      '<p>This deletes <strong>every</strong> proposal for <strong>' + esc(pid) + '</strong>.</p>' +
      '<p>Type the project id to confirm:</p><input class="pd-input" id="ve-confirm" />' +
      '<div class="pd-modal-actions"><button class="pd-btn" id="ve-cc">Cancel</button>' +
      '<button class="pd-btn pd-btn-danger" id="ve-cok">Delete all</button></div>', { noBackdropClose: true });
    m.el.querySelector('#ve-cc').onclick = m.close;
    m.el.querySelector('#ve-cok').onclick = async function () {
      if (m.el.querySelector('#ve-confirm').value.trim() !== pid) { UI.toast('Project id does not match.', 'error'); return; }
      try {
        var res = await sb().from(TABLE).delete().eq('project_id', pid);
        if (res.error) throw res.error;
        rows = []; m.close(); render(); UI.toast('VE list cleared.');
      } catch (e) { UI.toast('Clear failed: ' + (e.message || e), 'error'); }
    };
  }

  // ==========================================================================
  // Import — HEADER-MAPPED, because there is no known layout
  // ==========================================================================
  // ⚠️ Every sibling importer reads BY COLUMN INDEX and says so, because each was
  // written against one specific workbook. This one has no such workbook, so
  // index-reading would be a guess dressed up as a rule. Instead: normalise each
  // header, match it against a synonym table, SHOW the resulting mapping, and let
  // the user cancel. An unmapped column is reported, never silently dropped.
  var SYN = {
    ve_no: ['ve no', 've number', 've ref', 'ref', 'ref no', 'no', 'item no', 'code', 'id'],
    title: ['title', 've item', 'proposal', 'proposal title', 'description of proposal', 've description', 'item'],
    description: ['description', 'details', 'proposal details', 'scope', 'narrative', 'remarks on proposal'],
    discipline: ['discipline', 'trade', 'category', 'works', 'work type'],
    element: ['element', 'boq item', 'work package', 'package', 'system', 'component', 'location'],
    origin: ['origin', 'source', 'raised from', 'initiated by'],
    proposed_by: ['proposed by', 'raised by', 'originator', 'proponent', 'submitted by'],
    date_raised: ['date raised', 'date', 'raised on', 'date submitted', 'date proposed'],
    baseline_cost: ['baseline cost', 'baseline', 'original cost', 'current cost', 'tender cost', 'as tendered', 'budget', 'boq cost'],
    proposed_cost: ['proposed cost', 've cost', 'new cost', 'revised cost', 'alternative cost', 'proposed'],
    actual_cost: ['actual cost', 'final cost', 'implemented cost', 'actual'],
    status: ['status', 've status', 'decision', 'disposition'],
    decision_by: ['decided by', 'decision by', 'approved by', 'reviewed by'],
    decision_date: ['decision date', 'date decided', 'date approved', 'approval date'],
    rejection_reason: ['reason', 'rejection reason', 'reason for rejection', 'justification'],
    schedule_impact_days: ['schedule impact', 'schedule impact (days)', 'time impact', 'days', 'programme impact'],
    quality_impact: ['quality impact', 'quality', 'impact on quality'],
    risk_notes: ['risk', 'risks', 'risk notes', 'risk assessment'],
    priority: ['priority', 'pri'],
    responsible: ['responsible', 'owner', 'action by', 'assigned to'],
    target_date: ['target date', 'target', 'due date', 'required by'],
    reference_link: ['link', 'reference', 'reference link', 'document link', 'url'],
    remarks: ['remarks', 'notes', 'comment', 'comments']
  };
  function normHdr(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[‘’]/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();
  }
  // ⚠️ THE SYNONYM TABLE IS NORMALISED THROUGH normHdr TOO, once, at load.
  // Headers are normalised before comparison, so a synonym written with any
  // punctuation — "schedule impact (days)", "progress %" — could NEVER match its
  // own column: the header arrived as "schedule impact days" and the literal
  // still carried its brackets. It failed silently, dropping the column into
  // `unmapped` as though the sheet had not carried it at all. Caught by the
  // harness, not by reading. Normalising both sides makes the table safe to
  // extend with whatever a real heading actually looks like.
  var SYN_N = {};
  Object.keys(SYN).forEach(function (f) {
    SYN_N[f] = SYN[f].map(normHdr).filter(Boolean);
  });

  // ⚠️ First match wins, and SYN is walked in declaration order — so a sheet with
  // both "Description" and "Proposal Title" maps each to its own field rather
  // than letting the looser synonym swallow the tighter one.
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
        // ⚠️ FORMATTED TEXT (cell.w), never the raw value. SheetJS returns the
        // cell displaying 06-Aug-26 as 2026-08-05T15:59:17Z, so local getters
        // land a day out east of Greenwich — the trap all three sibling
        // registers document.
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
  // Excel's zero date (1899-12-30 / 1900-01-00) is a sentinel, not a date — the
  // same class of value the sibling registers guard against.
  function realDate(d) {
    if (!d) return null;
    var y = +String(d).slice(0, 4);
    return (y < 2015 || y > 2100) ? null : d;
  }
  // ⚠️ Accounting negatives are parenthesised, and Philippine sheets carry ₱ and
  // thousands separators. Stripping only the currency symbol turns "(1,200)"
  // into 1200 — the wrong sign on a cost variance.
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
  function normStatus(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s || s === '-') return null;
    var lo = s.toLowerCase();
    for (var i = 0; i < STATUS_ORDER.length; i++) {
      if (STATUS_ORDER[i].toLowerCase() === lo) return STATUS_ORDER[i];
    }
    if (/implement/.test(lo)) return 'Implemented';
    if (/endors|recommend/.test(lo)) return 'Endorsed';
    if (/approv|accept/.test(lo)) return 'Approved';
    if (/reject|declin|not accept|disapprov/.test(lo)) return 'Rejected';
    if (/hold|defer|park/.test(lo)) return 'On Hold';
    if (/review|evaluat|assess/.test(lo)) return 'Under Review';
    if (/propos|new|open|idea/.test(lo)) return 'Proposed';
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
    // Locate the header row: the first row within the first 30 whose headers map
    // to a title AND at least one cost column. Requiring both is what stops a
    // decorative banner row ("VALUE ENGINEERING LIST") being read as headers.
    var best = null;
    for (var i = 0; i < Math.min(g.length, 30); i++) {
      var m = mapHeaders(g[i]);
      var hasCost = m.map.baseline_cost != null || m.map.proposed_cost != null;
      if (m.map.title != null && hasCost) { best = { hdr: i, m: m }; break; }
    }
    if (!best) return null;
    var map = best.m.map, recs = [], order = 0;
    for (var r = best.hdr + 1; r < g.length; r++) {
      var row = g[r];
      var title = map.title != null ? String(row[map.title] || '').trim() : '';
      // A row counts when it has a title OR a cost pair — the material-submittal
      // lesson: requiring the title alone silently dropped a fully costed row.
      var anyCost = parseMoney(row[map.baseline_cost]) != null || parseMoney(row[map.proposed_cost]) != null;
      if (!title && !anyCost) continue;
      // Stop at a sign-off block, which otherwise imports as proposals.
      if (/^(prepared|checked|reviewed|approved|noted)\s+(and\s+checked\s+)?by/i.test(title)) break;
      function cell(k) { return map[k] == null ? '' : row[map[k]]; }
      recs.push({
        ve_no: String(cell('ve_no') || '').trim() || null,
        title: title || null,
        description: String(cell('description') || '').trim() || null,
        discipline: pick(DISCIPLINES, cell('discipline')),
        element: String(cell('element') || '').trim() || null,
        origin: pick(ORIGINS, cell('origin')),
        proposed_by: String(cell('proposed_by') || '').trim() || null,
        date_raised: realDate(parseDate(cell('date_raised'))),
        baseline_cost: parseMoney(cell('baseline_cost')),
        proposed_cost: parseMoney(cell('proposed_cost')),
        actual_cost: parseMoney(cell('actual_cost')),
        status: normStatus(cell('status')),
        decision_by: String(cell('decision_by') || '').trim() || null,
        decision_date: realDate(parseDate(cell('decision_date'))),
        rejection_reason: String(cell('rejection_reason') || '').trim() || null,
        schedule_impact_days: (function (v) {
          var n = parseInt(String(v == null ? '' : v).replace(/[^\d\-]/g, ''), 10);
          return isNaN(n) ? null : n;
        })(cell('schedule_impact_days')),
        quality_impact: pick(QUALITY, cell('quality_impact')),
        risk_notes: String(cell('risk_notes') || '').trim() || null,
        priority: /^[123]$/.test(String(cell('priority') || '').trim()) ? +cell('priority') : null,
        responsible: String(cell('responsible') || '').trim() || null,
        target_date: realDate(parseDate(cell('target_date'))),
        reference_link: (String(cell('reference_link') || '').trim().indexOf('http') === 0)
          ? String(cell('reference_link')).trim() : null,
        remarks: String(cell('remarks') || '').trim() || null,
        sort_order: order++
      });
    }
    return { hdr: best.hdr, map: map, unmapped: best.m.unmapped, records: recs };
  }

  function parseWorkbook(wb) {
    var best = null;
    wb.SheetNames.forEach(function (nm) {
      var got = parseSheet(gridOf(wb.Sheets[nm]));
      if (got && got.records.length && (!best || got.records.length > best.records.length)) {
        best = { sheet: nm, hdr: got.hdr, map: got.map, unmapped: got.unmapped, records: got.records };
      }
    });
    return best;
  }

  async function onFile(e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    var m = UI.modal('<h2 style="margin-top:0;">Import VE list</h2><p id="ve-imp-msg">Reading…</p>',
      { noBackdropClose: true });
    var msg = m.el.querySelector('#ve-imp-msg');
    try {
      var buf = await f.arrayBuffer();
      var wb = XLSX.read(buf, { type: 'array', cellDates: false, sheetRows: 4000 });
      var got = parseWorkbook(wb);
      if (!got) {
        msg.innerHTML = 'No usable header row found. The importer looks for a row carrying a ' +
          '<strong>title</strong> column and at least one <strong>cost</strong> column ' +
          '(baseline / proposed). Rename your headings or add the proposals by hand.';
        return;
      }
      // ⚠️ SHOW the mapping before writing anything. Header matching is a guess
      // by nature; a silent guess that lands a cost in the wrong column produces
      // a register that looks right and is wrong.
      var mapped = Object.keys(got.map).sort().map(function (k) {
        return '<li><code>' + esc(k) + '</code> ← column ' +
          esc(XLSX.utils.encode_col(got.map[k])) + '</li>';
      }).join('');
      msg.innerHTML = 'Sheet <strong>' + esc(got.sheet) + '</strong>, headers on row ' +
        (got.hdr + 1) + ' — <strong>' + got.records.length + '</strong> proposals.' +
        '<div class="ve-impmap"><strong>Detected mapping</strong><ul>' + mapped + '</ul>' +
        (got.unmapped.length ? '<p class="ve-mut"><strong>Ignored columns:</strong> ' +
          esc(got.unmapped.join(', ')) + '</p>' : '') + '</div>' +
        '<label style="display:block;margin-top:12px;"><input type="checkbox" id="ve-imp-replace" checked /> ' +
        'Replace the existing VE list for this project</label>' +
        '<div class="pd-modal-actions"><button class="pd-btn" id="ve-imp-cancel">Cancel</button>' +
        '<button class="pd-btn pd-btn-primary" id="ve-imp-go">Import</button></div>';
      m.el.querySelector('#ve-imp-cancel').onclick = m.close;
      m.el.querySelector('#ve-imp-go').onclick = async function () {
        var replace = m.el.querySelector('#ve-imp-replace').checked;
        msg.textContent = 'Importing…';
        try {
          if (replace) {
            var d = await sb().from(TABLE).delete().eq('project_id', pid);
            if (d.error) throw d.error;
          }
          // ⚠️ Give every object the SAME key set. PostgREST bulk-inserts an
          // array by taking the UNION of its keys and sends NULL for any a row
          // omits — it does NOT fall back to the column DEFAULT. A ragged
          // payload therefore depends on which columns happen to be nullable,
          // which is how the Method Register import failed its first run.
          var keys = {};
          got.records.forEach(function (r) { Object.keys(r).forEach(function (k) { keys[k] = 1; }); });
          var allKeys = Object.keys(keys);
          var payload = got.records.map(function (r) {
            var o = { project_id: pid, created_by: UID };
            allKeys.forEach(function (k) { o[k] = r[k] === undefined ? null : r[k]; });
            return o;
          });
          for (var i = 0; i < payload.length; i += 200) {
            var res = await sb().from(TABLE).insert(payload.slice(i, i + 200));
            if (res.error) throw res.error;
            msg.textContent = 'Importing… ' + Math.min(i + 200, payload.length) + ' / ' + payload.length;
            await new Promise(function (r2) { setTimeout(r2, 0); });
          }
          m.close(); UI.toast('Imported ' + got.records.length + ' proposals.');
          await load();
        } catch (err) { msg.textContent = 'Import failed: ' + (err.message || err); }
      };
    } catch (err) { msg.textContent = 'Could not read the workbook: ' + (err.message || err); }
  }

  // ---- export --------------------------------------------------------------
  function exportExcel() {
    var T = stats(rows);
    var sum = groupBy('discipline').map(function (g) {
      return { Discipline: g.key, Items: g.st.count, Open: g.st.open, Approved: g.st.won,
        Rejected: g.st.rejected, 'Pipeline saving': g.st.pipeline,
        'Approved saving': g.st.approved, 'Realised saving': g.st.realised,
        'Acceptance rate': g.st.acceptance };
    });
    sum.push({ Discipline: 'TOTAL', Items: T.count, Open: T.open, Approved: T.won,
      Rejected: T.rejected, 'Pipeline saving': T.pipeline, 'Approved saving': T.approved,
      'Realised saving': T.realised, 'Acceptance rate': T.acceptance });

    var reg = rows.map(function (r) {
      return { 'VE No.': r.ve_no || '', Title: r.title || '', Proposal: r.description || '',
        Discipline: r.discipline || '', Element: r.element || '',
        'Baseline cost': num(r.baseline_cost), 'Proposed cost': num(r.proposed_cost),
        'Potential saving': savingOf(r), 'Actual cost': num(r.actual_cost),
        'Realised saving': realisedOf(r),
        'Schedule impact (days)': num(r.schedule_impact_days),
        'Quality impact': r.quality_impact || '', Status: statusOf(r),
        Priority: r.priority || '', 'Raised by': r.proposed_by || '', Origin: r.origin || '',
        'Date raised': r.date_raised || '', 'Decided by': r.decision_by || '',
        'Decision date': r.decision_date || '', Reason: r.rejection_reason || '',
        Risk: r.risk_notes || '', Responsible: r.responsible || '',
        'Target date': r.target_date || '', Reference: r.reference_link || '',
        Remarks: r.remarks || '' };
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sum), 'SUMMARY');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reg), 'VE List');
    XLSX.writeFile(wb, 'Value Engineering List - ' + (projName() || pid) + '.xlsx');
  }
  function projName() {
    var s = document.getElementById('ve-project');
    return s && s.selectedIndex >= 0 ? s.options[s.selectedIndex].textContent : '';
  }

  // ==========================================================================
  // Shell
  // ==========================================================================
  function switchTab(v) {
    view = v;
    document.querySelectorAll('.ve-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.view === v);
    });
    render();
  }
  function syncClearFilt() {
    var b = document.getElementById('ve-f-clear');
    if (b) b.hidden = !anyFilter();
  }
  function syncFilterOptions() {
    // Offer only the values actually present, plus whatever is currently
    // filtered on, so the list never advertises an empty result.
    var present = {};
    rows.forEach(function (r) { if (r.discipline) present[r.discipline] = 1; });
    var list = DISCIPLINES.filter(function (d) { return present[d]; })
      .concat(Object.keys(present).filter(function (d) { return DISCIPLINES.indexOf(d) === -1; }).sort());
    var d = document.getElementById('ve-f-discipline');
    d.innerHTML = '<option value="">All disciplines</option>' +
      list.map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + '</option>'; }).join('');
    setSel('ve-f-discipline', filters.discipline);

    var s = document.getElementById('ve-f-status');
    s.innerHTML = '<option value="">All statuses</option>' +
      STATUS_ORDER.map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('');
    setSel('ve-f-status', filters.status);

    var q = document.getElementById('ve-f-quality');
    q.innerHTML = '<option value="">Any quality impact</option>' +
      QUALITY.map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('');
    setSel('ve-f-quality', filters.quality);
  }

  async function init(user, profile) {
    UID = (user && user.id) || (profile && profile.id) || null;
    isAdmin = !!(profile && (profile.role === 'admin' || profile.role === 'super_admin'));
    canWrite = !!(profile && ['super_admin', 'admin', 'planner', 'user'].indexOf(profile.role) !== -1);
    UI.initShell();

    document.getElementById('ve-clear').style.display = isAdmin ? '' : 'none';
    if (!canWrite) {
      ['ve-add', 've-import'].forEach(function (id) { var b = document.getElementById(id); if (b) b.style.display = 'none'; });
    }

    var selEl = document.getElementById('ve-project');
    try { projects = (await PDb.getProjects()) || []; } catch (e) { projects = []; }
    projects = projects.filter(function (p) { return !AppAuth.canAccessProject || AppAuth.canAccessProject(profile, p.id); });
    selEl.innerHTML = projects.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.name || p.id) + '</option>';
    }).join('');
    // ⚠️ NEVER fall back to projects[0] — a <select> with no explicit value
    // reports its FIRST OPTION, so a missing or stale id silently becomes
    // "whichever project sorts first". Project-first, same rule as the shell and
    // all three sibling modules.
    var stored = sessionStorage.getItem('pd_project');
    var ok = stored && projects.some(function (p) { return String(p.id) === String(stored); });
    // ⚠️ location.replace() does NOT halt the running script — return as well,
    // or the rest of init wires handlers against a null pid.
    if (!ok) { location.replace('../../projects.html'); return; }
    selEl.value = stored;
    pid = stored;
    if (UI.enhanceProjectSelect) UI.enhanceProjectSelect(selEl);
    selEl.addEventListener('change', function () {
      pid = selEl.value;
      sessionStorage.setItem('pd_project', pid);
      filters = { q: '', discipline: '', status: '', quality: '', hideRejected: false };
      document.getElementById('ve-f-search').value = '';
      document.getElementById('ve-f-hiderej').checked = false;
      load();
    });

    document.querySelectorAll('.ve-tab').forEach(function (t) {
      t.onclick = function () { switchTab(t.dataset.view); };
    });
    document.getElementById('ve-add').onclick = function () { openForm(null); };
    document.getElementById('ve-import').onclick = function () { document.getElementById('ve-file').click(); };
    document.getElementById('ve-file').addEventListener('change', onFile);
    document.getElementById('ve-export').onclick = exportExcel;
    document.getElementById('ve-print').onclick = function () { setTimeout(function () { window.print(); }, 60); };
    document.getElementById('ve-clear').onclick = clearAll;

    var q = document.getElementById('ve-f-search'), tmr = null;
    q.addEventListener('input', function () {
      clearTimeout(tmr);
      tmr = setTimeout(function () { filters.q = q.value; render(); }, 160);
    });
    document.getElementById('ve-f-discipline').addEventListener('change', function (e) { filters.discipline = e.target.value; render(); });
    document.getElementById('ve-f-status').addEventListener('change', function (e) { filters.status = e.target.value; render(); });
    document.getElementById('ve-f-quality').addEventListener('change', function (e) { filters.quality = e.target.value; render(); });
    document.getElementById('ve-f-hiderej').addEventListener('change', function (e) { filters.hideRejected = e.target.checked; render(); });
    document.getElementById('ve-f-clear').onclick = function () {
      filters = { q: '', discipline: '', status: '', quality: '', hideRejected: false };
      q.value = '';
      ['ve-f-discipline', 've-f-status', 've-f-quality'].forEach(function (id) { document.getElementById(id).value = ''; });
      document.getElementById('ve-f-hiderej').checked = false;
      render();
    };

    await load();
  }

  return {
    init: init,
    // Exposed so a verification harness runs the SHIPPED functions rather than a
    // reimplementation of them — the arrangement all three sibling registers use.
    _internals: { stats: stats, groupBy: groupBy, savingOf: savingOf, realisedOf: realisedOf,
      parseWorkbook: parseWorkbook, parseSheet: parseSheet, mapHeaders: mapHeaders,
      normHdr: normHdr, parseDate: parseDate, realDate: realDate, parseMoney: parseMoney,
      normStatus: normStatus, pick: pick, matches: matches, headCells: headCells,
      render: render, switchTab: switchTab,
      setRows: function (x) { rows = x; }, setPid: function (x) { pid = x; },
      setCanWrite: function (x) { canWrite = x; },
      STATUSES: STATUSES, DISCIPLINES: DISCIPLINES, QUALITY: QUALITY, SYN: SYN }
  };
})();
