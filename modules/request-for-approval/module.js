/* Request for Approval register — modules/request-for-approval/module.js

   The F-GEN011 RFA sheet has been renderable since 0012 (assets/js/topsheet.js),
   but it was opened BLANK from the Material Submittal toolbar: there was no record
   behind it. So an RFA could be printed and never tracked — nothing knew it had
   been issued, what it covered, or whether the consultant had answered. This is
   the register that fixes that, and it is what makes "auto-generate and email the
   top sheet" possible for RFAs at all.

   ⚠️ NO SOURCE WORKBOOK, AND THEREFORE NO IMPORTER. The three transcribed
   registers each had a real PMO workbook whose own formulas were the spec; there
   is no RFA tracker to build against, so the schema and vocabulary were DESIGNED
   (0020 says the same). Two consequences, both deliberate:
     1. There is no Excel import. Every sibling importer reads a layout it knows;
        inventing one here would be guessing at a file nobody has produced. Export
        exists, so the register can still be handed to someone in Excel.
     2. The Summary carries a METHOD note, not a reconciliation note — there is no
        source to reconcile against, so it states how each figure is built.

   ⚠️ THE POINT OF THIS REGISTER IS THE UNANSWERED RFA. An RFA is a question that
   blocks work: what matters is how long it has been out and whether it is past the
   date it was needed by. So `date_required` drives the Summary, the default sort
   and the overdue count — not the issue date, and not the status alone.

   ⚠️ "OPEN" AND "OVERDUE" ARE DERIVED IN ONE PLACE EACH (`isOpen` / `overdueDays`)
   and every surface reads them. The KPI, the filter, the row tint and the Summary
   ageing table all had to agree, and the sibling modules' notes record what happens
   when two of them disagree: a count that contradicts the list beside it. */
window.RequestForApproval = (function () {
  'use strict';

  var TABLE = 'request_for_approval';
  // ⚠️ Shares Material Submittal's private bucket rather than making a second one:
  // same project scoping, same lifecycle, same cleanup code. 0020 says so too.
  var BUCKET = 'material-submittal';
  // ⚠️ A LINKED DRAWING'S FILE LIVES IN THE DRAWING REGISTER'S OWN BUCKET, not in
  // ours. The RFA never copies it — it reads it to build the package, so there is one
  // copy of a drawing in this app and the register stays its owner. That is why every
  // fetch here takes a bucket rather than assuming one.
  var DRAW_BUCKET = 'drawing-register';

  var sb = function () { return window.__sb || (window.__sb = supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY)); };
  var esc = function (s) { return Fmt.esc(s == null ? '' : String(s)); };
  function ico(name, size) { return (window.Icons && Icons.svg) ? Icons.svg(name, size || 15) : ''; }

  // Lifecycle, in order. `open` = still waiting on somebody else; `closed` = the
  // loop is finished one way or another. A status belongs to at most one bucket,
  // which is what stops a row being counted twice in the KPI row.
  // ⚠️ Four of these names are GATED SERVER-SIDE by engineering_decision_statuses()
  // (Approved, Approved w/ comments, Resubmit, Rejected) — see 0020's banner. They
  // are spelled to match names that were ALREADY in that shared list, so 0020 did
  // not have to redefine it. Renaming one here without changing the guard would
  // silently un-gate an approval.
  var STATUSES = [
    { name: 'Draft',                cls: 'rf-s-draft' },
    { name: 'Submitted',            cls: 'rf-s-sub',  open: true },
    { name: 'Under Review',         cls: 'rf-s-rev',  open: true },
    { name: 'Approved w/ comments', cls: 'rf-s-appc', closed: true, approved: true },
    { name: 'Approved',             cls: 'rf-s-app',  closed: true, approved: true },
    { name: 'Resubmit',             cls: 'rf-s-res',  open: true, rework: true },
    { name: 'Rejected',             cls: 'rf-s-rej',  closed: true },
    { name: 'Cancelled',            cls: 'rf-s-can',  closed: true }
  ];
  var STATUS_ORDER = STATUSES.map(function (s) { return s.name; });

  var DISCIPLINES = ['Architectural', 'Structural', 'Civil', 'Mechanical', 'Electrical',
    'Plumbing', 'Fire Protection', 'Landscape', 'Temporary Works', 'Other'];

  // Ageing buckets for an OPEN RFA, measured against date_required. Ordered worst
  // first, which is the order the Summary and the register both want.
  var AGE_BUCKETS = [
    { key: '>30 overdue',  cls: 'rf-a-crit', test: function (d) { return d != null && d > 30; } },
    { key: '15-30 overdue', cls: 'rf-a-bad', test: function (d) { return d != null && d > 14 && d <= 30; } },
    { key: '1-14 overdue', cls: 'rf-a-warn', test: function (d) { return d != null && d > 0 && d <= 14; } },
    { key: 'Due soon',     cls: 'rf-a-soon', test: function (d) { return d != null && d <= 0 && d >= -7; } },
    { key: 'In time',      cls: 'rf-a-ok',   test: function (d) { return d != null && d < -7; } },
    { key: 'No date set',  cls: 'rf-a-none', test: function (d) { return d == null; } }
  ];

  var pid = null, UID = null, PROFILE = null, rows = [], canWrite = false, isPlanner = false;
  var view = 'summary', projects = [], tsDefaults = null;
  var filters = { q: '', discipline: '', status: '', type: '', overdue: false, openOnly: false };

  // ---- the drawing link ----------------------------------------------------
  // ⚠️ An RFA exists to get SPECIFIC DRAWINGS approved, so the register has to answer
  // both directions: what is this RFA asking for, and which RFA is drawing A-1204
  // waiting on. `rfa_drawings` (0020) is the real many-to-many; these are its
  // in-memory indexes.
  //   linksOf[rfaId]      -> [{ drawing_id, revision, pages }]  the forward list
  //   rfasOfDrawing[dwgId]-> [rfaId, …]                          the reverse lookup
  var drawings = [], drawById = {}, hasSheets = {}, linksOf = {}, rfasOfDrawing = {};
  var drawErr = null;             // set when the link/drawing load fails, surfaced not swallowed

  // ---- helpers -------------------------------------------------------------
  var MNAME = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // ⚠️ Integer maths on the ISO string, never `new Date(iso)` + local getters. The
  // trap is documented three times over in the drawing register: a local
  // constructor read back with a UTC getter names the previous day everywhere east
  // of Greenwich, and Manila is UTC+8. Every date in this module goes through here.
  function fmtDate(s) {
    if (!s) return '';
    var p = String(s).slice(0, 10).split('-');
    if (p.length !== 3 || isNaN(+p[0])) return String(s);
    return String(+p[2]).padStart(2, '0') + ' ' + MNAME[+p[1] - 1] + ' ' + p[0];
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }
  // Whole days between two ISO dates, by UTC arithmetic on the date parts only —
  // no timezone can shift it.
  function daysBetween(aIso, bIso) {
    if (!aIso || !bIso) return null;
    var a = String(aIso).slice(0, 10).split('-'), b = String(bIso).slice(0, 10).split('-');
    if (a.length !== 3 || b.length !== 3) return null;
    var ta = Date.UTC(+a[0], +a[1] - 1, +a[2]), tb = Date.UTC(+b[0], +b[1] - 1, +b[2]);
    if (isNaN(ta) || isNaN(tb)) return null;
    return Math.round((tb - ta) / 86400000);
  }
  // A legacy/placeholder date is not a date. Same guard, same range, as the
  // drawing register's validDate() — a "2000-01-06" sentinel must never win a
  // min/max or make something look 26 years overdue.
  function validDate(d) {
    if (!d) return false;
    var y = +String(d).slice(0, 4);
    return y >= 2015 && y <= 2100;
  }

  function statusOf(r) { return (r.status || '').trim(); }
  function statusMeta(n) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].name === n) return STATUSES[i];
    return null;
  }
  // ⚠️ A row with NO status is treated as a Draft, not as open. An RFA nobody has
  // marked as submitted has not been submitted, and counting it as outstanding
  // would inflate the one number this register exists to report.
  function isOpen(r) { var m = statusMeta(statusOf(r)); return !!(m && m.open); }
  function isApproved(r) { var m = statusMeta(statusOf(r)); return !!(m && m.approved); }
  function isClosed(r) { var m = statusMeta(statusOf(r)); return !!(m && m.closed); }

  // Days past the date the answer was needed by. Positive = late.
  // ⚠️ Only ever meaningful for an OPEN RFA: a closed one is not "still 40 days
  // late", it is finished. Returns null for anything closed, so no surface can
  // accidentally report an answered RFA as overdue.
  function overdueDays(r, today) {
    if (!isOpen(r) || !validDate(r.date_required)) return null;
    return daysBetween(r.date_required, today || todayISO());
  }
  function isOverdue(r, today) { var d = overdueDays(r, today); return d != null && d > 0; }

  // How long the loop actually took, for the turnaround figure. Uses the date the
  // reply came back, falling back to the decision date — a returned sheet and a
  // recorded decision are the same event on two different forms.
  function turnaroundDays(r) {
    var start = validDate(r.date_submitted) ? r.date_submitted : (validDate(r.rfa_date) ? r.rfa_date : null);
    var end = validDate(r.date_returned) ? r.date_returned : (validDate(r.decision_date) ? r.decision_date : null);
    if (!start || !end) return null;
    var d = daysBetween(start, end);
    // A negative turnaround is a data-entry error, not a fast consultant. Dropped
    // rather than averaged in, where it would silently pull the mean down.
    return d == null || d < 0 ? null : d;
  }

  function docTypes(r) { return Array.isArray(r.doc_types) ? r.doc_types : []; }
  function documents(r) {
    if (Array.isArray(r.documents)) return r.documents;
    // Tolerant of a jsonb column that arrived as a string, which is what a hand-run
    // SQL insert produces.
    if (typeof r.documents === 'string') { try { return JSON.parse(r.documents) || []; } catch (e) { return []; } }
    return [];
  }
  function fileLabel(path) {
    if (!path) return '';
    return String(path).split('/').pop().replace(/^\d{10,}_/, '');   // strip the timestamp prefix
  }

  // ---- stats ---------------------------------------------------------------
  // ⚠️ ONE function computes every headline figure, and the Registry's counts read
  // the same helpers (isOpen / overdueDays). Two implementations of "overdue" is
  // how you end up with a KPI that contradicts the list underneath it.
  function stats(list) {
    var today = todayISO();
    var s = {
      total: list.length, open: 0, overdue: 0, approved: 0, rejected: 0, rework: 0, draft: 0,
      worstOverdue: 0, turnarounds: [], byAge: {}, byStatus: {}, byDiscipline: {}
    };
    AGE_BUCKETS.forEach(function (b) { s.byAge[b.key] = 0; });
    STATUS_ORDER.forEach(function (n) { s.byStatus[n] = 0; });

    list.forEach(function (r) {
      var st = statusOf(r) || 'Draft';
      if (s.byStatus[st] == null) s.byStatus[st] = 0;
      s.byStatus[st]++;
      if (!statusOf(r) || st === 'Draft') s.draft++;
      if (isApproved(r)) s.approved++;
      if (st === 'Rejected') s.rejected++;
      var m = statusMeta(st);
      if (m && m.rework) s.rework++;

      var d = (r.discipline || '—');
      s.byDiscipline[d] = (s.byDiscipline[d] || 0) + 1;

      if (isOpen(r)) {
        s.open++;
        var od = overdueDays(r, today);
        if (od != null && od > 0) { s.overdue++; if (od > s.worstOverdue) s.worstOverdue = od; }
        // ⚠️ Ageing counts OPEN rows only — the buckets describe a queue, and a
        // closed RFA is not in the queue.
        for (var i = 0; i < AGE_BUCKETS.length; i++) {
          if (AGE_BUCKETS[i].test(od)) { s.byAge[AGE_BUCKETS[i].key]++; break; }
        }
      }
      var t = turnaroundDays(r);
      if (t != null) s.turnarounds.push(t);
    });

    // Median, not mean: one RFA that sat for a year drags a mean somewhere no
    // actual RFA has ever been. Both are reported so neither can mislead alone.
    var ts = s.turnarounds.slice().sort(function (a, b) { return a - b; });
    s.avgTurnaround = ts.length ? Math.round(ts.reduce(function (a, b) { return a + b; }, 0) / ts.length) : null;
    s.medTurnaround = ts.length
      ? (ts.length % 2 ? ts[(ts.length - 1) / 2] : Math.round((ts[ts.length / 2 - 1] + ts[ts.length / 2]) / 2))
      : null;
    s.answered = ts.length;
    return s;
  }

  // ---- data ----------------------------------------------------------------
  async function load() {
    var host = document.getElementById('rf-view');
    host.innerHTML = skeletonHTML();
    if (!pid) { rows = []; render(); return; }
    // Keyset-paginated on id. PostgREST caps a plain select at 1000 rows, and an
    // RFA register on a large project passes that — the drawing register shipped
    // truncated for exactly this reason before it was fixed.
    var out = [], last = null, PAGE = 1000;
    try {
      for (;;) {
        var q = sb().from(TABLE).select('*').eq('project_id', pid).order('id').limit(PAGE);
        if (last) q = q.gt('id', last);
        var res = await q;
        if (res.error) throw res.error;
        var got = res.data || [];
        out = out.concat(got);
        if (got.length < PAGE) break;
        last = got[got.length - 1].id;
      }
      rows = out;
    } catch (e) {
      rows = [];
      // Names the table, because "could not load" on a module whose migration has
      // not been run is the single most likely cause and the least obvious.
      host.innerHTML = '<div class="pd-card rf-empty"><h3>Could not load the RFA register</h3>' +
        '<p>' + esc((e && e.message) || e) + '</p>' +
        '<p class="rf-mut">If this says the table does not exist, run <code>migrations/0020-request-for-approval.sql</code>.</p></div>';
      return;
    }
    await loadDrawingLinks();
    render();
  }

  // The drawings available to link, and the existing links.
  // ⚠️ TOLERANT BY DESIGN, BUT NOT SILENT. If `rfa_drawings` is missing (0020 not
  // run) the register still opens and still works as a log — refusing to load at all
  // would make the module useless over one absent table. `drawErr` records it and the
  // UI says so where the links would have been, so nobody concludes an RFA covers no
  // drawings when in fact the link table isn't there.
  async function loadDrawingLinks() {
    drawings = []; drawById = {}; hasSheets = {}; linksOf = {}; rfasOfDrawing = {};
    drawErr = null;
    if (!pid) return;
    try {
      // Only real drawings, never level nodes. `node_kind = 'drawing'` excludes the
      // level tree; the sheet test below needs parent_id, so it is selected too.
      var out = [], last = null, PAGE = 1000;
      for (;;) {
        var q = sb().from('drawing_register')
          // file_url + submissions are selected because the RFA package merges each
          // linked drawing's OWN file under the top sheet — see drawingFileOf().
          .select('id,drawing_code,drawing_no,title,revision,status,no_of_sheets,approved_sheets,parent_id,node_kind,phase,discipline,actual_approval,file_url,submissions')
          .eq('project_id', pid).eq('node_kind', 'drawing').order('id').limit(PAGE);
        if (last) q = q.gt('id', last);
        var res = await q;
        if (res.error) throw res.error;
        var got = res.data || [];
        out = out.concat(got);
        if (got.length < PAGE) break;
        last = got[got.length - 1].id;
      }
      out.forEach(function (d) { drawById[d.id] = d; });
      // ⚠️ A SHEET IS A DRAWING WHOSE PARENT IS ITSELF A DRAWING — the exact rule
      // drawing_register's indexSheets() uses, and the one that had to be fixed there
      // when levels gained parent_id (before that, every drawing counted as a sheet).
      // Copied rather than invented: if the two ever disagree, this module would offer
      // sheets in the picker as though they were drawings.
      out.forEach(function (d) {
        if (d.parent_id && drawById[d.parent_id]) hasSheets[d.parent_id] = true;
      });
      drawings = out.filter(function (d) { return !(d.parent_id && drawById[d.parent_id]); });

      if (rows.length) {
        var ids = rows.map(function (r) { return r.id; });
        // Chunked: an `in` list of a thousand uuids is a URL long enough to be
        // refused, and this register can hold that many.
        for (var i = 0; i < ids.length; i += 200) {
          var lr = await sb().from('rfa_drawings')
            .select('rfa_id,drawing_id,revision,pages,sort_order')
            .in('rfa_id', ids.slice(i, i + 200));
          if (lr.error) throw lr.error;
          (lr.data || []).forEach(function (l) {
            (linksOf[l.rfa_id] = linksOf[l.rfa_id] || []).push(l);
            (rfasOfDrawing[l.drawing_id] = rfasOfDrawing[l.drawing_id] || []).push(l.rfa_id);
          });
        }
        Object.keys(linksOf).forEach(function (k) {
          linksOf[k].sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
        });
      }
    } catch (e) {
      drawErr = (e && e.message) || String(e);
    }
  }

  function linksFor(rfaId) { return linksOf[rfaId] || []; }
  function drawLabel(d) {
    if (!d) return '(deleted drawing)';
    return d.drawing_code || d.drawing_no || d.title || '(untitled)';
  }
  // Is this drawing tracked per sheet? Used to REFUSE the approval write-back —
  // see recordApprovalOnDrawings().
  function isSheetTracked(id) { return !!hasSheets[id]; }

  // The reverse lookup the user asked for: which RFAs carry this drawing, worst first.
  function rfasForDrawing(drawingId) {
    return (rfasOfDrawing[drawingId] || [])
      .map(function (id) { return rows.find(function (r) { return r.id === id; }); })
      .filter(Boolean)
      .sort(function (a, b) {
        var oa = isOpen(a) ? 0 : 1, ob = isOpen(b) ? 0 : 1;
        if (oa !== ob) return oa - ob;
        return (overdueDays(b) || 0) - (overdueDays(a) || 0);
      });
  }

  function skeletonHTML() {
    var r = '';
    for (var i = 0; i < 8; i++) r += '<div class="rf-sk-row"></div>';
    return '<div class="pd-card rf-skcard" aria-busy="true">' +
      '<div class="rf-sk-head"><span class="rf-sk-spin"></span>Loading RFAs…</div>' + r + '</div>';
  }

  // ---- render --------------------------------------------------------------
  function render() {
    var fb = document.getElementById('rf-filters');
    if (fb) fb.style.display = (view === 'summary') ? 'none' : '';
    syncClearFilt();
    syncFilterOptions();
    if (view === 'summary') renderSummary(); else renderRegistry();
  }

  function kpi(val, label, sub, tone) {
    return '<div class="pd-card rf-kpi' + (tone ? ' ' + tone : '') + '">' +
      '<div class="rf-kpi-v">' + val + '</div>' +
      '<div class="rf-kpi-l">' + esc(label) + '</div>' +
      (sub ? '<div class="rf-kpi-s">' + sub + '</div>' : '') + '</div>';
  }

  function barRow(label, n, max, cls, title) {
    var w = max > 0 ? Math.round((n / max) * 100) : 0;
    return '<div class="rf-bar" ' + (title ? 'title="' + esc(title) + '"' : '') + '>' +
      '<span class="rf-bar-l">' + esc(label) + '</span>' +
      '<span class="rf-bar-t"><span class="rf-bar-f ' + (cls || '') + '" style="width:' + w + '%"></span></span>' +
      '<span class="rf-bar-n">' + n + '</span></div>';
  }

  function renderSummary() {
    var host = document.getElementById('rf-view');
    if (!rows.length) { host.innerHTML = emptyHTML(); wireEmpty(); return; }
    var s = stats(rows);

    var kpis =
      kpi(s.total, 'RFAs raised', 'in this project') +
      kpi(s.open, 'Awaiting reply', s.open ? 'with the consultant / client' : 'nothing outstanding',
          s.open ? 'rf-kpi-warn' : 'rf-kpi-ok') +
      kpi(s.overdue, 'Overdue', s.overdue ? 'worst is ' + s.worstOverdue + ' days late' : 'none past its required date',
          s.overdue ? 'rf-kpi-bad' : 'rf-kpi-ok') +
      kpi(s.approved, 'Approved', 'incl. approved with comments', 'rf-kpi-ok') +
      kpi(s.rework, 'To resubmit', 'came back for rework', s.rework ? 'rf-kpi-warn' : '') +
      kpi(s.medTurnaround == null ? '—' : s.medTurnaround + 'd', 'Median turnaround',
          s.answered ? 'over ' + s.answered + ' answered' + (s.avgTurnaround != null ? ' · mean ' + s.avgTurnaround + 'd' : '') : 'none answered yet');

    // Ageing of the open queue — the register's headline picture.
    var maxAge = 0;
    AGE_BUCKETS.forEach(function (b) { if (s.byAge[b.key] > maxAge) maxAge = s.byAge[b.key]; });
    var ageRows = AGE_BUCKETS.map(function (b) {
      return barRow(b.key, s.byAge[b.key], maxAge, b.cls,
        'Click to see these in the Registry');
    }).join('');

    var maxSt = 0;
    STATUS_ORDER.forEach(function (n) { if (s.byStatus[n] > maxSt) maxSt = s.byStatus[n]; });
    var stRows = STATUS_ORDER.map(function (n) {
      var m = statusMeta(n);
      return '<div class="rf-bar rf-drill" data-drill="status" data-val="' + esc(n) + '" ' +
        'role="button" tabindex="0" title="Show these in the Registry">' +
        '<span class="rf-bar-l">' + esc(n) + '</span>' +
        '<span class="rf-bar-t"><span class="rf-bar-f ' + (m ? m.cls : '') + '" style="width:' +
          (maxSt > 0 ? Math.round((s.byStatus[n] / maxSt) * 100) : 0) + '%"></span></span>' +
        '<span class="rf-bar-n">' + s.byStatus[n] + '</span></div>';
    }).join('');

    var disc = Object.keys(s.byDiscipline).sort(function (a, b) { return s.byDiscipline[b] - s.byDiscipline[a]; });
    var maxD = disc.length ? s.byDiscipline[disc[0]] : 0;
    var discRows = disc.slice(0, 10).map(function (d) {
      return '<div class="rf-bar rf-drill" data-drill="discipline" data-val="' + esc(d === '—' ? '' : d) + '" ' +
        'role="button" tabindex="0" title="Show these in the Registry">' +
        '<span class="rf-bar-l">' + esc(d) + '</span>' +
        '<span class="rf-bar-t"><span class="rf-bar-f" style="width:' +
          (maxD > 0 ? Math.round((s.byDiscipline[d] / maxD) * 100) : 0) + '%"></span></span>' +
        '<span class="rf-bar-n">' + s.byDiscipline[d] + '</span></div>';
    }).join('');

    // The worst open RFAs, named. A count tells you there is a problem; this tells
    // you which one to chase, which is the whole job.
    var worst = rows.filter(function (r) { return isOverdue(r); })
      .sort(function (a, b) { return overdueDays(b) - overdueDays(a); }).slice(0, 8);
    var worstHTML = worst.length
      ? '<table class="pd-table rf-tbl"><thead><tr><th>RFA</th><th>Title</th><th>Required</th><th class="rf-r">Days late</th><th>With</th></tr></thead><tbody>' +
        worst.map(function (r) {
          return '<tr class="rf-rowlink" data-open="' + esc(r.id) + '" title="Open this RFA">' +
            '<td class="rf-mono">' + esc(r.rfa_no || '—') + '</td>' +
            '<td>' + esc(r.title || '—') + '</td>' +
            '<td>' + esc(fmtDate(r.date_required)) + '</td>' +
            '<td class="rf-r rf-late">' + overdueDays(r) + '</td>' +
            '<td>' + esc(r.to_company || r.to_name || '—') + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<p class="rf-mut">No RFA is past its required date.</p>';

    // ⚠️ THE REVERSE LOOKUP, MADE VISIBLE. An RFA is the vehicle that carries a
    // drawing to approval, so the question that actually blocks site work is
    // "which DRAWINGS are stuck?", not "which RFAs are late". One late RFA can hold
    // up a dozen drawings, and that is invisible from the RFA list alone.
    var stuck = [];
    Object.keys(rfasOfDrawing).forEach(function (did) {
      var open = rfasForDrawing(did).filter(isOpen);
      if (!open.length) return;
      var d = drawById[did];
      if (!d) return;                                  // deleted out from under the link
      stuck.push({ d: d, rfa: open[0], late: overdueDays(open[0]) });
    });
    stuck.sort(function (a, b) {
      var la = a.late == null ? -1e9 : a.late, lb = b.late == null ? -1e9 : b.late;
      return lb - la;
    });
    var stuckHTML = drawErr
      ? '<p class="rf-mut"><strong class="rf-late">Unavailable.</strong> ' + esc(drawErr) +
        ' If this says a table does not exist, run <code>migrations/0020-request-for-approval.sql</code>.</p>'
      : (stuck.length
        ? '<p class="rf-mut">' + stuck.length + ' drawing' + (stuck.length > 1 ? 's are' : ' is') +
            ' waiting on an open RFA.</p>' +
          '<table class="pd-table rf-tbl"><thead><tr><th>Drawing</th><th>Waiting on</th><th class="rf-r">Days late</th></tr></thead><tbody>' +
          stuck.slice(0, 10).map(function (x) {
            return '<tr class="rf-rowlink" data-open="' + esc(x.rfa.id) + '" title="Open the RFA holding this drawing">' +
              '<td class="rf-mono">' + esc(drawLabel(x.d)) + '</td>' +
              '<td>' + esc(x.rfa.rfa_no || x.rfa.title || '—') + '</td>' +
              '<td class="rf-r' + (x.late != null && x.late > 0 ? ' rf-late' : '') + '">' +
                (x.late == null ? '—' : (x.late > 0 ? x.late : '—')) + '</td></tr>';
          }).join('') + '</tbody></table>' +
          (stuck.length > 10 ? '<p class="rf-mut">… and ' + (stuck.length - 10) + ' more.</p>' : '')
        : '<p class="rf-mut">No drawing is waiting on an open RFA.</p>' +
          (Object.keys(rfasOfDrawing).length ? '' :
            '<p class="rf-mut">No RFA has drawings linked to it yet. Link them when you raise or edit ' +
            'an RFA — that is what lets this answer "which drawings are stuck?".</p>'));

    host.innerHTML =
      '<div class="rf-eyebrow">RFA STATUS — ' + esc(projName()) + '</div>' +
      '<div class="rf-kpis">' + kpis + '</div>' +
      '<div class="rf-grid2">' +
        '<div class="pd-card"><h3>Open RFAs by age <span class="rf-mut">— against the date the answer was needed</span></h3>' + ageRows + '</div>' +
        '<div class="pd-card"><h3>Drawings blocked by an RFA <span class="rf-mut">— the reverse view</span></h3>' + stuckHTML + '</div>' +
      '</div>' +
      '<div class="rf-grid2">' +
        '<div class="pd-card"><h3>By status</h3>' + stRows + '</div>' +
        '<div class="pd-card"><h3>Chase these first <span class="rf-mut">— most overdue RFAs</span></h3>' + worstHTML + '</div>' +
      '</div>' +
      '<div class="rf-grid2">' +
        '<div class="pd-card"><h3>By discipline <span class="rf-mut">— top 10</span></h3>' + (discRows || '<p class="rf-mut">Nothing recorded.</p>') + '</div>' +
      '</div>' +
      methodNoteHTML(s);

    // Drill-through: set the filter, switch to the Registry.
    host.querySelectorAll('.rf-drill').forEach(function (el) {
      var go = function () { drillTo(el.dataset.drill, el.dataset.val); };
      el.onclick = go;
      el.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });
    host.querySelectorAll('[data-open]').forEach(function (tr) {
      tr.onclick = function () {
        var r = rows.find(function (x) { return String(x.id) === tr.dataset.open; });
        if (r) openForm(r);
      };
    });
  }

  // ⚠️ A METHOD note, not a reconciliation note — there is no source workbook to
  // reconcile against (see the file header). It states how each figure is built so
  // the first person to compare this with their own spreadsheet can see exactly
  // where a difference would come from, rather than assuming one of them is wrong.
  function methodNoteHTML(s) {
    return '<details class="pd-card rf-method"><summary>How these figures are built</summary>' +
      '<ul>' +
      '<li><strong>Awaiting reply</strong> counts Submitted, Under Review and Resubmit. A row with ' +
        'no status counts as a <em>Draft</em>, not as outstanding — an RFA nobody marked as submitted ' +
        'has not been submitted.</li>' +
      '<li><strong>Overdue</strong> is an open RFA whose <em>required</em> date has passed. A closed ' +
        'RFA is never overdue, however late it was answered.</li>' +
      '<li><strong>Age buckets</strong> describe the open queue only, measured against the required ' +
        'date. Placeholder dates outside 2015–2100 are ignored rather than reported as decades late.</li>' +
      '<li><strong>Turnaround</strong> runs from submitted (or the RFA date) to returned (or the ' +
        'decision date). ' + (s.answered ? 'Measured on ' + s.answered + ' answered RFA(s). ' : '') +
        'The <em>median</em> leads because one RFA that sat for a year drags a mean somewhere no real ' +
        'RFA has been; the mean is shown beside it so neither misleads alone. A negative turnaround is ' +
        'treated as a data-entry error and excluded.</li>' +
      '<li><strong>Approved</strong> includes <em>Approved w/ comments</em> — it is still an approval, ' +
        'and separating them here would understate what has actually been cleared.</li>' +
      '</ul></details>';
  }

  function drillTo(kind, value) {
    filters = { q: '', discipline: '', status: '', type: '', overdue: false, openOnly: false };
    if (kind === 'status') filters.status = value;
    if (kind === 'discipline') filters.discipline = value;
    view = 'registry';
    syncTabs();
    // The controls must show what is actually applied, or the register looks
    // filtered by nothing. `setSel` adds the option when a legacy value is absent —
    // a <select> silently ignores a value it has no option for.
    setSel('rf-f-status', filters.status);
    setSel('rf-f-discipline', filters.discipline);
    render();
  }
  function setSel(id, v) {
    var el = document.getElementById(id); if (!el) return;
    if (v && !Array.prototype.some.call(el.options, function (o) { return o.value === v; })) {
      var o = document.createElement('option'); o.value = v; o.textContent = v; el.appendChild(o);
    }
    el.value = v || '';
  }

  // ---- filtering -----------------------------------------------------------
  function matches(r) {
    if (filters.status && statusOf(r) !== filters.status) return false;
    if (filters.discipline && (r.discipline || '') !== filters.discipline) return false;
    if (filters.type && docTypes(r).indexOf(filters.type) === -1) return false;
    if (filters.openOnly && !isOpen(r)) return false;
    if (filters.overdue && !isOverdue(r)) return false;
    if (filters.q) {
      var q = filters.q.toLowerCase();
      // Searches the document table too — people look an RFA up by the drawing
      // number it transmitted, which is not in any of the row's own text columns.
      var hay = [r.rfa_no, r.title, r.description, r.category, r.sub_category,
        r.discipline, r.to_name, r.to_company, r.responsible, r.remarks,
        docTypes(r).join(' '),
        documents(r).map(function (d) { return [d.doc_no, d.rev, d.description].join(' '); }).join(' '),
        // ⚠️ The LINKED drawings are searchable too — searching a drawing code to find
        // the RFA holding it up is the single most likely thing anyone types here, and
        // a linked drawing's code appears nowhere in the RFA's own columns.
        linksFor(r.id).map(function (l) {
          var d = drawById[l.drawing_id];
          return [drawLabel(d), l.revision, d && d.title].filter(Boolean).join(' ');
        }).join(' ')
      ].join(' ').toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }
  function anyFilter() {
    return !!(filters.q || filters.discipline || filters.status || filters.type ||
      filters.overdue || filters.openOnly);
  }

  function filtered() {
    var list = rows.filter(matches);
    // ⚠️ DEFAULT ORDER IS "WORST FIRST", not by RFA number. This is a chase list:
    // the overdue ones lead, then the rest of the open queue by required date, then
    // everything closed. Sorting by number would bury a 40-day-old blocker.
    return list.sort(function (a, b) {
      var oa = isOpen(a) ? 0 : 1, ob = isOpen(b) ? 0 : 1;
      if (oa !== ob) return oa - ob;
      var da = overdueDays(a), db = overdueDays(b);
      if (oa === 0) {
        // Among open rows: most overdue first; undated ones last.
        if (da == null && db != null) return 1;
        if (db == null && da != null) return -1;
        if (da != null && db != null && da !== db) return db - da;
      }
      var ra = validDate(a.rfa_date) ? a.rfa_date : '', rb = validDate(b.rfa_date) ? b.rfa_date : '';
      if (ra !== rb) return rb.localeCompare(ra);
      return String(a.rfa_no || '').localeCompare(String(b.rfa_no || ''), undefined, { numeric: true });
    });
  }

  function statusPill(r) {
    var st = statusOf(r) || 'Draft';
    var m = statusMeta(st);
    return '<span class="rf-pill ' + (m ? m.cls : 'rf-s-draft') + '">' + esc(st) + '</span>';
  }
  function agePill(r) {
    var d = overdueDays(r);
    if (d == null) return '<span class="rf-mut">—</span>';
    if (d > 0) return '<span class="rf-age rf-late">' + d + 'd late</span>';
    if (d >= -7) return '<span class="rf-age rf-soon">due in ' + (-d) + 'd</span>';
    return '<span class="rf-age rf-ok">' + (-d) + 'd left</span>';
  }

  function renderRegistry() {
    var host = document.getElementById('rf-view');
    if (!rows.length) { host.innerHTML = emptyHTML(); wireEmpty(); return; }
    var list = filtered();
    var cnt = document.getElementById('rf-count');
    if (cnt) cnt.textContent = 'Showing ' + list.length + ' of ' + rows.length;

    if (!list.length) {
      host.innerHTML = '<div class="pd-card rf-empty"><h3>Nothing matches these filters</h3>' +
        '<p class="rf-mut">Clear them to see all ' + rows.length + ' RFAs.</p></div>';
      return;
    }

    var body = list.map(function (r) {
      var docs = documents(r);
      var types = docTypes(r);
      var lks = linksFor(r.id);
      return '<tr class="rf-row' + (isOverdue(r) ? ' rf-row-late' : '') + '" data-id="' + esc(r.id) + '">' +
        '<td class="rf-mono">' + esc(r.rfa_no || '—') +
          (r.revision ? '<span class="rf-rev">Rev ' + esc(r.revision) + '</span>' : '') + '</td>' +
        '<td><div class="rf-ttl">' + esc(r.title || '—') + '</div>' +
          (types.length ? '<div class="rf-sub">' + esc(types.slice(0, 2).join(', ')) +
            (types.length > 2 ? ' +' + (types.length - 2) : '') + '</div>' : '') +
          // ⚠️ THE LINKED DRAWINGS ARE THE HEADLINE, not the free-typed documents. An
          // RFA is recognised by the drawings it is trying to get approved, and that is
          // what people search for to find it. Linked ones are marked so a reader can
          // tell a real register link from a typed-in reference at a glance.
          (lks.length ? '<div class="rf-sub rf-mono rf-linked" title="' +
            esc(lks.length + ' drawing(s) linked to the register') + '">' + ico('ruler', 11) + ' ' +
            esc(lks.slice(0, 3).map(function (l) { return drawLabel(drawById[l.drawing_id]); }).join(', ')) +
            (lks.length > 3 ? ' +' + (lks.length - 3) : '') + '</div>' : '') +
          (docs.length ? '<div class="rf-sub rf-mono">' +
            esc(docs.slice(0, 3).map(function (d) { return d.doc_no || ''; }).filter(Boolean).join(', ')) +
            (docs.length > 3 ? ' +' + (docs.length - 3) : '') + '</div>' : '') +
        '</td>' +
        '<td>' + esc(r.discipline || '—') + '</td>' +
        '<td>' + statusPill(r) + '</td>' +
        '<td>' + esc(fmtDate(r.rfa_date) || '—') + '</td>' +
        '<td>' + esc(fmtDate(r.date_required) || '—') + '</td>' +
        '<td>' + agePill(r) + '</td>' +
        '<td>' + esc(r.to_company || r.to_name || '—') + '</td>' +
        '<td class="rf-act">' +
          (r.file_url ? '<button class="rf-ib" data-view="' + esc(r.file_url) + '" title="Open the attached document">' + ico('eye', 15) + '</button>' : '') +
          '<button class="rf-ib" data-sheet="' + esc(r.id) + '" title="Generate the RFA top sheet — the document is placed underneath it">' + ico('printer', 15) + '</button>' +
          (canWrite ? '<button class="rf-ib" data-edit="' + esc(r.id) + '" title="Edit">' + ico('pencil', 15) + '</button>' : '') +
          (canWrite ? '<button class="rf-ib rf-ib-d" data-del="' + esc(r.id) + '" title="Delete">' + ico('trash', 15) + '</button>' : '') +
        '</td></tr>';
    }).join('');

    host.innerHTML = '<div class="pd-card rf-tablecard"><table class="pd-table rf-tbl rf-grid">' +
      '<thead><tr>' +
        '<th>RFA No.</th><th>Title / documents</th><th>Discipline</th><th>Status</th>' +
        '<th>Issued</th><th>Required</th><th>Age</th><th>With</th><th class="rf-act"></th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>';

    host.querySelectorAll('[data-view]').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); viewFile(b.dataset.view); };
    });
    host.querySelectorAll('[data-sheet]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        openTopSheet(rows.find(function (x) { return String(x.id) === b.dataset.sheet; }));
      };
    });
    host.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        openForm(rows.find(function (x) { return String(x.id) === b.dataset.edit; }));
      };
    });
    host.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); delRow(b.dataset.del); };
    });
    host.querySelectorAll('tr.rf-row').forEach(function (tr) {
      tr.onclick = function (e) {
        if (e.target.closest('button')) return;
        openForm(rows.find(function (x) { return String(x.id) === tr.dataset.id; }));
      };
    });
  }

  function emptyHTML() {
    return '<div class="pd-card rf-empty"><h3>No RFAs raised yet</h3>' +
      '<p>An RFA transmits a document — a method statement, shop drawings, a schedule — ' +
      'to the consultant or client for approval. Raise one here and the app generates the ' +
      'F-GEN011 top sheet with the document placed underneath it, ready to issue.</p>' +
      (canWrite ? '<p style="margin-top:14px;"><button class="pd-btn pd-btn-primary" id="rf-e-add">Raise the first RFA</button></p>' : '') +
      '</div>';
  }
  function wireEmpty() {
    var b = document.getElementById('rf-e-add');
    if (b) b.onclick = function () { openForm(null); };
  }

  // ---- attachments ---------------------------------------------------------
  async function uploadFile(file) {
    var safe = String(file.name).replace(/[^\w.\-]+/g, '_').slice(-120);
    // Namespaced under rfa/ inside the shared bucket so the two registers' objects
    // are distinguishable when someone is looking at storage directly.
    var path = pid + '/rfa/' + Date.now() + '_' + safe;
    var res = await sb().storage.from(BUCKET).upload(path, file, { upsert: false });
    if (res.error) throw res.error;
    return path;
  }
  async function viewFile(path) {
    var res = await sb().storage.from(BUCKET).createSignedUrl(path, 60);
    if (res.error) { UI.toast('Could not open the file: ' + res.error.message, 'error'); return; }
    window.open(res.data.signedUrl, '_blank', 'noopener');
  }
  async function removeFiles(paths) {
    var list = (paths || []).filter(Boolean);
    if (!list.length) return;
    // Best-effort: a failed object delete must never block the row delete, or the
    // user cannot remove a record because of a storage hiccup.
    try { await sb().storage.from(BUCKET).remove(list); } catch (e) {}
  }
  // Fetch the attachment as a Blob so it can be merged under the top sheet.
  // Returns null rather than throwing — buildPackage() reports a missing document
  // and still produces the sheet, which beats failing the whole generate.
  async function fetchAttachment(path, bucket) {
    try {
      var res = await sb().storage.from(bucket || BUCKET).createSignedUrl(path, 120);
      if (res.error || !res.data) return null;
      var r = await fetch(res.data.signedUrl);
      if (!r.ok) return null;
      return await r.blob();
    } catch (e) { return null; }
  }

  // ---- top sheet -----------------------------------------------------------
  async function ensureTsDefaults() {
    if (tsDefaults && tsDefaults.__pid === pid) return tsDefaults;
    var d = await TopSheet.loadDefaults(pid);
    d = d || {}; d.__pid = pid;
    tsDefaults = d;
    return d;
  }

  // Map a register row onto the fields the F-GEN011 sheet prints.
  // ⚠️ This is the join between the register and the form, and it is the reason the
  // register exists: every field here used to be typed by hand onto a blank sheet.
  function rfaDataOf(r, defaults) {
    return {
      projectName: projName(), projectCode: pid,
      client: defaults.client_name || '',
      rfaId: r.rfa_no || '',
      date: r.rfa_date || '', dateRequired: r.date_required || '',
      to: r.to_name || defaults.default_to || '',
      toCompany: r.to_company || '',
      from: r.from_name || defaults.default_from || '',
      fromCompany: r.from_company || 'MEGAWIDE CONSTRUCTION CORPORATION',
      category: r.category || '', subCategory: r.sub_category || '',
      // The sheet's Yes/No checkbox pair is answered from whether a document is
      // actually attached, not from a field someone has to remember to set.
      attachments: r.file_url ? 'Yes' : 'No',
      types: docTypes(r).slice(),
      // ⚠️ LINKED DRAWINGS LEAD, then the free-typed documents. The sheet's document
      // table is what the consultant signs against, so a drawing that is linked must
      // print with the code and revision THIS RFA transmitted — `link.revision`, not
      // the drawing's current one, which has moved on if it was reissued since.
      documents: linksFor(r.id).map(function (l) {
        var d = drawById[l.drawing_id];
        return {
          doc_no: drawLabel(d),
          rev: l.revision || (d && d.revision) || '',
          description: (d && d.title) || '',
          pages: l.pages != null ? l.pages : (d && d.no_of_sheets) || null
        };
      }).concat(documents(r)),
      preparedBy: r.prepared_by || (PROFILE && PROFILE.name) || '',
      checkedBy: r.checked_by || '', approvedBy: r.approved_by || ''
    };
  }

  // Which stored file represents a linked drawing on THIS RFA.
  // ⚠️ THE REVISION'S OWN FILE WINS over the drawing's current file. The register keeps
  // a file per submitted revision (`submissions[].file_url`) as well as one row-level
  // file that is "the current/approved version" — so for an RFA that transmitted Rev 1,
  // Rev 1's file is what was actually sent. Falling straight to the row-level file
  // would attach whatever has been uploaded since, which on a signed transmittal is
  // the wrong document.
  function drawingFileOf(link) {
    var d = drawById[link.drawing_id];
    if (!d) return null;
    var subs = Array.isArray(d.submissions) ? d.submissions
      : (typeof d.submissions === 'string' ? (function () { try { return JSON.parse(d.submissions) || []; } catch (e) { return []; } })() : []);
    var want = String(link.revision == null ? '' : link.revision).trim();
    if (want !== '') {
      for (var i = 0; i < subs.length; i++) {
        var s = subs[i] || {};
        if (s.file_url && String(s.rev == null ? '' : s.rev).trim() === want) return s.file_url;
      }
    }
    return d.file_url || null;
  }

  // Everything that goes UNDER the top sheet, in the order the sheet lists it:
  // the linked drawings' own files first, then the RFA's own attachment.
  // ⚠️ A LINKED DRAWING WITH NO FILE IS REPORTED, NOT IGNORED. The RFA asks the
  // consultant to approve that drawing, so a package that quietly lacks it is a
  // package that cannot be approved — and it looks complete. Those drawings are
  // counted and named on the dialog before anything is generated.
  function topSheetAttachments(r) {
    var out = [];
    linksFor(r.id).forEach(function (l) {
      var path = drawingFileOf(l);
      if (!path) return;
      var d = drawById[l.drawing_id];
      var base = fileLabel(path);
      // Named by DRAWING CODE, not by whatever the file happened to be called on
      // someone's desktop. The consultant is looking for A-1204, not scan_003.pdf.
      var nm = drawLabel(d) + (l.revision ? ' Rev ' + l.revision : '') +
        (/\.[a-z0-9]{2,5}$/i.test(base) ? base.slice(base.lastIndexOf('.')) : '');
      out.push({
        name: nm,
        type: /\.pdf$/i.test(base) ? 'application/pdf' : '',
        get: function () { return fetchAttachment(path, DRAW_BUCKET); }
      });
    });
    if (r && r.file_url) {
      var name = fileLabel(r.file_url);
      out.push({
        name: name,
        type: /\.pdf$/i.test(name) ? 'application/pdf' : '',
        get: function () { return fetchAttachment(r.file_url, BUCKET); }
      });
    }
    return out;
  }

  // Linked drawings that have no file to attach — the thing the user needs telling.
  function drawingsWithoutFile(r) {
    return linksFor(r.id).filter(function (l) { return !drawingFileOf(l); })
      .map(function (l) { return drawLabel(drawById[l.drawing_id]); });
  }

  async function openTopSheet(r) {
    if (!pid) { UI.toast('Select a project first.', 'error'); return; }
    if (!r) return;
    var defaults = await ensureTsDefaults();
    var noFile = drawingsWithoutFile(r);
    TopSheet.open({
      kind: 'RFA',
      project: { id: pid, name: projName() },
      defaults: defaults,
      attachments: topSheetAttachments(r),
      // ⚠️ Stated BEFORE anything is generated. A drawing this RFA asks approval for,
      // with no file in the register to send, is the one failure that produces a
      // package which looks complete and cannot be approved.
      notes: noFile.length
        ? ['<strong>' + noFile.length + ' linked drawing' + (noFile.length > 1 ? 's have' : ' has') +
           ' no file in the Drawing Register</strong>, so ' + (noFile.length > 1 ? 'they' : 'it') +
           ' cannot be attached: ' + noFile.slice(0, 6).join(', ') +
           (noFile.length > 6 ? ' and ' + (noFile.length - 6) + ' more' : '') +
           '. Upload the drawing there, or issue this RFA without it deliberately.']
        : [],
      data: rfaDataOf(r, defaults)
    });
  }

  // ==========================================================================
  // RECORDING THE APPROVAL BACK ONTO THE DRAWINGS
  // --------------------------------------------------------------------------
  // When the consultant approves an RFA, the drawings it carried are approved. But
  // ⚠️⚠️ THE DRAWING REGISTER OWNS A DRAWING'S APPROVAL, AND THIS MUST NOT BECOME A
  // SECOND SOURCE OF TRUTH FOR IT. That module's notes document the exact failure at
  // length: a drawing that was marked Approved as one row, then broken into 15
  // sheets, kept a stale "Approved" pill over counters reading 0/15 — the pill said
  // done, the numbers said nothing was. So:
  //
  //   1. IT IS NEVER AUTOMATIC. Nothing is written by saving an RFA or by setting its
  //      status. A planner presses a button, having seen exactly which drawings will
  //      be touched. An approval silently propagating across modules is how a register
  //      ends up disagreeing with itself with nobody having decided anything.
  //   2. A SHEET-TRACKED DRAWING IS REFUSED, not resolved. Where a drawing is tracked
  //      per sheet its status is DERIVED from its sheets; writing a status onto the
  //      parent is precisely the stale-pill bug above. Those drawings are listed and
  //      skipped, with the reason, so the approval is recorded per sheet in the
  //      Drawing Register where the rules live.
  //   3. Only `status` and `actual_approval` are written. No counter is touched:
  //      drawing_register derives approved_sheets from status for a single-sheet row
  //      itself, and guessing at it from here would fight that rule.
  // ==========================================================================
  function approvalTargets(r) {
    var out = { ok: [], sheetTracked: [], missing: [], already: [] };
    linksFor(r.id).forEach(function (l) {
      var d = drawById[l.drawing_id];
      if (!d) { out.missing.push(l.drawing_id); return; }
      if (isSheetTracked(d.id)) { out.sheetTracked.push(d); return; }
      // Already carrying this approval — writing again would only churn updated_at
      // and add a meaningless audit row.
      if (/^Approved/i.test(d.status || '') && d.actual_approval) { out.already.push(d); return; }
      out.ok.push(d);
    });
    return out;
  }

  async function recordApprovalOnDrawings(r) {
    if (!isPlanner) { UI.toast('Recording an approval on the drawings requires a planner.', 'error'); return; }
    if (!isApproved(r)) {
      UI.toast('This RFA is not approved, so there is no approval to record.', 'error');
      return;
    }
    var t = approvalTargets(r);
    if (!t.ok.length) {
      UI.toast(t.sheetTracked.length
        ? 'Every linked drawing is tracked per sheet — record those approvals in the Drawing Register, sheet by sheet.'
        : (t.already.length ? 'Those drawings already carry this approval.' : 'No linked drawings to update.'),
        t.ok.length ? 'ok' : 'warn');
      return;
    }
    // The status the RFA actually came back with is what gets recorded — an
    // "Approved w/ comments" RFA must not land on the drawings as a clean approval,
    // which is a materially different outcome the drawing register also distinguishes.
    var st = statusOf(r) === 'Approved w/ comments' ? 'Approved w/ comments' : 'Approved';
    var when = (r.decision_date || r.date_returned || todayISO()).slice(0, 10);

    var msg = 'Record "' + st + '" on ' + t.ok.length + ' drawing' + (t.ok.length > 1 ? 's' : '') +
      ', approved ' + fmtDate(when) + '?\n\n' +
      t.ok.slice(0, 12).map(function (d) { return '  • ' + drawLabel(d); }).join('\n') +
      (t.ok.length > 12 ? '\n  … and ' + (t.ok.length - 12) + ' more' : '') +
      (t.sheetTracked.length ? '\n\nSKIPPED — tracked per sheet, so their status is derived from their sheets:\n' +
        t.sheetTracked.slice(0, 8).map(function (d) { return '  • ' + drawLabel(d); }).join('\n') : '') +
      (t.already.length ? '\n\nAlready approved: ' + t.already.length : '');
    if (!await UI.confirm(msg)) return;

    var done = 0, failed = [];
    for (var i = 0; i < t.ok.length; i++) {
      var d = t.ok[i];
      try {
        var res = await sb().from('drawing_register')
          .update({ status: st, actual_approval: when, updated_at: new Date().toISOString() })
          .eq('id', d.id);
        if (res.error) throw res.error;
        d.status = st; d.actual_approval = when;      // keep the local index honest
        done++;
      } catch (e) { failed.push(drawLabel(d) + ': ' + ((e && e.message) || e)); }
    }
    if (failed.length) {
      // Named, not counted: "3 failed" is unactionable, and a partial write is
      // exactly the state someone needs to reconcile by hand.
      UI.toast('Recorded on ' + done + '; could not update ' + failed.length + ' — ' + failed[0], 'error');
    } else {
      UI.toast('Recorded "' + st + '" on ' + done + ' drawing' + (done > 1 ? 's' : '') +
        (t.sheetTracked.length ? ' · ' + t.sheetTracked.length + ' skipped (tracked per sheet)' : ''), 'ok');
    }
  }

  // ---- form ----------------------------------------------------------------
  function opts(list, cur, blank) {
    return (blank ? '<option value="">' + esc(blank) + '</option>' : '') +
      list.map(function (o) {
        return '<option' + (String(cur || '') === String(o) ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('');
  }

  function docRowHTML(d, i) {
    d = d || {};
    return '<tr class="rf-doc-r" data-i="' + i + '">' +
      '<td><input class="pd-input rf-d" data-f="doc_no" value="' + esc(d.doc_no || '') + '" /></td>' +
      '<td><input class="pd-input rf-d rf-w-rev" data-f="rev" value="' + esc(d.rev || '') + '" /></td>' +
      '<td><input class="pd-input rf-d" data-f="description" value="' + esc(d.description || '') + '" /></td>' +
      '<td><input class="pd-input rf-d rf-w-pg" data-f="pages" type="number" min="0" value="' + esc(d.pages == null ? '' : d.pages) + '" /></td>' +
      '<td><button type="button" class="rf-ib rf-ib-d rf-doc-rm" title="Remove this document">&times;</button></td></tr>';
  }

  function openForm(r) {
    if (!canWrite && !r) { UI.toast('You do not have permission to raise an RFA.', 'error'); return; }
    var e = r || {};
    var RFA_TYPES = (TopSheet._internals && TopSheet._internals.RFA_TYPES) || [];
    var flatTypes = []; RFA_TYPES.forEach(function (row) { flatTypes = flatTypes.concat(row); });
    var chosen = docTypes(e);
    var docs = documents(e);
    var ro = canWrite ? '' : ' disabled';

    // ⚠️ The gated statuses are offered only to a planner. The DB guard (0020)
    // refuses them anyway, so offering them to everyone would produce a save that
    // fails with a permission error after the user has filled the form in.
    var statusList = STATUS_ORDER.filter(function (n) {
      var m = statusMeta(n);
      return isPlanner || !(m && (m.approved || n === 'Rejected' || n === 'Resubmit'));
    });
    // Keep the row's CURRENT status selectable even if this user could not set it,
    // or saving any other field would silently move it.
    if (statusOf(e) && statusList.indexOf(statusOf(e)) === -1) statusList = statusList.concat([statusOf(e)]);

    var m = UI.modal(
      '<div class="pd-modal-header"><h2 style="margin:0;">' +
        (r ? 'RFA ' + esc(e.rfa_no || '') : 'Raise an RFA') + '</h2>' +
        '<button class="pd-btn" id="rf-fx" title="Close">&times;</button></div>' +
      '<div class="rf-form">' +
        '<div class="rf-fsec">Identity</div>' +
        '<div class="rf-f3">' +
          '<label class="rf-fld"><span>RFA No.</span><input class="pd-input" id="f-rfa_no" value="' + esc(e.rfa_no || '') + '"' + ro + ' /></label>' +
          '<label class="rf-fld"><span>Revision</span><input class="pd-input" id="f-revision" value="' + esc(e.revision || '') + '"' + ro + ' /></label>' +
          '<label class="rf-fld"><span>Discipline</span><select class="pd-select" id="f-discipline"' + ro + '>' + opts(DISCIPLINES, e.discipline, '—') + '</select></label>' +
        '</div>' +
        '<label class="rf-fld"><span>Title</span><input class="pd-input" id="f-title" value="' + esc(e.title || '') + '"' + ro + ' /></label>' +
        '<label class="rf-fld"><span>Description</span><textarea class="pd-input" id="f-description" rows="3"' + ro + '>' + esc(e.description || '') + '</textarea></label>' +
        '<div class="rf-f2">' +
          '<label class="rf-fld"><span>Category</span><input class="pd-input" id="f-category" value="' + esc(e.category || '') + '"' + ro + ' /></label>' +
          '<label class="rf-fld"><span>Sub-category</span><input class="pd-input" id="f-sub_category" value="' + esc(e.sub_category || '') + '"' + ro + ' /></label>' +
        '</div>' +

        '<div class="rf-fsec">Document types <span class="rf-mut">— exactly what the sheet ticks</span></div>' +
        '<div class="rf-typegrid">' + flatTypes.map(function (t) {
          return '<label><input type="checkbox" class="rf-ft" value="' + esc(t) + '"' +
            (chosen.indexOf(t) !== -1 ? ' checked' : '') + ro + ' /> ' + esc(t) + '</label>';
        }).join('') + '</div>' +

        '<div class="rf-fsec">Drawings this RFA seeks approval for ' +
          '<span class="rf-mut">— linked to the Drawing Register</span></div>' +
        (drawErr
          ? '<p class="rf-mut"><strong class="rf-late">The drawing link is unavailable.</strong> ' +
            esc(drawErr) + ' If this says a table does not exist, run ' +
            '<code>migrations/0020-request-for-approval.sql</code>. The RFA still saves — ' +
            'no link is recorded.</p>'
          : (canWrite ? '<div class="rf-pick">' +
              '<input class="pd-input" id="rf-pick-q" placeholder="Type a drawing code or title to link it…" autocomplete="off" />' +
              '<div class="rf-pick-list" id="rf-pick-list" hidden></div></div>' : '') +
            '<div id="rf-links"></div>') +

        '<div class="rf-fsec">Other documents transmitted ' +
          '<span class="rf-mut">— method statements, schedules, reports: anything not in the register</span>' +
          (canWrite ? ' <button type="button" class="pd-btn pd-btn-sm" id="rf-doc-add">+ Row</button>' : '') + '</div>' +
        '<table class="pd-table rf-doctbl"><thead><tr>' +
          '<th>Document No.</th><th>Rev</th><th>Description</th><th>Pages</th><th></th>' +
        '</tr></thead><tbody id="rf-docs">' +
          (docs.length ? docs.map(docRowHTML).join('') : docRowHTML({}, 0)) +
        '</tbody></table>' +

        '<div class="rf-fsec">Routing</div>' +
        '<div class="rf-f2">' +
          '<label class="rf-fld"><span>To — name &amp; position</span><input class="pd-input" id="f-to_name" value="' + esc(e.to_name || '') + '"' + ro + ' /></label>' +
          '<label class="rf-fld"><span>To — company</span><input class="pd-input" id="f-to_company" value="' + esc(e.to_company || '') + '"' + ro + ' /></label>' +
          '<label class="rf-fld"><span>From — name &amp; position</span><input class="pd-input" id="f-from_name" value="' + esc(e.from_name || '') + '"' + ro + ' /></label>' +
          '<label class="rf-fld"><span>From — company</span><input class="pd-input" id="f-from_company" value="' + esc(e.from_company || '') + '"' + ro + ' /></label>' +
        '</div>' +

        '<div class="rf-fsec">Dates</div>' +
        '<div class="rf-f4">' +
          '<label class="rf-fld"><span>RFA date</span><input class="pd-input" id="f-rfa_date" type="date" value="' + esc((e.rfa_date || '').slice(0, 10)) + '"' + ro + ' /></label>' +
          '<label class="rf-fld"><span>Date required</span><input class="pd-input" id="f-date_required" type="date" value="' + esc((e.date_required || '').slice(0, 10)) + '"' + ro + ' /></label>' +
          '<label class="rf-fld"><span>Date submitted</span><input class="pd-input" id="f-date_submitted" type="date" value="' + esc((e.date_submitted || '').slice(0, 10)) + '"' + ro + ' /></label>' +
          '<label class="rf-fld"><span>Date returned</span><input class="pd-input" id="f-date_returned" type="date" value="' + esc((e.date_returned || '').slice(0, 10)) + '"' + ro + ' /></label>' +
        '</div>' +
        '<p class="rf-mut" id="rf-datehint"></p>' +

        '<div class="rf-fsec">Attached document</div>' +
        '<div class="rf-filebox" id="rf-filebox"></div>' +
        '<p class="rf-mut">This is the document the top sheet covers — it is merged underneath the ' +
          'sheet when you generate or email it. Only a PDF can be merged; anything else travels as a ' +
          'separate file.</p>' +

        '<div class="rf-fsec">Decision</div>' +
        '<div class="rf-f3">' +
          '<label class="rf-fld"><span>Status</span><select class="pd-select" id="f-status"' + ro + '>' + opts(statusList, statusOf(e), '—') + '</select></label>' +
          '<label class="rf-fld"><span>Decided by</span><input class="pd-input" id="f-decision_by" value="' + esc(e.decision_by || '') + '"' + ro + ' /></label>' +
          '<label class="rf-fld"><span>Decision date</span><input class="pd-input" id="f-decision_date" type="date" value="' + esc((e.decision_date || '').slice(0, 10)) + '"' + ro + ' /></label>' +
        '</div>' +
        (isPlanner ? '' : '<p class="rf-mut">Recording an approval or rejection is a planner action, ' +
          'so those statuses are not offered here. The database enforces the same rule.</p>') +
        '<label class="rf-fld"><span>Review status — the reviewer\'s own words</span><input class="pd-input" id="f-review_status" value="' + esc(e.review_status || '') + '"' + ro + ' /></label>' +
        '<div class="rf-f2">' +
          '<label class="rf-fld"><span>Consultant\'s comments</span><textarea class="pd-input" id="f-consultant_comments" rows="3"' + ro + '>' + esc(e.consultant_comments || '') + '</textarea></label>' +
          '<label class="rf-fld"><span>Client / owner\'s comments</span><textarea class="pd-input" id="f-client_comments" rows="3"' + ro + '>' + esc(e.client_comments || '') + '</textarea></label>' +
        '</div>' +

        '<div class="rf-fsec">Signatures &amp; notes</div>' +
        '<div class="rf-f3">' +
          '<label class="rf-fld"><span>Prepared by</span><input class="pd-input" id="f-prepared_by" value="' + esc(e.prepared_by || (r ? '' : (PROFILE && PROFILE.name) || '')) + '"' + ro + ' /></label>' +
          '<label class="rf-fld"><span>Checked by</span><input class="pd-input" id="f-checked_by" value="' + esc(e.checked_by || '') + '"' + ro + ' /></label>' +
          '<label class="rf-fld"><span>Approved by</span><input class="pd-input" id="f-approved_by" value="' + esc(e.approved_by || '') + '"' + ro + ' /></label>' +
        '</div>' +
        '<div class="rf-f2">' +
          '<label class="rf-fld"><span>Responsible</span><input class="pd-input" id="f-responsible" value="' + esc(e.responsible || '') + '"' + ro + ' /></label>' +
          '<label class="rf-fld"><span>Remarks</span><input class="pd-input" id="f-remarks" value="' + esc(e.remarks || '') + '"' + ro + ' /></label>' +
        '</div>' +
      '</div>' +
      '<div class="pd-modal-actions">' +
        '<button class="pd-btn" id="rf-fcancel">Close</button>' +
        // Offered only when there is actually an approval to record and drawings to
        // record it on — a button that explains itself by being absent.
        (r && isPlanner && isApproved(e) && linksFor(e.id).length
          ? '<button class="pd-btn" id="rf-frecord" title="Write this approval onto the linked drawings in the Drawing Register">Record on drawings…</button>' : '') +
        (r ? '<button class="pd-btn" id="rf-fsheet">Top sheet…</button>' : '') +
        (canWrite ? '<button class="pd-btn pd-btn-primary" id="rf-fsave">Save</button>' : '') +
      '</div>', { wide: true, noBackdropClose: true });

    // ---- attachment control (deferred delete, like the sibling registers) ----
    var newFile = null, dropFile = false;
    function paintFile() {
      var box = m.el.querySelector('#rf-filebox');
      var have = (e.file_url && !dropFile) || newFile;
      if (newFile) {
        box.innerHTML = '<div class="rf-fileline">' + ico('upload', 15) + ' <strong>' + esc(newFile.name) + '</strong> ' +
          '<span class="rf-mut">will be uploaded on save</span>' +
          '<button type="button" class="rf-ib rf-ib-d" id="rf-file-clear" title="Cancel this upload">&times;</button></div>';
      } else if (e.file_url && !dropFile) {
        box.innerHTML = '<div class="rf-fileline">' + ico('eye', 15) + ' <strong>' + esc(fileLabel(e.file_url)) + '</strong> ' +
          '<button type="button" class="pd-btn pd-btn-sm" id="rf-file-open">Open</button>' +
          (canWrite ? '<button type="button" class="rf-ib rf-ib-d" id="rf-file-rm" title="Remove on save">&times;</button>' : '') +
          '</div>';
      } else {
        box.innerHTML = (canWrite
          ? '<input type="file" class="pd-input" id="rf-file-in" accept=".pdf,.doc,.docx,.xls,.xlsx,.dwg,.png,.jpg,.jpeg" />'
          : '<span class="rf-mut">No document attached.</span>') +
          (dropFile && e.file_url ? '<div class="rf-mut">The existing document will be removed when you save. ' +
            '<button type="button" class="pd-btn pd-btn-sm" id="rf-file-undo">Undo</button></div>' : '');
      }
      var i = m.el.querySelector('#rf-file-in');
      if (i) i.onchange = function () { newFile = i.files && i.files[0]; paintFile(); };
      var o = m.el.querySelector('#rf-file-open');
      if (o) o.onclick = function () { viewFile(e.file_url); };
      // ⚠️ ✕ is DEFERRED to Save, never immediate — cancelling the dialog must not
      // have deleted the file. Same rule the sibling registers document.
      var rm = m.el.querySelector('#rf-file-rm');
      if (rm) rm.onclick = function () { dropFile = true; paintFile(); };
      var un = m.el.querySelector('#rf-file-undo');
      if (un) un.onclick = function () { dropFile = false; paintFile(); };
      var cl = m.el.querySelector('#rf-file-clear');
      if (cl) cl.onclick = function () { newFile = null; paintFile(); };
    }
    paintFile();

    // ---- linked drawings ----------------------------------------------------
    // Working copy, so cancelling the dialog changes nothing. `revision` is seeded
    // from the drawing's CURRENT revision at the moment of linking, and is then the
    // user's to correct — it records what this RFA transmitted, not what the drawing
    // says today.
    var work = linksFor(e.id).map(function (l) {
      return { drawing_id: l.drawing_id, revision: l.revision || '', pages: l.pages };
    });

    function paintLinks() {
      var box = m.el.querySelector('#rf-links');
      if (!box) return;
      if (!work.length) {
        box.innerHTML = '<p class="rf-mut">No drawings linked yet. An RFA that transmits drawings ' +
          'should link them — that is what lets the Drawing Register show which RFA a drawing is ' +
          'waiting on, and what puts the right codes and revisions on the printed sheet.</p>';
        return;
      }
      box.innerHTML = '<table class="pd-table rf-doctbl"><thead><tr>' +
        '<th>Drawing</th><th>Title</th><th>Rev sent</th><th>Pages</th><th>Register status</th><th></th>' +
        '</tr></thead><tbody>' +
        work.map(function (l, i) {
          var d = drawById[l.drawing_id];
          return '<tr data-li="' + i + '">' +
            '<td class="rf-mono">' + esc(drawLabel(d)) +
              // A drawing tracked per sheet is flagged HERE, at the moment of linking,
              // because it is the one the approval write-back will refuse.
              (d && isSheetTracked(d.id) ? '<span class="rf-rev" title="Tracked per sheet — its approval is recorded sheet by sheet in the Drawing Register">per sheet</span>' : '') +
            '</td>' +
            '<td>' + esc((d && d.title) || '') + '</td>' +
            '<td><input class="pd-input rf-l rf-w-rev" data-f="revision" value="' + esc(l.revision || '') + '"' + ro + ' /></td>' +
            '<td><input class="pd-input rf-l rf-w-pg" data-f="pages" type="number" min="0" value="' +
              esc(l.pages == null ? '' : l.pages) + '"' + ro + ' /></td>' +
            '<td>' + (d ? '<span class="rf-mut">' + esc(d.status || 'Not started') + '</span>' : '<span class="rf-late">deleted</span>') + '</td>' +
            '<td>' + (canWrite ? '<button type="button" class="rf-ib rf-ib-d rf-l-rm" title="Unlink this drawing">&times;</button>' : '') + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table>';

      box.querySelectorAll('.rf-l').forEach(function (inp) {
        inp.onchange = function () {
          var i = +inp.closest('tr').dataset.li;
          var f = inp.dataset.f;
          work[i][f] = f === 'pages' ? (inp.value === '' ? null : +inp.value) : inp.value.trim();
        };
      });
      box.querySelectorAll('.rf-l-rm').forEach(function (b) {
        b.onclick = function () { work.splice(+b.closest('tr').dataset.li, 1); paintLinks(); };
      });
    }
    paintLinks();

    var pq = m.el.querySelector('#rf-pick-q');
    if (pq) {
      var plist = m.el.querySelector('#rf-pick-list');
      var hide = function () { plist.hidden = true; };
      var search = function () {
        var q = pq.value.trim().toLowerCase();
        if (!q) { hide(); return; }
        var linked = {};
        work.forEach(function (l) { linked[l.drawing_id] = true; });
        // AND over whitespace-separated terms, over code + title — the same matching
        // the drawing register's own activity picker settled on, and the reason a
        // <datalist> could not be used: it filters on the option VALUE only, which
        // here has to be the id.
        var terms = q.split(/\s+/);
        var hits = drawings.filter(function (d) {
          if (linked[d.id]) return false;              // already on this RFA
          var hay = (drawLabel(d) + ' ' + (d.title || '') + ' ' + (d.discipline || '')).toLowerCase();
          return terms.every(function (t) { return hay.indexOf(t) !== -1; });
        });
        var CAP = 40;
        plist.innerHTML = hits.slice(0, CAP).map(function (d) {
          return '<button type="button" class="rf-pick-i" data-id="' + esc(d.id) + '">' +
            '<span class="rf-mono">' + esc(drawLabel(d)) + '</span> ' +
            '<span class="rf-mut">' + esc(d.title || '') + '</span>' +
            (d.revision ? '<span class="rf-rev">Rev ' + esc(d.revision) + '</span>' : '') +
            (isSheetTracked(d.id) ? '<span class="rf-rev">per sheet</span>' : '') +
            '</button>';
        }).join('') ||
          '<div class="rf-pick-none">No drawing matches — ' +
          (drawings.length ? 'check the code, or add it as an "other document" below.'
                           : 'this project\'s Drawing Register is empty.') + '</div>';
        if (hits.length > CAP) {
          plist.insertAdjacentHTML('beforeend',
            '<div class="rf-pick-none">' + (hits.length - CAP) + ' more — keep typing to narrow.</div>');
        }
        plist.hidden = false;
        plist.querySelectorAll('.rf-pick-i').forEach(function (b) {
          b.onclick = function () {
            var d = drawById[b.dataset.id];
            work.push({ drawing_id: b.dataset.id, revision: (d && d.revision) || '', pages: (d && d.no_of_sheets) || null });
            pq.value = ''; hide(); paintLinks();
          };
        });
      };
      var t2 = null;
      pq.addEventListener('input', function () { clearTimeout(t2); t2 = setTimeout(search, 120); });
      pq.addEventListener('focus', search);
      pq.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { hide(); return; }
        // Enter takes the first hit — the fastest path when you know the code.
        if (ev.key === 'Enter') {
          ev.preventDefault();
          var first = plist.querySelector('.rf-pick-i');
          if (first) first.click();
        }
      });
      // Clicking away closes the list, but not when the click IS a result.
      document.addEventListener('mousedown', function (ev) {
        if (plist && !plist.hidden && !plist.contains(ev.target) && ev.target !== pq) hide();
      });
    }

    // ---- document rows ------------------------------------------------------
    function wireDocs() {
      m.el.querySelectorAll('.rf-doc-rm').forEach(function (b) {
        b.onclick = function () {
          var tb = m.el.querySelector('#rf-docs');
          if (tb.rows.length <= 1) {
            // Never leave the table with no row: an empty <tbody> reads as broken,
            // and the blank row IS the "add one" affordance.
            tb.rows[0].querySelectorAll('input').forEach(function (i) { i.value = ''; });
            return;
          }
          b.closest('tr').remove();
        };
      });
    }
    wireDocs();
    var addBtn = m.el.querySelector('#rf-doc-add');
    if (addBtn) addBtn.onclick = function () {
      var tb = m.el.querySelector('#rf-docs');
      tb.insertAdjacentHTML('beforeend', docRowHTML({}, tb.rows.length));
      wireDocs();
    };

    // A required date before the RFA date is a typo worth pointing at, live.
    function checkDates() {
      var a = m.el.querySelector('#f-rfa_date').value;
      var b = m.el.querySelector('#f-date_required').value;
      var h = m.el.querySelector('#rf-datehint');
      if (a && b && b < a) {
        h.innerHTML = '<strong class="rf-late">The required date is before the RFA date.</strong> ' +
          'Saving is still allowed — check which one is wrong.';
      } else if (b) {
        var d = daysBetween(a || todayISO(), b);
        h.textContent = d == null ? '' : (d >= 0 ? d + ' days allowed for the reply.' : '');
      } else { h.textContent = ''; }
    }
    ['f-rfa_date', 'f-date_required'].forEach(function (id) {
      var el = m.el.querySelector('#' + id);
      if (el) el.addEventListener('change', checkDates);
    });
    checkDates();

    m.el.querySelector('#rf-fx').onclick = m.close;
    m.el.querySelector('#rf-fcancel').onclick = m.close;
    var sheetBtn = m.el.querySelector('#rf-fsheet');
    if (sheetBtn) sheetBtn.onclick = function () { openTopSheet(r); };
    var recBtn = m.el.querySelector('#rf-frecord');
    if (recBtn) recBtn.onclick = async function () {
      await recordApprovalOnDrawings(r);
      paintLinks();          // the register statuses shown beside each link have moved
    };

    var saveBtn = m.el.querySelector('#rf-fsave');
    if (saveBtn) saveBtn.onclick = async function () {
      var v = function (id) { var el = m.el.querySelector('#' + id); return el ? el.value.trim() : ''; };
      var dt = function (id) { return v(id) || null; };

      var types = [];
      m.el.querySelectorAll('.rf-ft').forEach(function (cb) { if (cb.checked) types.push(cb.value); });

      var docsOut = [];
      m.el.querySelectorAll('#rf-docs tr').forEach(function (tr) {
        var get = function (f) {
          var el = tr.querySelector('[data-f="' + f + '"]');
          return el ? el.value.trim() : '';
        };
        var o = { doc_no: get('doc_no'), rev: get('rev'), description: get('description'), pages: get('pages') };
        o.pages = o.pages === '' ? null : (isNaN(+o.pages) ? null : +o.pages);
        // A wholly blank row is the affordance, not data.
        if (o.doc_no || o.rev || o.description || o.pages != null) docsOut.push(o);
      });

      var patch = {
        project_id: pid,
        rfa_no: v('f-rfa_no') || null, revision: v('f-revision') || null,
        title: v('f-title') || null, description: v('f-description') || null,
        category: v('f-category') || null, sub_category: v('f-sub_category') || null,
        discipline: v('f-discipline') || null,
        doc_types: types, documents: docsOut,
        to_name: v('f-to_name') || null, to_company: v('f-to_company') || null,
        from_name: v('f-from_name') || null, from_company: v('f-from_company') || null,
        rfa_date: dt('f-rfa_date'), date_required: dt('f-date_required'),
        date_submitted: dt('f-date_submitted'), date_returned: dt('f-date_returned'),
        status: v('f-status') || null, review_status: v('f-review_status') || null,
        decision_by: v('f-decision_by') || null, decision_date: dt('f-decision_date'),
        consultant_comments: v('f-consultant_comments') || null,
        client_comments: v('f-client_comments') || null,
        prepared_by: v('f-prepared_by') || null, checked_by: v('f-checked_by') || null,
        approved_by: v('f-approved_by') || null,
        responsible: v('f-responsible') || null, remarks: v('f-remarks') || null,
        updated_at: new Date().toISOString()
      };

      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      var uploaded = null;
      try {
        // ⚠️ UPLOAD BEFORE THE ROW WRITE, so a failed upload cannot leave a row
        // claiming a document that is not there. If the row write then fails, the
        // object we just uploaded is removed again — the ordering the sibling
        // registers document at length.
        if (newFile) { uploaded = await uploadFile(newFile); patch.file_url = uploaded; }
        else if (dropFile) patch.file_url = null;

        var res;
        if (r) {
          res = await sb().from(TABLE).update(patch).eq('id', r.id).select().maybeSingle();
        } else {
          patch.created_by = UID;
          res = await sb().from(TABLE).insert(patch).select().maybeSingle();
        }
        if (res.error) throw res.error;
        var saved = (res.data && res.data.id) ? res.data : r;

        // ---- the drawing links ------------------------------------------------
        // ⚠️ DIFFED, NOT DELETE-ALL-THEN-REINSERT. The link row carries the revision
        // that was transmitted; wiping and rebuilding would either lose that or churn
        // the whole set on every save. Only genuine adds, removes and edits are sent.
        // ⚠️ A link failure does NOT fail the save — the RFA is already written, and
        // throwing here would leave the user thinking nothing saved while the row is
        // there. It is reported instead.
        if (saved && saved.id && !drawErr) {
          try {
            var before = linksFor(saved.id);
            var beforeIds = before.map(function (l) { return l.drawing_id; });
            var afterIds = work.map(function (l) { return l.drawing_id; });
            var gone = beforeIds.filter(function (id) { return afterIds.indexOf(id) === -1; });
            if (gone.length) {
              var dr = await sb().from('rfa_drawings').delete()
                .eq('rfa_id', saved.id).in('drawing_id', gone);
              if (dr.error) throw dr.error;
            }
            if (work.length) {
              // upsert on the composite key: an existing link has its revision/pages
              // corrected, a new one is inserted, in one round trip.
              var ur = await sb().from('rfa_drawings').upsert(work.map(function (l, i) {
                return {
                  rfa_id: saved.id, drawing_id: l.drawing_id,
                  revision: l.revision || null,
                  pages: l.pages == null || isNaN(+l.pages) ? null : +l.pages,
                  sort_order: i
                };
              }), { onConflict: 'rfa_id,drawing_id' });
              if (ur.error) throw ur.error;
            }
          } catch (le) {
            UI.toast('The RFA saved, but its drawing links did not: ' + ((le && le.message) || le), 'error');
          }
        }

        // Only now is it safe to drop the superseded object: the row already points
        // away from it.
        var toRemove = [];
        if (uploaded && r && r.file_url) toRemove.push(r.file_url);
        if (dropFile && r && r.file_url && !uploaded) toRemove.push(r.file_url);
        await removeFiles(toRemove);

        UI.toast(r ? 'RFA saved' : 'RFA raised', 'ok');
        m.close();
        await load();
      } catch (err) {
        if (uploaded) await removeFiles([uploaded]);   // roll back this save's upload
        var msg = (err && err.message) || String(err);
        // The 0020 guard speaks in Postgres, not English. Translate the one case a
        // user will actually hit.
        if (/decision|permission|policy/i.test(msg) && /status/i.test(msg)) {
          msg = 'Recording an approval or rejection requires a planner. Ask a planner to set that status.';
        }
        UI.toast('Could not save: ' + msg, 'error');
        saveBtn.disabled = false; saveBtn.textContent = 'Save';
      }
    };
    return m;
  }

  async function delRow(id) {
    var r = rows.find(function (x) { return String(x.id) === String(id); });
    if (!r) return;
    var label = r.rfa_no || r.title || 'this RFA';
    if (!await UI.confirm('Delete ' + label + '? This cannot be undone.')) return;
    try {
      var res = await sb().from(TABLE).delete().eq('id', r.id);
      if (res.error) throw res.error;
      // Capture the path BEFORE the row leaves memory, or the object is orphaned
      // in the bucket with nothing pointing at it.
      await removeFiles([r.file_url]);
      UI.toast('Deleted', 'ok');
      await load();
    } catch (e) {
      UI.toast('Could not delete: ' + ((e && e.message) || e), 'error');
    }
  }

  // ---- export --------------------------------------------------------------
  function exportExcel() {
    var list = filtered();
    var aoa = [['RFA No.', 'Rev', 'Title', 'Description', 'Discipline', 'Category', 'Sub-category',
      'Document types', 'Drawings (linked)', 'Other documents', 'To', 'To company', 'From', 'RFA date', 'Date required',
      'Date submitted', 'Date returned', 'Days late (open)', 'Turnaround (d)', 'Status',
      'Review status', 'Decided by', 'Decision date', "Consultant's comments",
      "Client's comments", 'Prepared by', 'Checked by', 'Approved by', 'Responsible',
      'Attachment', 'Remarks']];
    list.forEach(function (r) {
      var od = overdueDays(r);
      aoa.push([r.rfa_no || '', r.revision || '', r.title || '', r.description || '',
        r.discipline || '', r.category || '', r.sub_category || '',
        docTypes(r).join('; '),
        // The linked drawings, as code + the revision THIS RFA transmitted. Separate
        // from the free-typed documents so a spreadsheet reader can tell a real
        // register link from a hand-typed reference — the same distinction the
        // register itself draws.
        linksFor(r.id).map(function (l) {
          var d = drawById[l.drawing_id];
          return drawLabel(d) + (l.revision ? ' Rev ' + l.revision : '');
        }).join(' | '),
        documents(r).map(function (d) {
          return [d.doc_no, d.rev, d.description, d.pages != null ? d.pages + 'p' : ''].filter(Boolean).join(' ');
        }).join(' | '),
        r.to_name || '', r.to_company || '', r.from_name || '',
        r.rfa_date || '', r.date_required || '', r.date_submitted || '', r.date_returned || '',
        od != null && od > 0 ? od : '', turnaroundDays(r) == null ? '' : turnaroundDays(r),
        statusOf(r) || 'Draft', r.review_status || '', r.decision_by || '', r.decision_date || '',
        r.consultant_comments || '', r.client_comments || '',
        r.prepared_by || '', r.checked_by || '', r.approved_by || '', r.responsible || '',
        // Named, never linked: the bucket is private, so a URL in a spreadsheet
        // would be dead for whoever opens it. Saying a document exists is the
        // useful half.
        r.file_url ? fileLabel(r.file_url) : '', r.remarks || '']);
    });
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'RFA Register');
    XLSX.writeFile(wb, 'RFA Register - ' + (projName() || pid) + '.xlsx');
  }

  // ---- shell ---------------------------------------------------------------
  function projName() {
    var p = projects.find(function (x) { return String(x.id) === String(pid); });
    return (p && (p.name || p.id)) || pid || '';
  }
  function syncTabs() {
    document.querySelectorAll('.rf-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.view === view);
    });
  }
  function switchTab(v) { view = v; syncTabs(); render(); }
  function syncClearFilt() {
    var b = document.getElementById('rf-f-clear');
    if (b) b.hidden = !anyFilter();
  }
  function syncFilterOptions() {
    var d = document.getElementById('rf-f-discipline');
    if (d && d.options.length <= 1) {
      DISCIPLINES.forEach(function (x) {
        var o = document.createElement('option'); o.value = x; o.textContent = x; d.appendChild(o);
      });
    }
    var s = document.getElementById('rf-f-status');
    if (s && s.options.length <= 1) {
      STATUS_ORDER.forEach(function (x) {
        var o = document.createElement('option'); o.value = x; o.textContent = x; s.appendChild(o);
      });
    }
    var t = document.getElementById('rf-f-type');
    if (t && t.options.length <= 1) {
      var RT = (TopSheet._internals && TopSheet._internals.RFA_TYPES) || [];
      var flat = []; RT.forEach(function (row) { flat = flat.concat(row); });
      flat.forEach(function (x) {
        var o = document.createElement('option'); o.value = x; o.textContent = x; t.appendChild(o);
      });
    }
  }

  async function init(user, profile) {
    UID = (user && user.id) || (profile && profile.id) || null;
    PROFILE = profile || null;
    isPlanner = !!(profile && ['super_admin', 'admin', 'planner'].indexOf(profile.role) !== -1);
    canWrite = !!(profile && ['super_admin', 'admin', 'planner', 'user'].indexOf(profile.role) !== -1);
    UI.initShell();

    if (!canWrite) {
      var a = document.getElementById('rf-add');
      if (a) a.style.display = 'none';
    }

    var selEl = document.getElementById('rf-project');
    try { projects = (await PDb.getProjects()) || []; } catch (e) { projects = []; }
    projects = projects.filter(function (p) { return !AppAuth.canAccessProject || AppAuth.canAccessProject(profile, p.id); });
    selEl.innerHTML = projects.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.name || p.id) + '</option>';
    }).join('');
    // ⚠️ NEVER fall back to projects[0] — a <select> with no explicit value reports
    // its FIRST OPTION, so a stale id silently becomes "whichever project sorts
    // first" and someone reads another project's RFAs as their own. Project-first,
    // the same rule as the shell and every sibling module.
    var stored = sessionStorage.getItem('pd_project');
    var ok = stored && projects.some(function (p) { return String(p.id) === String(stored); });
    // ⚠️ location.replace() does NOT halt the running script — return as well, or
    // the rest of init wires handlers against a null pid.
    if (!ok) { location.replace('../../projects.html'); return; }
    selEl.value = stored;
    pid = stored;
    if (UI.enhanceProjectSelect) UI.enhanceProjectSelect(selEl);
    selEl.addEventListener('change', function () {
      pid = selEl.value;
      sessionStorage.setItem('pd_project', pid);
      filters = { q: '', discipline: '', status: '', type: '', overdue: false, openOnly: false };
      document.getElementById('rf-f-search').value = '';
      document.getElementById('rf-f-overdue').checked = false;
      document.getElementById('rf-f-openonly').checked = false;
      // Top-sheet defaults are per project — carrying them across would print the
      // previous project's client on this project's paperwork.
      tsDefaults = null;
      load();
    });

    document.querySelectorAll('.rf-tab').forEach(function (t) {
      t.onclick = function () { switchTab(t.dataset.view); };
    });
    document.getElementById('rf-add').onclick = function () { openForm(null); };
    document.getElementById('rf-export').onclick = exportExcel;
    document.getElementById('rf-print').onclick = function () { setTimeout(function () { window.print(); }, 60); };

    var q = document.getElementById('rf-f-search'), tmr = null;
    // Debounced: every keystroke otherwise re-filters and rebuilds the table, which
    // is the typing lag the drawing register had to fix.
    q.addEventListener('input', function () {
      clearTimeout(tmr);
      tmr = setTimeout(function () { filters.q = q.value; render(); }, 160);
    });
    document.getElementById('rf-f-discipline').addEventListener('change', function (e) { filters.discipline = e.target.value; render(); });
    document.getElementById('rf-f-status').addEventListener('change', function (e) { filters.status = e.target.value; render(); });
    document.getElementById('rf-f-type').addEventListener('change', function (e) { filters.type = e.target.value; render(); });
    document.getElementById('rf-f-overdue').addEventListener('change', function (e) { filters.overdue = e.target.checked; render(); });
    document.getElementById('rf-f-openonly').addEventListener('change', function (e) { filters.openOnly = e.target.checked; render(); });
    document.getElementById('rf-f-clear').onclick = function () {
      filters = { q: '', discipline: '', status: '', type: '', overdue: false, openOnly: false };
      q.value = '';
      ['rf-f-discipline', 'rf-f-status', 'rf-f-type'].forEach(function (id) { document.getElementById(id).value = ''; });
      document.getElementById('rf-f-overdue').checked = false;
      document.getElementById('rf-f-openonly').checked = false;
      render();
    };

    await load();
  }

  return {
    init: init,
    // Exposed so a verification harness runs the SHIPPED functions rather than a
    // reimplementation — the arrangement every sibling register uses.
    _internals: {
      stats: stats, matches: matches, filtered: filtered, isOpen: isOpen,
      isOverdue: isOverdue, overdueDays: overdueDays, turnaroundDays: turnaroundDays,
      daysBetween: daysBetween, validDate: validDate, fmtDate: fmtDate,
      statusOf: statusOf, statusMeta: statusMeta, isApproved: isApproved,
      docTypes: docTypes, documents: documents, fileLabel: fileLabel,
      linksFor: linksFor, drawLabel: drawLabel, isSheetTracked: isSheetTracked,
      drawingFileOf: drawingFileOf, topSheetAttachments: topSheetAttachments,
      drawingsWithoutFile: drawingsWithoutFile,
      rfasForDrawing: rfasForDrawing, approvalTargets: approvalTargets,
      setDrawings: function (list) {
        drawings = []; drawById = {}; hasSheets = {};
        (list || []).forEach(function (d) { drawById[d.id] = d; });
        (list || []).forEach(function (d) { if (d.parent_id && drawById[d.parent_id]) hasSheets[d.parent_id] = true; });
        drawings = (list || []).filter(function (d) { return !(d.parent_id && drawById[d.parent_id]); });
      },
      setLinks: function (links) {
        linksOf = {}; rfasOfDrawing = {};
        (links || []).forEach(function (l) {
          (linksOf[l.rfa_id] = linksOf[l.rfa_id] || []).push(l);
          (rfasOfDrawing[l.drawing_id] = rfasOfDrawing[l.drawing_id] || []).push(l.rfa_id);
        });
      },
      rfaDataOf: rfaDataOf, renderSummary: renderSummary, renderRegistry: renderRegistry,
      render: render, exportExcel: exportExcel,
      setRows: function (x) { rows = x; }, setPid: function (x) { pid = x; },
      setProjects: function (x) { projects = x; },
      setCanWrite: function (x) { canWrite = x; },
      setPlanner: function (x) { isPlanner = x; },
      setFilters: function (x) { filters = x; },
      STATUSES: STATUSES, STATUS_ORDER: STATUS_ORDER, DISCIPLINES: DISCIPLINES,
      AGE_BUCKETS: AGE_BUCKETS
    }
  };
})();
