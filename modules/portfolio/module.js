/* Portfolio — modules/portfolio/module.js

   A cross-project rollup of engineering delivery: a high-level Gantt of every
   project's design programme, and ISD status. Patterned on planning-app's
   `portfolio-overview`, which is the same idea for the planning side.

   ⚠️⚠️ THIS IS THE SECOND ORG-WIDE MODULE (after Initiatives), and org-wide inverts
   most of the project-scoping rules in the root CLAUDE.md. All three halves must
   agree or the shell and the module contradict each other:
     1. `orgWide: true` in config.js, so nav does NOT gate it. Gating it would make
        it UNREACHABLE FROM A COLD START — the only way to clear the gate is to
        choose a project, which this module does not need.
     2. It MUST NOT redirect to projects.html from init(). It is meaningful with
        nothing selected; that is the whole point.
     3. It reads `drawing_register` with NO project predicate and lets RLS scope it.
        A `user` assigned to one project gets a one-project portfolio, and no code
        here decides that.
   Unlike Initiatives this module owns NO TABLE, so it needs no migration and none
   of the `can_access_project(NULL)` care that 0015 documents.

   ⚠️ THE MATHS LIVES IN EngData.portfolio(), NOT HERE. `engdata.js` is the
   shell-owned cross-module read model and already carries the drawing-status
   vocabulary shared with the register; putting the aggregation there keeps one
   definition of "approved" rather than a second one in a dashboard.

   ⚠️ TWO COUNTING BASES, NEVER ADDED TOGETHER. ISD is counted in SHEETS (partial
   credit) and matches the register exactly. Design levels are counted in DRAWINGS
   here, while the register's own Overview counts them in TRACKING UNITS — a
   Technical Officer's designation that needs the whole level tree. Those bases
   legitimately differ, so every figure states which one it is and the page says so
   in a note. Do NOT introduce a blended "overall %": it would describe neither. */
window.Portfolio = (function () {
  'use strict';

  var esc = function (s) { return Fmt.esc(s == null ? '' : String(s)); };
  function ico(name, size) { return (window.Icons && Icons.svg) ? Icons.svg(name, size || 15) : ''; }

  var projects = [], data = null, loadErr = null;
  var sel = {};                 // project_id -> true; empty = all
  var view = 'overview';
  var sort = { col: 'name', dir: 1 };

  // ---- group heads ---------------------------------------------------------
  // ⚠️ A GROUP HEAD IS HOW THIS PORTFOLIO IS ORGANISED, so it is a first-class
  // dimension here and not just a column. A group head owns a set of projects and is
  // accountable for them, so "how is Ronquillo Group's engineering doing?" is the
  // question a portfolio exists to answer — a flat list of 20 projects answers nobody.
  // Group heads are READ-ONLY here: authored in the Planners Dashboard and mirrored in
  // (0009/0011), which is also why the order comes from their own `sort_order` rather
  // than being re-sorted alphabetically.
  var GH = [], ghById = {}, ghRank = {};
  var NO_GH = '__nogh__';
  var groupBy = 'grouphead';    // 'grouphead' | 'none'

  function ghIdOf(pidKey) {
    var p = projects.find(function (x) { return String(x.id) === String(pidKey); });
    return (p && p.group_head_id) || NO_GH;
  }
  function ghLabel(id) {
    if (id === NO_GH) return '— No group head —';
    var g = ghById[id];
    return (g && g.name) || id;
  }
  // Ordered [ghId, projects[]] pairs. Unassigned last; a group head this app has not
  // synced yet sorts after the known ones rather than jumping ahead on an undefined.
  function byGroupHead(list) {
    var m = {}, order = [];
    list.forEach(function (p) {
      var k = ghIdOf(p.project_id);
      if (!m[k]) { m[k] = []; order.push(k); }
      m[k].push(p);
    });
    order.sort(function (a, b) {
      if (a === NO_GH) return 1;
      if (b === NO_GH) return -1;
      var ra = ghRank[a], rb = ghRank[b];
      if (ra == null && rb == null) return ghLabel(a).localeCompare(ghLabel(b));
      if (ra == null) return 1;
      if (rb == null) return -1;
      return ra - rb || ghLabel(a).localeCompare(ghLabel(b));
    });
    return order.map(function (k) { return [k, m[k]]; });
  }

  var MNAME = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // ⚠️ Integer maths on the ISO string. Never `new Date(iso)` + local getters — the
  // trap documented repeatedly in the drawing register: a local constructor read back
  // with a UTC getter names the previous day everywhere east of Greenwich.
  function fmtDate(s) {
    if (!s) return '';
    var p = String(s).slice(0, 10).split('-');
    if (p.length !== 3 || isNaN(+p[0])) return String(s);
    return String(+p[2]).padStart(2, '0') + ' ' + MNAME[+p[1] - 1] + ' ' + p[0];
  }
  function fmtMonth(s) {
    var p = String(s).slice(0, 10).split('-');
    return MNAME[+p[1] - 1] + " '" + String(p[0]).slice(2);
  }
  function daysBetween(a, b) {
    var x = String(a).slice(0, 10).split('-'), y = String(b).slice(0, 10).split('-');
    return Math.round((Date.UTC(+y[0], +y[1] - 1, +y[2]) - Date.UTC(+x[0], +x[1] - 1, +x[2])) / 86400000);
  }
  function addDays(iso, n) {
    var p = String(iso).slice(0, 10).split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
    return d.toISOString().slice(0, 10);          // safe: built in UTC, read in UTC
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }

  function projName(id) {
    var p = projects.find(function (x) { return String(x.id) === String(id); });
    return (p && (p.name || p.id)) || id;
  }
  function scoped() {
    if (!data) return [];
    var keys = Object.keys(sel);
    var list = data.projects;
    if (keys.length) list = list.filter(function (p) { return sel[p.project_id]; });
    // A row for a project the user can no longer see (or that was pruned upstream)
    // is dropped rather than rendered as an id with no name.
    return list.filter(function (p) {
      return projects.some(function (x) { return String(x.id) === String(p.project_id); });
    });
  }

  // ---- render --------------------------------------------------------------
  function render() {
    var host = document.getElementById('pf-view');
    if (loadErr) {
      host.innerHTML = '<div class="pd-card pf-empty"><h3>Could not load the portfolio</h3>' +
        '<p>' + esc(loadErr) + '</p></div>';
      return;
    }
    if (!data) { host.innerHTML = skeletonHTML(); return; }
    syncFilterChip();
    if (view === 'gantt') renderGantt();
    else if (view === 'isd') renderISD();
    else renderOverview();
  }

  function skeletonHTML() {
    var r = '';
    for (var i = 0; i < 7; i++) r += '<div class="pf-sk-row"></div>';
    return '<div class="pd-card pf-skcard" aria-busy="true">' +
      '<div class="pf-sk-head"><span class="pf-sk-spin"></span>Reading every project you can access…</div>' +
      r + '</div>';
  }

  function kpi(v, label, sub, tone) {
    return '<div class="pd-card pf-kpi' + (tone ? ' ' + tone : '') + '">' +
      '<div class="pf-kpi-v">' + v + '</div><div class="pf-kpi-l">' + esc(label) + '</div>' +
      (sub ? '<div class="pf-kpi-s">' + sub + '</div>' : '') + '</div>';
  }

  function totals(list) {
    var t = { projects: list.length, drawings: 0, sheets: 0, approvedSheets: 0,
      designDrawings: 0, designApproved: 0, overdue: 0, isdSheets: 0, isdApproved: 0,
      withIsd: 0, dated: 0 };
    list.forEach(function (p) {
      t.drawings += p.drawings; t.sheets += p.sheets; t.approvedSheets += p.approvedSheets;
      t.designDrawings += p.designDrawings; t.designApproved += p.designApproved;
      t.overdue += p.overdue;
      if (p.isd) { t.withIsd++; t.isdSheets += p.isd.sheets; t.isdApproved += p.isd.approvedSheets; }
      if (p.minPlanned || p.maxActual) t.dated++;
    });
    t.pctDesign = t.designDrawings ? Math.round(t.designApproved / t.designDrawings * 100) : 0;
    t.pctIsd = t.isdSheets ? Math.round(t.isdApproved / t.isdSheets * 100) : 0;
    return t;
  }

  function renderOverview() {
    var list = scoped();
    var host = document.getElementById('pf-view');
    if (!list.length) { host.innerHTML = emptyHTML(); return; }
    var t = totals(list);

    var kpis =
      kpi(t.projects, 'Projects', 'with a drawing register') +
      kpi(t.drawings.toLocaleString(), 'Drawings', t.sheets.toLocaleString() + ' sheets') +
      // ⚠️ Two percentages, side by side, each labelled with its basis — never one
      // blended figure. See the file header.
      kpi(t.pctDesign + '%', 'Design approved', t.designApproved.toLocaleString() + ' / ' +
          t.designDrawings.toLocaleString() + ' drawings') +
      kpi(t.pctIsd + '%', 'ISD approved', t.isdApproved.toLocaleString() + ' / ' +
          t.isdSheets.toLocaleString() + ' sheets') +
      kpi(t.overdue.toLocaleString(), 'Overdue drawings', 'past their planned approval',
          t.overdue ? 'pf-kpi-bad' : 'pf-kpi-ok');

    host.innerHTML =
      '<div class="pf-eyebrow">ENGINEERING PORTFOLIO — ' + list.length + ' PROJECT' + (list.length > 1 ? 'S' : '') + '</div>' +
      '<div class="pf-kpis">' + kpis + '</div>' +
      '<div class="pd-card"><h3>Approvals over time <span class="pf-mut">— due vs achieved, ' +
        'and the gap between them</span></h3>' + sCurveHTML(list) + '</div>' +
      '<div class="pf-grid2">' +
        '<div class="pd-card"><h3>Drawings by status</h3>' + donutHTML(list) + '</div>' +
        '<div class="pd-card"><h3>Open drawings by age <span class="pf-mut">— against their ' +
          'planned approval</span></h3>' + agingHTML(list) + '</div>' +
      '</div>' +
      '<div class="pd-card"><h3>Where to look first</h3>' + topListsHTML(list) + '</div>' +
      '<div class="pd-card"><h3>High-level programme <span class="pf-mut">— one lane per project</span></h3>' +
        ganttHTML(list, { compact: true }) + '</div>' +
      '<div class="pd-card pf-tblcard"><h3>By project</h3>' + tableHTML(list) + '</div>' +
      basisNoteHTML();
    wireTable(host);
    wireGantt(host);
    wirePeriod(host);
  }

  // ---- the high-level Gantt ------------------------------------------------
  // ⚠️ GEOMETRY IS PERCENT, NOT PIXELS — the same decision the register's Overview
  // Gantt made, and for the same reason: it is responsive with no resize observer,
  // no zoom control and no scroll sync. Do not give the track a fixed width. (The
  // register's *Registry* Gantt uses pixels only because its lanes must align with
  // grid rows scrolling beside it; nothing aligns with these.)
  function spanOf(p) {
    var s = p.minPlanned, f = p.maxPlanned;
    // An actual approval later than every planned date still has to fit on the bar,
    // or a project that overran would draw as though it finished on time.
    if (p.maxActual && (!f || p.maxActual > f)) f = p.maxActual;
    if (!s && p.maxActual) s = p.maxActual;
    if (!s || !f) return null;
    if (f < s) f = s;
    return { s: s, f: f };
  }

  function ganttHTML(list, opts) {
    opts = opts || {};
    var spans = list.map(spanOf);
    var min = null, max = null;
    spans.forEach(function (sp) {
      if (!sp) return;
      if (!min || sp.s < min) min = sp.s;
      if (!max || sp.f > max) max = sp.f;
    });
    var today = todayISO();
    if (!min || !max) {
      // No dates anywhere still draws a REAL timeline around today rather than an
      // empty-state card — the pane is furniture someone is about to fill.
      min = addDays(today, -60); max = addDays(today, 120);
    } else {
      min = addDays(min, -14); max = addDays(max, 14);
      // Today must be on the ruler or the "now" line has nowhere to sit.
      if (today < min) min = addDays(today, -14);
      if (today > max) max = addDays(today, 14);
    }
    var total = Math.max(1, daysBetween(min, max));
    var pct = function (iso) { return (daysBetween(min, iso) / total) * 100; };

    // Tick unit chosen from the span so the ruler never degenerates into
    // unreadable repetition — months for a short programme, quarters, then years.
    var months = Math.max(1, Math.round(total / 30));
    var unit = months <= 18 ? 'month' : (months <= 60 ? 'quarter' : 'year');
    var ticks = '', cur = String(min).slice(0, 8) + '01';
    var guard = 0;
    while (cur <= max && guard++ < 400) {
      var p = cur.split('-'), y = +p[0], mo = +p[1];
      var show = unit === 'month' || (unit === 'quarter' ? (mo - 1) % 3 === 0 : mo === 1);
      if (show && cur >= min) {
        ticks += '<div class="pf-g-tick" style="left:' + pct(cur).toFixed(3) + '%">' +
          '<span>' + esc(unit === 'year' ? String(y) : fmtMonth(cur)) + '</span></div>';
      }
      mo++; if (mo > 12) { mo = 1; y++; }
      cur = y + '-' + String(mo).padStart(2, '0') + '-01';
    }
    // ⚠⚠ THE TODAY LINE MUST NOT LIVE IN THE RULER. It used to be an absolutely
    // positioned child of `.pf-g-ruler` (16px tall) stretched with `bottom:-9999px` to
    // reach down over the lanes. That is ~10,000px of real overflow: the page grew a
    // giant empty scroll region with a single red line running through it, which is
    // exactly what it looked like. It now sits in `.pf-g-nowwrap`, an overlay pinned to
    // the lane column INSIDE `.pf-g-canvas`, so it spans the ruler and the lanes and
    // nothing else. Never give it a negative offset again.
    var nowLine = (today >= min && today <= max)
      ? '<div class="pf-g-nowwrap"><div class="pf-g-now" style="left:' +
        pct(today).toFixed(3) + '%" title="Today"></div></div>' : '';

    // ⚠️ ONE SHARED TIMELINE ACROSS EVERY GROUP HEAD, always. The min/max above
    // are computed from the whole list before any grouping, so a bar under one group
    // head is directly comparable with a bar under another. Giving each group its own
    // scale would make two bars of identical length mean different durations — which
    // is the one thing a portfolio Gantt must never do.
    var idxOf = {};
    list.forEach(function (p, i) { idxOf[p.project_id] = i; });
    function laneHTML(p) {
      var sp = spans[idxOf[p.project_id]];
      var basis = p.isd && !p.designDrawings ? 'sheets' : 'drawings';
      var shown = basis === 'sheets' ? p.pctSheets : p.pctDesign;
      var label = '<button class="pf-g-lbl" data-drill="' + esc(p.project_id) + '" ' +
        'title="Open this project\'s Drawing Register">' + esc(projName(p.project_id)) + '</button>';
      if (!sp) {
        // ⚠️ A project with no dates still gets a lane AND SAYS WHY. A blank track
        // reads as a rendering failure, where a dateless register is a real and
        // actionable state.
        return '<div class="pf-g-row">' + label +
          '<div class="pf-g-track"><span class="pf-g-none">' +
          (p.drawings ? 'No planned or actual approval dates yet' : 'No drawings yet') +
          '</span></div><div class="pf-g-pct">—</div></div>';
      }
      var left = pct(sp.s), w = Math.max(pct(sp.f) - left, 0.6);
      var late = p.overdue > 0;
      return '<div class="pf-g-row">' + label +
        '<div class="pf-g-track">' +
          '<div class="pf-g-bar' + (late ? ' pf-g-late' : '') + '" style="left:' + left.toFixed(3) +
            '%;width:' + w.toFixed(3) + '%" title="' +
            esc(projName(p.project_id) + ' · ' + fmtDate(sp.s) + ' → ' + fmtDate(sp.f) +
                ' · ' + shown + '% approved (' + basis + ')' +
                (p.overdue ? ' · ' + p.overdue + ' overdue' : '')) + '">' +
            '<div class="pf-g-fill" style="width:' + shown + '%"></div>' +
            (w > 8 ? '<span class="pf-g-in">' + shown + '%</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="pf-g-pct">' + shown + '%<span class="pf-g-basis">' + basis + '</span></div></div>';
    }

    var lanes;
    if (groupBy === 'grouphead') {
      lanes = byGroupHead(list).map(function (g) {
        var t = totals(g[1]);
        // The group's own headline sits on its header, so a group head can read one
        // line and know where their portfolio stands without adding up lanes.
        return '<div class="pf-g-gh"><span class="pf-g-ghn">' + esc(ghLabel(g[0])) +
            '<span class="pf-count-chip">' + g[1].length + '</span></span>' +
            '<span class="pf-g-ghm">' +
              (t.designDrawings ? t.pctDesign + '% design' : '') +
              (t.designDrawings && t.isdSheets ? ' \u00b7 ' : '') +
              (t.isdSheets ? t.pctIsd + '% ISD' : '') +
              (t.overdue ? ' \u00b7 <span class="pf-late">' + t.overdue + ' overdue</span>' : '') +
            '</span></div>' +
          g[1].map(laneHTML).join('');
      }).join('');
    } else {
      lanes = list.map(laneHTML).join('');
    }

    return '<div class="pf-gantt' + (opts.compact ? ' pf-gantt-c' : '') + '">' +
      // `.pf-g-canvas` is the positioning context for the today line: it wraps the ruler
      // and every lane, so an overlay pinned to top:0/bottom:0 covers exactly them.
      '<div class="pf-g-canvas">' +
        '<div class="pf-g-head"><span class="pf-g-lblsp"></span>' +
          '<div class="pf-g-ruler">' + ticks + '</div><span class="pf-g-pctsp"></span></div>' +
        lanes + nowLine +
      '</div>' +
      '<div class="pf-g-foot">' + esc(fmtDate(min)) + ' → ' + esc(fmtDate(max)) +
        ' · the bar spans earliest planned to latest planned/actual approval; the fill is progress' +
      '</div></div>';
  }

  function renderGantt() {
    var list = scoped();
    var host = document.getElementById('pf-view');
    if (!list.length) { host.innerHTML = emptyHTML(); return; }
    // Sorted by start so the programme reads as a programme, not as an alphabet.
    var sorted = list.slice().sort(function (a, b) {
      var sa = spanOf(a), sb2 = spanOf(b);
      if (!sa && !sb2) return projName(a.project_id).localeCompare(projName(b.project_id));
      if (!sa) return 1;
      if (!sb2) return -1;
      return sa.s.localeCompare(sb2.s) || sa.f.localeCompare(sb2.f);
    });
    host.innerHTML =
      '<div class="pf-eyebrow">HIGH-LEVEL PROGRAMME — EARLIEST START FIRST</div>' +
      '<div class="pd-card">' + ganttHTML(sorted, {}) + '</div>' +
      '<div class="pd-card pf-tblcard"><h3>Per project, per drawing type</h3>' + levelTableHTML(sorted) + '</div>' +
      basisNoteHTML();
    wireGantt(host);
    wireTable(host);
  }

  // ---- ISD ----------------------------------------------------------------
  // ⚠️ ISD IS THE ONE LEVEL WHOSE BASIS MATCHES THE REGISTER EXACTLY (partial sheet
  // credit), which is why it gets its own screen and why every figure here is in
  // sheets. Do not "harmonise" it with the drawing-count basis used for design.
  function renderISD() {
    var list = scoped().filter(function (p) { return p.isd; });
    var host = document.getElementById('pf-view');
    if (!list.length) {
      host.innerHTML = '<div class="pd-card pf-empty"><h3>No Individual Services Drawings</h3>' +
        '<p>None of the projects you can see has an <strong>Individual Services Drawings</strong> ' +
        'top level in its register. ISD is one of the five fixed top levels — if a project should ' +
        'have one, import or build it in that project\'s Drawing Register.</p></div>';
      return;
    }
    var tSheets = 0, tAppr = 0, tOver = 0;
    list.forEach(function (p) { tSheets += p.isd.sheets; tAppr += p.isd.approvedSheets; tOver += p.isd.overdue; });
    var pct = tSheets ? Math.round(tAppr / tSheets * 100) : 0;

    var sorted = list.slice().sort(function (a, b) { return a.isd.pctSheets - b.isd.pctSheets; });
    // ⚠️ THE SCOPE SCALE IS THE LARGEST ISD IN VIEW, computed ACROSS every group head
    // and never per group. Scaling each group separately would make the longest bar in
    // a small group look like the longest bar in a big one, so a 40-sheet project would
    // read as the same size of job as a 900-sheet one.
    var max = sorted.reduce(function (m, p) { return Math.max(m, p.isd.sheets); }, 0);

    var barHTML = function (p) {
      var L = p.isd;
      return '<div class="pf-isd-row" data-drill="' + esc(p.project_id) + '" role="button" tabindex="0" ' +
        'title="Open this project\'s Drawing Register">' +
        '<span class="pf-isd-n">' + esc(projName(p.project_id)) + '</span>' +
        '<span class="pf-isd-t" title="' + esc(L.approvedSheets + ' of ' + L.sheets + ' sheets approved') + '">' +
          // The track is scaled to the LARGEST ISD scope in view, so a 40-sheet
          // project cannot look like a 900-sheet one; the fill inside it is that
          // project's own progress. Two different questions, two different lengths.
          '<span class="pf-isd-scope" style="width:' + (max ? (L.sheets / max) * 100 : 0).toFixed(2) + '%">' +
            '<span class="pf-isd-f' + (L.overdue ? ' pf-isd-late' : '') + '" style="width:' + L.pctSheets + '%"></span>' +
          '</span></span>' +
        '<span class="pf-isd-v">' + L.pctSheets + '%</span>' +
        '<span class="pf-isd-c">' + L.approvedSheets.toLocaleString() + ' / ' + L.sheets.toLocaleString() + '</span>' +
        '<span class="pf-isd-o">' + (L.overdue ? '<span class="pf-late">' + L.overdue + ' overdue</span>' : '<span class="pf-mut">—</span>') + '</span>' +
        '</div>';
    };
    var bars;
    if (groupBy === 'grouphead') {
      bars = byGroupHead(sorted).map(function (g) {
        var gs = 0, ga = 0, go = 0;
        g[1].forEach(function (p) { gs += p.isd.sheets; ga += p.isd.approvedSheets; go += p.isd.overdue; });
        return '<div class="pf-g-gh"><span class="pf-g-ghn">' + esc(ghLabel(g[0])) +
            '<span class="pf-count-chip">' + g[1].length + '</span></span>' +
            '<span class="pf-g-ghm">' + (gs ? Math.round(ga / gs * 100) + '% of ' +
              gs.toLocaleString() + ' sheets' : 'no ISD sheets') +
              (go ? ' · <span class="pf-late">' + go + ' overdue</span>' : '') +
            '</span></div>' + g[1].map(barHTML).join('');
      }).join('');
    } else {
      bars = sorted.map(barHTML).join('');
    }

    host.innerHTML =
      '<div class="pf-eyebrow">INDIVIDUAL SERVICES DRAWINGS — COUNTED IN SHEETS</div>' +
      '<div class="pf-kpis">' +
        kpi(list.length, 'Projects with ISD', 'of ' + scoped().length + ' in view') +
        kpi(pct + '%', 'ISD approved', tAppr.toLocaleString() + ' / ' + tSheets.toLocaleString() + ' sheets') +
        kpi(tSheets.toLocaleString(), 'ISD sheets', 'in scope') +
        kpi(tOver.toLocaleString(), 'Overdue ISD drawings', 'past planned approval',
            tOver ? 'pf-kpi-bad' : 'pf-kpi-ok') +
      '</div>' +
      '<div class="pd-card"><h3>ISD progress <span class="pf-mut">— least complete first; ' +
        'bar length is the size of the ISD scope, the fill is progress</span></h3>' +
        '<div class="pf-isd">' + bars + '</div></div>' +
      '<div class="pd-card pf-note"><strong>These figures match the Drawing Register exactly.</strong> ' +
        'ISD is tracked with partial sheet credit in both places, so a percentage here is the same ' +
        'percentage you will see inside the project. That is not true of the design levels — see the ' +
        'note on the Overview.</div>';
    wireGantt(host);
  }


  // ==========================================================================
  // REPORTING VISUALS — approvals over time, top-5 lists, status + aging
  // --------------------------------------------------------------------------
  // ⚠️ ALL INLINE SVG, NO CHART LIBRARY. The drawing register loads Chart.js for its
  // own period chart, but this page's only dependencies are supabase and xlsx, and its
  // Gantt already proves the pattern: percent/viewBox geometry that resizes with no
  // resize observer. Adding a charting CDN here to draw three small figures would be a
  // dependency the page otherwise does not need.
  //
  // ⚠️ EVERY FIGURE IS BUILT FROM THE SCOPED LIST, not from `data.projects`. The project
  // filter and the group-head grouping both narrow the set, and a chart that ignored
  // that would contradict the KPI row above it.
  // ==========================================================================

  var periodMode = 'month';        // 'month' | 'quarter'

  // Merge the per-project month buckets into one series for the scoped set.
  // Returns [{ key, label, planned, actual, cumPlanned, cumActual }] in date order.
  function approvalSeries(list) {
    var m = {};
    list.forEach(function (p) {
      Object.keys(p.months || {}).forEach(function (k) {
        var src = p.months[k];
        var key = periodMode === 'quarter'
          ? k.slice(0, 4) + '-Q' + (Math.floor((+k.slice(5, 7) - 1) / 3) + 1)
          : k;
        var b = m[key] || (m[key] = { key: key, planned: 0, actual: 0 });
        b.planned += src.planned; b.actual += src.actual;
      });
    });
    var keys = Object.keys(m).sort();
    // ⚠️ GAPS ARE FILLED. Skipping a month with no approvals would draw the cumulative
    // line as though time had not passed, compressing a six-month stall into one step.
    if (keys.length && periodMode === 'month') {
      var out = [], cur = keys[0], last = keys[keys.length - 1], guard = 0;
      while (cur <= last && guard++ < 400) {
        out.push(m[cur] || { key: cur, planned: 0, actual: 0 });
        var y = +cur.slice(0, 4), mo = +cur.slice(5, 7) + 1;
        if (mo > 12) { mo = 1; y++; }
        cur = y + '-' + String(mo).padStart(2, '0');
      }
      keys = out.map(function (b) { return b.key; });
      out.forEach(function (b) { m[b.key] = b; });
    }
    var cp = 0, ca = 0;
    return keys.map(function (k) {
      var b = m[k];
      cp += b.planned; ca += b.actual;
      return { key: k, label: periodMode === 'quarter' ? k.replace('-', ' ') : fmtMonth(k + '-01'),
               planned: b.planned, actual: b.actual, cumPlanned: cp, cumActual: ca };
    });
  }

  // The S-curve. Bars = approvals due in the period; lines = cumulative due vs cumulative
  // achieved. The gap between the two lines IS the backlog, which is the thing to read.
  function sCurveHTML(list) {
    var S = approvalSeries(list);
    if (!S.length) {
      return '<p class="pf-mut">No planned or actual approval dates yet, so there is nothing ' +
        'to plot. Dates come from the Drawing Register.</p>';
    }
    var W = 1000, H = 260, PADL = 46, PADR = 14, PADT = 12, PADB = 30;
    var iw = W - PADL - PADR, ih = H - PADT - PADB;
    var maxCum = Math.max(1, S[S.length - 1].cumPlanned, S[S.length - 1].cumActual);
    var maxBar = Math.max(1, S.reduce(function (a, b) { return Math.max(a, b.planned, b.actual); }, 0));
    var bw = iw / S.length;
    var x = function (i) { return PADL + i * bw + bw / 2; };
    var yCum = function (v) { return PADT + ih - (v / maxCum) * ih; };
    var yBar = function (v) { return PADT + ih - (v / maxBar) * (ih * 0.55); };

    // gridlines + y labels, on the cumulative scale (the lines are the headline)
    var grid = '', TICKS = 4;
    for (var t = 0; t <= TICKS; t++) {
      var v = Math.round(maxCum * t / TICKS), yy = yCum(v);
      grid += '<line class="pf-sc-grid" x1="' + PADL + '" x2="' + (W - PADR) + '" y1="' + yy + '" y2="' + yy + '"/>' +
        '<text class="pf-sc-ylab" x="' + (PADL - 6) + '" y="' + (yy + 3) + '">' + v + '</text>';
    }

    // bars: planned behind, actual in front, so a period that over-delivered still shows
    var bars = S.map(function (d, i) {
      var w = Math.max(2, bw * 0.34);
      var xp = PADL + i * bw + bw / 2 - w - 1, xa = PADL + i * bw + bw / 2 + 1;
      return (d.planned ? '<rect class="pf-sc-bp" x="' + xp + '" y="' + yBar(d.planned) + '" width="' + w +
        '" height="' + (PADT + ih - yBar(d.planned)) + '"><title>' + esc(d.label) + ' · ' + d.planned + ' due</title></rect>' : '') +
        (d.actual ? '<rect class="pf-sc-ba" x="' + xa + '" y="' + yBar(d.actual) + '" width="' + w +
        '" height="' + (PADT + ih - yBar(d.actual)) + '"><title>' + esc(d.label) + ' · ' + d.actual + ' approved</title></rect>' : '');
    }).join('');

    var line = function (get, cls) {
      return '<polyline class="' + cls + '" points="' +
        S.map(function (d, i) { return x(i) + ',' + yCum(get(d)); }).join(' ') + '"/>';
    };
    // x labels thinned so they never overlap
    var step = Math.ceil(S.length / 12);
    var xlab = S.map(function (d, i) {
      return (i % step === 0 || i === S.length - 1)
        ? '<text class="pf-sc-xlab" x="' + x(i) + '" y="' + (H - 10) + '">' + esc(d.label) + '</text>' : '';
    }).join('');

    var lastP = S[S.length - 1].cumPlanned, lastA = S[S.length - 1].cumActual;
    var behind = lastP - lastA;

    return '<div class="pf-sc-head">' +
        '<span class="pf-seg">' +
          '<button class="pf-seg-b' + (periodMode === 'month' ? ' active' : '') + '" data-period="month">Monthly</button>' +
          '<button class="pf-seg-b' + (periodMode === 'quarter' ? ' active' : '') + '" data-period="quarter">Quarterly</button>' +
        '</span>' +
        '<span class="pf-sc-key">' +
          '<span class="pf-k pf-k-bp"></span>Due <span class="pf-k pf-k-ba"></span>Approved' +
          '<span class="pf-k pf-k-lp"></span>Cumulative due <span class="pf-k pf-k-la"></span>Cumulative approved' +
        '</span>' +
      '</div>' +
      '<svg class="pf-sc" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" ' +
        'aria-label="Approvals due versus approved over time">' +
        grid + bars + line(function (d) { return d.cumPlanned; }, 'pf-sc-lp') +
        line(function (d) { return d.cumActual; }, 'pf-sc-la') + xlab +
      '</svg>' +
      '<p class="pf-mut">' + lastA.toLocaleString() + ' of ' + lastP.toLocaleString() +
        ' scheduled approvals achieved' +
        (behind > 0 ? ' — <strong class="pf-late">' + behind.toLocaleString() +
          ' behind the plan to date</strong>' : behind < 0
          ? ' — <strong>' + (-behind).toLocaleString() + ' ahead of plan</strong>' : '') +
        '. ⚠️ Counted in DRAWINGS, on their own planned and actual approval dates; a drawing with ' +
        'neither date appears in neither series.</p>';
  }

  // ---- status donut --------------------------------------------------------
  // Colours come from EngData's own status vocabulary, so a slice here is the same
  // colour as the same status on the project dashboard.
  var STATUS_HUE = {
    'Approved': '#12693A', 'Approved w/ comments': '#0F766E',
    'Submitted': '#B45309', 'For Review': '#B45309',
    'Resubmit': '#C42127', 'Revise & Resubmit': '#C42127',
    'In Progress': '#2563EB', 'Not Started': '#8A8F98',
    'Cancelled': '#6B7280', 'Superseded': '#6B7280'
  };
  function statusTotals(list) {
    var m = {};
    list.forEach(function (p) {
      Object.keys(p.status || {}).forEach(function (k) { m[k] = (m[k] || 0) + p.status[k]; });
    });
    return m;
  }
  function donutHTML(list) {
    var m = statusTotals(list);
    var keys = Object.keys(m).filter(function (k) { return m[k] > 0; })
      .sort(function (a, b) { return m[b] - m[a]; });
    var total = keys.reduce(function (a, k) { return a + m[k]; }, 0);
    if (!total) return '<p class="pf-mut">No drawings to report.</p>';
    var R = 54, C = 2 * Math.PI * R, off = 0;
    var arcs = keys.map(function (k) {
      var frac = m[k] / total, len = frac * C;
      var seg = '<circle class="pf-dn-arc" r="' + R + '" cx="70" cy="70" fill="none" ' +
        'stroke="' + (STATUS_HUE[k] || '#8A8F98') + '" stroke-width="20" ' +
        'stroke-dasharray="' + len + ' ' + (C - len) + '" stroke-dashoffset="' + (-off) + '">' +
        '<title>' + esc(k) + ' · ' + m[k].toLocaleString() + ' (' + Math.round(frac * 100) + '%)</title></circle>';
      off += len;
      return seg;
    }).join('');
    var legend = keys.map(function (k) {
      return '<div class="pf-dn-li"><span class="pf-dn-sw" style="background:' +
        (STATUS_HUE[k] || '#8A8F98') + '"></span>' +
        '<span class="pf-dn-nm">' + esc(k) + '</span>' +
        '<span class="pf-dn-n">' + m[k].toLocaleString() + '</span>' +
        '<span class="pf-dn-p">' + Math.round(m[k] / total * 100) + '%</span></div>';
    }).join('');
    return '<div class="pf-dn">' +
      '<svg viewBox="0 0 140 140" class="pf-dn-svg" role="img" aria-label="Drawings by status">' +
        '<g transform="rotate(-90 70 70)">' + arcs + '</g>' +
        '<text class="pf-dn-c1" x="70" y="66">' + total.toLocaleString() + '</text>' +
        '<text class="pf-dn-c2" x="70" y="82">drawings</text>' +
      '</svg><div class="pf-dn-leg">' + legend + '</div></div>';
  }

  // ---- aging bar -----------------------------------------------------------
  function agingTotals(list) {
    var m = {};
    (data.AGING_ORDER || []).forEach(function (k) { m[k] = 0; });
    list.forEach(function (p) {
      Object.keys(p.aging || {}).forEach(function (k) { m[k] = (m[k] || 0) + p.aging[k]; });
    });
    return m;
  }
  var AGING_HUE = { '>60d overdue': '#C42127', '31–60d overdue': '#DC2626',
    '1–30d overdue': '#B45309', 'Due ≤7 days': '#CA8A04',
    'Not due yet': '#12693A', 'No due date': '#8A8F98' };
  function agingHTML(list) {
    var m = agingTotals(list);
    var order = (data.AGING_ORDER || []);
    // ⚠️ "No due date" is REPORTED, NOT PLOTTED. The drawing register learned this the
    // hard way: on a register where most drawings carry no planned approval it swamped
    // the bar into one grey blob and reduced the genuinely urgent buckets to a sliver.
    var dated = order.filter(function (k) { return k !== 'No due date'; });
    var tot = dated.reduce(function (a, k) { return a + (m[k] || 0); }, 0);
    var undated = m['No due date'] || 0;
    if (!tot) {
      return '<p class="pf-mut">' + (undated
        ? undated.toLocaleString() + ' open drawing(s), none with a planned approval date — ' +
          'so none can be aged. Set planned approval dates in the Drawing Register.'
        : 'No open drawings — everything is approved.') + '</p>';
    }
    var segs = dated.map(function (k) {
      var n = m[k] || 0; if (!n) return '';
      return '<span class="pf-ag-seg" style="width:' + (n / tot * 100) + '%;background:' +
        AGING_HUE[k] + '" title="' + esc(k + ' · ' + n.toLocaleString()) + '"></span>';
    }).join('');
    var legend = dated.map(function (k) {
      var n = m[k] || 0; if (!n) return '';
      return '<span class="pf-ag-li"><span class="pf-ag-sw" style="background:' + AGING_HUE[k] + '"></span>' +
        esc(k) + ' <strong>' + n.toLocaleString() + '</strong></span>';
    }).join('');
    return '<div class="pf-ag-bar">' + segs + '</div>' +
      '<div class="pf-ag-leg">' + legend + '</div>' +
      '<p class="pf-mut">' + tot.toLocaleString() + ' open drawing(s) with a planned approval date.' +
        (undated ? ' <strong>' + undated.toLocaleString() + '</strong> more have no date and cannot be aged.' : '') +
      '</p>';
  }

  // ---- top-5 rank lists ----------------------------------------------------
  // ⚠️ Each list states the measure it ranks on. "Top 5" with no unit is the kind of
  // figure that gets quoted in a meeting and then cannot be reproduced.
  function slipDays(p) {
    // How far the last approval ran past the last date planned for one. Positive = late.
    if (!p.maxPlanned || !p.maxActual) return null;
    return EngData._portfolio.daysBetweenISO(p.maxPlanned, p.maxActual);
  }
  function rankHTML(title, sub, rows, fmt) {
    if (!rows.length) return '<div class="pf-rank"><h4>' + esc(title) + '</h4>' +
      '<p class="pf-mut">' + esc(sub) + '</p><p class="pf-mut">Nothing to rank.</p></div>';
    var max = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.v); })) || 1;
    return '<div class="pf-rank"><h4>' + esc(title) + '</h4><p class="pf-mut">' + esc(sub) + '</p>' +
      rows.map(function (r) {
        return '<div class="pf-rk-row pf-drill" data-drill="' + esc(r.id) + '" role="button" tabindex="0" ' +
          'title="Open this project’s Drawing Register">' +
          '<span class="pf-rk-n">' + esc(projName(r.id)) + '</span>' +
          '<span class="pf-rk-t"><span class="pf-rk-f" style="width:' +
            (Math.abs(r.v) / max * 100).toFixed(1) + '%"></span></span>' +
          '<span class="pf-rk-v">' + fmt(r.v) + '</span></div>';
      }).join('') + '</div>';
  }
  function topListsHTML(list) {
    var overdue = list.filter(function (p) { return p.overdue > 0; })
      .sort(function (a, b) { return b.overdue - a.overdue; }).slice(0, 5)
      .map(function (p) { return { id: p.project_id, v: p.overdue }; });
    var isd = list.filter(function (p) { return p.isd && p.isd.sheets > 0; })
      .sort(function (a, b) { return b.isd.sheets - a.isd.sheets; }).slice(0, 5)
      .map(function (p) { return { id: p.project_id, v: p.isd.sheets }; });
    var slip = list.map(function (p) { return { id: p.project_id, v: slipDays(p) }; })
      .filter(function (r) { return r.v != null && r.v > 0; })
      .sort(function (a, b) { return b.v - a.v; }).slice(0, 5);
    return '<div class="pf-ranks">' +
      rankHTML('Most overdue drawings', 'Drawings past their own planned approval date',
        overdue, function (v) { return v.toLocaleString(); }) +
      rankHTML('Largest ISD scope', 'Individual Services Drawings, counted in sheets',
        isd, function (v) { return v.toLocaleString() + ' sh'; }) +
      rankHTML('Worst slippage', 'Days from the last planned approval to the last actual one',
        slip, function (v) { return v.toLocaleString() + 'd'; }) +
    '</div>';
  }

  // ---- tables --------------------------------------------------------------
  var COLS = [
    { k: 'name',     l: 'Project' },
    { k: 'drawings', l: 'Drawings', r: true },
    { k: 'design',   l: 'Design approved', r: true },
    { k: 'isd',      l: 'ISD approved', r: true },
    { k: 'overdue',  l: 'Overdue', r: true },
    { k: 'start',    l: 'Earliest planned' },
    { k: 'finish',   l: 'Latest planned/actual' }
  ];
  function sortVal(p, k) {
    switch (k) {
      case 'name':     return projName(p.project_id).toLowerCase();
      case 'drawings': return p.drawings;
      case 'design':   return p.pctDesign;
      case 'isd':      return p.isd ? p.isd.pctSheets : -1;
      case 'overdue':  return p.overdue;
      case 'start':    return (spanOf(p) || {}).s || '';
      case 'finish':   return (spanOf(p) || {}).f || '';
      default:         return 0;
    }
  }
  function sortRows(list) {
    return list.slice().sort(function (a, b) {
      var va = sortVal(a, sort.col), vb = sortVal(b, sort.col);
      if (va < vb) return -sort.dir;
      if (va > vb) return sort.dir;
      return 0;
    });
  }
  function projRowHTML(p) {
    var sp = spanOf(p);
    return '<tr class="pf-row" data-drill="' + esc(p.project_id) + '" title="Open this project&#39;s Drawing Register">' +
      '<td>' + esc(projName(p.project_id)) + '</td>' +
      '<td class="pf-r">' + p.drawings.toLocaleString() + '</td>' +
      '<td class="pf-r">' + (p.designDrawings
          ? p.pctDesign + '% <span class="pf-mut">' + p.designApproved + '/' + p.designDrawings + '</span>'
          : '<span class="pf-mut">\u2014</span>') + '</td>' +
      '<td class="pf-r">' + (p.isd
          ? p.isd.pctSheets + '% <span class="pf-mut">' + p.isd.approvedSheets + '/' + p.isd.sheets + '</span>'
          : '<span class="pf-mut">no ISD</span>') + '</td>' +
      '<td class="pf-r">' + (p.overdue ? '<span class="pf-late">' + p.overdue + '</span>' : '<span class="pf-mut">\u2014</span>') + '</td>' +
      '<td>' + (sp ? esc(fmtDate(sp.s)) : '<span class="pf-mut">\u2014</span>') + '</td>' +
      '<td>' + (sp ? esc(fmtDate(sp.f)) : '<span class="pf-mut">\u2014</span>') + '</td></tr>';
  }
  // ⚠️ A GROUP-HEAD HEADER CARRIES ITS OWN SUBTOTALS, computed with the same
  // totals() the KPI row uses. A header that only names the group and counts its
  // projects leaves the reader adding the percentages up by eye — and they cannot,
  // because a percentage is not additive. totals() re-derives them from that group's
  // raw counts, which is the only way a subtotal can be right.
  function ghHeadHTML(id, group) {
    var t = totals(group);
    return '<tr class="pf-ghrow"><td colspan="2">' + esc(ghLabel(id)) +
        '<span class="pf-count-chip">' + group.length + '</span></td>' +
      '<td class="pf-r">' + (t.designDrawings ? t.pctDesign + '%' : '\u2014') + '</td>' +
      '<td class="pf-r">' + (t.isdSheets ? t.pctIsd + '%' : '\u2014') + '</td>' +
      '<td class="pf-r">' + (t.overdue ? '<span class="pf-late">' + t.overdue + '</span>' : '\u2014') + '</td>' +
      '<td colspan="2"><span class="pf-mut">' + t.drawings.toLocaleString() + ' drawings · ' +
        t.sheets.toLocaleString() + ' sheets</span></td></tr>';
  }
  function tableHTML(list) {
    var head = COLS.map(function (c) {
      return '<th class="' + (c.r ? 'pf-r ' : '') + 'pf-sortable' +
        (sort.col === c.k ? ' pf-sorted' : '') + '" data-sc="' + c.k + '">' + esc(c.l) +
        (sort.col === c.k ? ' <span class="pf-sind">' + (sort.dir === 1 ? '▲' : '▼') + '</span>' : '') + '</th>';
    }).join('');
    var body;
    if (groupBy === 'grouphead') {
      // ⚠️ Sorting happens INSIDE each group, never across the whole list — the
      // group-head sections are the structure of this page, and a flat sort would
      // destroy them. The same rule the drawing register's Registry follows.
      body = byGroupHead(list).map(function (g) {
        return ghHeadHTML(g[0], g[1]) + sortRows(g[1]).map(projRowHTML).join('');
      }).join('');
    } else {
      body = sortRows(list).map(projRowHTML).join('');
    }
    return '<table class="pd-table pf-tbl"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  function levelTableHTML(list) {
    var order = data.TOP_LEVELS;
    var head = '<th>Project</th>' + order.map(function (n) {
      return '<th class="pf-r" title="' + esc(n) + '">' + esc(shortLevel(n)) + '</th>';
    }).join('');
    var body = list.map(function (p) {
      var byName = {};
      p.levels.forEach(function (L) { byName[L.phase] = L; });
      return '<tr class="pf-row" data-drill="' + esc(p.project_id) + '">' +
        '<td>' + esc(projName(p.project_id)) + '</td>' +
        order.map(function (nm) {
          var L = byName[nm];
          if (!L) return '<td class="pf-r"><span class="pf-mut">—</span></td>';
          // ⚠️ ISD reports SHEETS, everything else DRAWINGS. The cell says which.
          var isIsd = nm === data.ISD;
          var v = isIsd ? L.pctSheets : L.pctDrawings;
          var n = isIsd ? (L.approvedSheets + '/' + L.sheets + ' sh')
                        : (L.approvedDrawings + '/' + L.drawings + ' dwg');
          return '<td class="pf-r">' + v + '%<span class="pf-cellsub">' + esc(n) + '</span></td>';
        }).join('') + '</tr>';
    }).join('');
    return '<table class="pd-table pf-tbl pf-lvltbl"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
  }
  function shortLevel(n) {
    if (n === 'Concept Design') return 'Concept';
    if (n === 'Schematic Design') return 'SD';
    if (n === 'For Construction Drawings') return 'FCD';
    if (n === 'Temporary Works Drawings') return 'TWD';
    if (n === 'Individual Services Drawings') return 'ISD';
    return n;
  }

  // ⚠️ THE BASIS NOTE IS NOT OPTIONAL. Someone will compare a percentage here with
  // the same project's Overview and find them different; this says why, before they
  // conclude one of them is broken.
  function basisNoteHTML() {
    return '<details class="pd-card pf-note" open><summary>Why a percentage here can differ from the project\'s own Overview</summary>' +
      '<ul>' +
      '<li><strong>ISD matches exactly.</strong> Both count sheets with partial credit.</li>' +
      '<li><strong>Design levels do not.</strong> Here they are counted in <em>drawings approved ÷ ' +
        'drawings</em>. Inside a project, Concept / SD / FCD / TWD are counted in <em>tracking units</em> ' +
        '— nodes a Technical Officer designates, each worth the same, 0 or 100 with no partial credit. ' +
        'That needs the project\'s whole level tree, so it is the register\'s job, not a portfolio\'s.</li>' +
      '<li><strong>Nothing is blended.</strong> There is deliberately no single "overall %" across the ' +
        'two bases — it would describe neither.</li>' +
      '<li><strong>Overdue</strong> is a drawing whose own planned approval date has passed and that is ' +
        'not approved. Placeholder dates outside 2015–2100 are ignored.</li>' +
      '<li>Sheets are never double-counted: a per-sheet drawing\'s counters live on the drawing, and ' +
        'the level tree itself is structure, not work.</li>' +
      '</ul></details>';
  }

  function emptyHTML() {
    return '<div class="pd-card pf-empty"><h3>Nothing to report yet</h3>' +
      '<p>No project you can access has drawings in its register. Once a Drawing Register is ' +
      'imported or built, this portfolio picks it up automatically — there is nothing to configure ' +
      'here.</p></div>';
  }

  // ---- wiring --------------------------------------------------------------
  // Drill-through sets the shell's project and opens the Drawing Register — the same
  // hand-off planning-app's portfolio uses, and the reason the register can be
  // project-scoped while this page is not.
  function drill(id) {
    if (!id) return;
    sessionStorage.setItem('pd_project', id);
    var p = projects.find(function (x) { return String(x.id) === String(id); });
    if (p) {
      sessionStorage.setItem('pd_project_name', p.name || p.id);
      if (p.group_head) sessionStorage.setItem('pd_group_head', p.group_head);
    }
    location.href = '../drawing-register/index.html';
  }
  function wireGantt(host) {
    host.querySelectorAll('[data-drill]').forEach(function (el) {
      var go = function (e) { if (e) e.stopPropagation(); drill(el.dataset.drill); };
      el.onclick = go;
      el.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });
  }
  // The S-curve's period toggle. Re-renders the whole view rather than just the chart,
  // because the choice is persistent and the footer sentence under the chart changes
  // with it — repainting only the <svg> would leave that sentence describing the old
  // grouping.
  function wirePeriod(host) {
    host.querySelectorAll('[data-period]').forEach(function (b) {
      b.onclick = function () {
        if (periodMode === b.dataset.period) return;
        periodMode = b.dataset.period;
        render();
      };
    });
  }

  function wireTable(host) {
    host.querySelectorAll('th.pf-sortable').forEach(function (th) {
      th.onclick = function () {
        if (sort.col === th.dataset.sc) sort.dir = -sort.dir;
        else { sort.col = th.dataset.sc; sort.dir = th.dataset.sc === 'name' ? 1 : -1; }
        render();
      };
    });
  }

  // ---- project filter ------------------------------------------------------
  function renderFilter() {
    var box = document.getElementById('pf-projlist');
    if (!box || !data) return;
    var have = {};
    data.projects.forEach(function (p) { have[p.project_id] = true; });
    var q = (document.getElementById('pf-projq').value || '').toLowerCase();
    box.innerHTML = projects.filter(function (p) { return have[p.id]; })
      .filter(function (p) { return !q || String(p.name || p.id).toLowerCase().indexOf(q) !== -1; })
      .map(function (p) {
        return '<label class="pf-pl-i"><input type="checkbox" value="' + esc(p.id) + '"' +
          (sel[p.id] ? ' checked' : '') + ' /> ' + esc(p.name || p.id) + '</label>';
      }).join('') || '<div class="pf-mut" style="padding:6px 8px;">No project matches.</div>';
    box.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      cb.onchange = function () {
        if (cb.checked) sel[cb.value] = true; else delete sel[cb.value];
        render();
      };
    });
  }
  function syncFilterChip() {
    var n = Object.keys(sel).length;
    var b = document.getElementById('pf-projbtn');
    if (b) b.textContent = n ? n + ' of ' + (data ? data.projects.length : 0) + ' projects' : 'All projects';
  }

  // ---- init ----------------------------------------------------------------
  async function load() {
    loadErr = null; data = null; render();
    try {
      data = await EngData.portfolio();
      if (data.warning) UI.toast(data.warning, 'warn');
    } catch (e) {
      loadErr = (e && e.message) || String(e);
    }
    renderFilter();
    render();
  }

  async function init(user, profile) {
    UI.initShell();
    // ⚠️ NO REDIRECT TO projects.html, EVER. This module is org-wide: it is
    // meaningful with nothing selected, and redirecting would make it unreachable
    // from a cold start. See the header and the root CLAUDE.md.
    try { projects = (await PDb.getProjects()) || []; } catch (e) { projects = []; }
    projects = projects.filter(function (p) {
      return !AppAuth.canAccessProject || AppAuth.canAccessProject(profile, p.id);
    });
    // ⚠️ Group heads are fetched ALREADY ORDERED by their own sort_order (db.js), and
    // that order is preserved as ghRank. Do not re-sort: the Planners Dashboard owns
    // these records and someone arranged them deliberately.
    // Tolerant: if group_heads cannot be read, every project simply falls into the
    // unassigned bucket rather than the page failing to render.
    try { GH = (await PDb.getGroupHeads()) || []; } catch (e) { GH = []; }
    ghById = {}; ghRank = {};
    GH.forEach(function (g, i) { ghById[g.id] = g; ghRank[g.id] = i; });

    document.querySelectorAll('.pf-tab').forEach(function (t) {
      t.onclick = function () {
        view = t.dataset.view;
        document.querySelectorAll('.pf-tab').forEach(function (x) { x.classList.toggle('active', x === t); });
        render();
      };
    });

    var btn = document.getElementById('pf-projbtn');
    var pop = document.getElementById('pf-projpop');
    btn.onclick = function (e) { e.stopPropagation(); pop.hidden = !pop.hidden; if (!pop.hidden) renderFilter(); };
    document.addEventListener('click', function (e) {
      if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) pop.hidden = true;
    });
    var pq = document.getElementById('pf-projq');
    var t2 = null;
    pq.addEventListener('input', function () { clearTimeout(t2); t2 = setTimeout(renderFilter, 120); });
    document.getElementById('pf-projall').onclick = function () { sel = {}; renderFilter(); render(); };
    var gb = document.getElementById('pf-groupby');
    if (gb) { gb.value = groupBy; gb.onchange = function () { groupBy = gb.value; render(); }; }
    document.getElementById('pf-refresh').onclick = load;
    document.getElementById('pf-print').onclick = function () { setTimeout(function () { window.print(); }, 60); };
    document.getElementById('pf-export').onclick = exportExcel;

    await load();
  }

  function exportExcel() {
    var list = scoped();
    // ⚠️ GROUP HEAD IS A REAL COLUMN, not just a visual grouping — a spreadsheet is
    // going to be pivoted, and a heading row that only exists as formatting cannot be.
    var aoa = [['Group head', 'Project', 'Drawings', 'Sheets', 'Approved sheets', 'Design drawings',
      'Design approved', 'Design %', 'ISD sheets', 'ISD approved', 'ISD %', 'Overdue',
      'Earliest planned', 'Latest planned', 'Latest actual']];
    var row = function (p) {
      return [ghLabel(ghIdOf(p.project_id)), projName(p.project_id), p.drawings, p.sheets,
        p.approvedSheets, p.designDrawings, p.designApproved, p.pctDesign,
        p.isd ? p.isd.sheets : '', p.isd ? p.isd.approvedSheets : '', p.isd ? p.isd.pctSheets : '',
        p.overdue, p.minPlanned || '', p.maxPlanned || '', p.maxActual || ''];
    };
    // Exported in the order shown, group head by group head, with a subtotal after
    // each so the file reads the same way the screen does.
    byGroupHead(list).forEach(function (g) {
      sortRows(g[1]).forEach(function (p) { aoa.push(row(p)); });
      var t = totals(g[1]);
      aoa.push([ghLabel(g[0]) + ' \u2014 subtotal', g[1].length + ' projects', t.drawings, t.sheets,
        t.approvedSheets, t.designDrawings, t.designApproved, t.pctDesign,
        t.isdSheets, t.isdApproved, t.pctIsd, t.overdue, '', '', '']);
      aoa.push([]);
    });
    // ⚠️ The two bases are named in the header row, not just in the UI — a
    // spreadsheet outlives the page that explained it.
    aoa.push([]);
    aoa.push(['Design % counts DRAWINGS approved / drawings. The project\'s own Overview counts ' +
      'Concept/SD/FCD/TWD in TRACKING UNITS, so those figures differ legitimately. ISD % counts ' +
      'SHEETS with partial credit and matches the register exactly.']);
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Portfolio');
    XLSX.writeFile(wb, 'Engineering Portfolio.xlsx');
  }

  return {
    init: init,
    _internals: {
      spanOf: spanOf, ganttHTML: ganttHTML, tableHTML: tableHTML, levelTableHTML: levelTableHTML,
      totals: totals, scoped: scoped, sortVal: sortVal, fmtDate: fmtDate, daysBetween: daysBetween,
      addDays: addDays, shortLevel: shortLevel, renderOverview: renderOverview,
      renderGantt: renderGantt, renderISD: renderISD, render: render, exportExcel: exportExcel,
      setData: function (d) { data = d; }, setProjects: function (p) { projects = p; },
      setSel: function (s) { sel = s || {}; }, setView: function (v) { view = v; },
      byGroupHead: byGroupHead, ghIdOf: ghIdOf, ghLabel: ghLabel, ghHeadHTML: ghHeadHTML,
      approvalSeries: approvalSeries, sCurveHTML: sCurveHTML, donutHTML: donutHTML,
      agingHTML: agingHTML, topListsHTML: topListsHTML, statusTotals: statusTotals,
      agingTotals: agingTotals, slipDays: slipDays,
      setPeriod: function (m) { periodMode = m; },
      setGroupBy: function (g) { groupBy = g; },
      setGH: function (list) {
        GH = list || []; ghById = {}; ghRank = {};
        GH.forEach(function (g, i) { ghById[g.id] = g; ghRank[g.id] = i; });
      },
      NO_GH: NO_GH,
      setSort: function (s) { sort = s; }
    }
  };
})();
