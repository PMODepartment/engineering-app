/* Material Submittal Log — modules/material-submittal/module.js
   Built against "EPC. PMO. Material Submittal List Dashboard" (2025-01-25).

   DASHBOARD MATHS — read before changing anything in scurve()/statusCounts():
   The workbook's own formulas are the spec. Verified against them exactly:
     status table = COUNTIF over the Status column (blank = not counted)
     PLANNED curve = COUNTIFS(PlannedApproval within month, TradeCategory = <code>)
     ACTUAL  curve = COUNTIFS(ActualApproval  within month, TradeCategory = <code>)
   i.e. the S-curve is driven by the APPROVAL date pair, NOT submission — despite
   the workbook labelling its own summary rows "Planned/Actual Submission".

   TWO DEFECTS in the workbook, both reproduced and proven before being fixed:
     1. `TradeCategory` pointed at the redundant "Trades" column, which is blank on
        39 of 141 real submittals — silently dropping them from the chart (33 of
        them had approval dates and would otherwise have counted).
     2. Its OVERALL row summed EIGHT discipline rows but listed "ST" twice, so
        Structural was double-counted: OVERALL read 97/29 where the seven distinct
        disciplines sum to 91/23.
   This module groups by `discipline` (always populated) and counts each discipline
   once. `legacyScurve()` reproduces the workbook's figure from `trade_code` purely
   so the dashboard can show the reconciliation — nothing else may use it. */
window.MaterialSubmittal = (function () {
  'use strict';

  var TABLE = 'material_submittal';
  // PRIVATE storage bucket (2026-06-18 storage migration): objects are only
  // reachable through a short-lived signed URL, never a public link.
  var BUCKET = 'material-submittal';
  var sb = function () { return window.__sb || (window.__sb = supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY)); };
  var esc = function (s) { return Fmt.esc(s == null ? '' : String(s)); };
  // Inline SVG for dynamically-rendered markup (row actions). Icons.hydrate()
  // only runs on DOMContentLoaded / explicit calls, so embedding the SVG keeps
  // re-rendered rows correct without depending on a later hydrate pass.
  function ico(name, size) {
    return (window.Icons && Icons.svg) ? Icons.svg(name, size || 15) : '';
  }

  // Shown while the log loads — replaces a bare "Loading…" line so the shape of
  // what's coming is visible. Same markup/classes as Drawing Register's.
  var SK_W = ['15%', '38%', '12%', '16%', '10%'];
  function skeletonHTML() {
    var out = '', i, j;
    for (i = 0; i < 9; i++) {
      var cells = '';
      for (j = 0; j < SK_W.length; j++) cells += '<span class="ms-sk" style="width:' + SK_W[j] + '"></span>';
      out += '<div class="ms-sk-row">' + cells + '</div>';
    }
    return '<div class="pd-card ms-skcard" aria-busy="true">' +
      '<div class="ms-sk-head"><span class="ms-spin"></span>Loading log…</div>' + out + '</div>';
  }

  // ---- attachments ---------------------------------------------------------
  // One document per submittal, matching the log's own model: each row carries a
  // single "Type of Presentation" (brochure / test results / sample board …), and
  // a submittal needing two document types is already two rows in the workbook.
  // `file_url` stores the object PATH, not a URL — the URL is signed on demand.
  async function uploadFile(file) {
    var safe = String(file.name).replace(/[^\w.\-]+/g, '_').slice(-120);
    var path = pid + '/' + Date.now() + '_' + safe;
    var res = await sb().storage.from(BUCKET).upload(path, file, { upsert: false });
    if (res.error) throw res.error;
    return path;
  }
  async function viewFile(path) {
    var res = await sb().storage.from(BUCKET).createSignedUrl(path, 60);
    if (res.error) { UI.toast('Could not open the file: ' + res.error.message, 'error'); return; }
    window.open(res.data.signedUrl, '_blank', 'noopener');
  }
  // Best-effort: a failed object delete must never block the row delete, or the
  // user is left unable to remove a record because of a storage hiccup.
  async function removeFiles(paths) {
    var list = (paths || []).filter(Boolean);
    if (!list.length) return;
    try { await sb().storage.from(BUCKET).remove(list); } catch (e) {}
  }
  function fileLabel(path) {
    if (!path) return '';
    var base = String(path).split('/').pop();
    return base.replace(/^\d{10,}_/, '');          // strip the timestamp prefix
  }

  // ---- vocabularies (workbook "Library" sheet — letter codes are its own) ----
  var STATUSES = [
    { name: 'Approved',             code: 'A', cls: 's-approved'  },
    { name: 'Approved w/ Comments', code: 'B', cls: 's-approvedc' },
    { name: 'Resubmit',             code: 'C', cls: 's-resubmit'  },
    { name: 'Rejected',             code: 'D', cls: 's-rejected'  },
    { name: 'For Information',      code: 'F', cls: 's-info'      },
    { name: 'Pending Approval',     code: '',  cls: 's-pending'   },
    { name: 'For Submission',       code: 'P', cls: 's-forsub'    }
  ];
  // Dashboard order matches the workbook's status block exactly.
  var STATUS_ORDER = ['Approved', 'Approved w/ Comments', 'Resubmit', 'Rejected', 'For Information', 'Pending Approval', 'For Submission'];
  var DONE = { 'Approved': 1, 'Approved w/ Comments': 1 };   // counts as approved

  var PRESENTATION = ['Sample Board', 'Mock Up', 'Brochure and Technical Data Sheet', 'Sample', 'Product Certification', 'Test Results'];
  var CONSULTANTS  = ['ECTA', 'RBS', 'INT', 'IES', 'DADEC', 'MCC-ENG'];

  // Discipline codes (workbook "Coding Reference"). The 7 the dashboard charts
  // are the ones its S-curve tracked; any other code still counts in "Other".
  var DISCIPLINES = [
    ['AR','ARCHITECTURAL'],['ST','STRUCTURAL'],['CL','CIVIL'],['ME','MECHANICAL'],['EL','ELECTRICAL'],
    ['PL','WATER SUPPLY/PLUMBING'],['FP','FIRE FIGHTING'],['AC','HVAC/AIR-CONDITIONING'],['AN','ANCILLARY'],
    ['BW','BUILDERS WORK'],['CC','CO-ORDINATED CEILING PLAN'],['CH','CHILLED WATER'],['CS','COORDINATED SERVICES'],
    ['DC','DISTRICT COOLING'],['DR','DRAINAGE'],['EA','LIGHTING/EARTHING'],['FA','FIRE ALARM'],['GE','GENERAL'],
    ['HS','ELECTRICAL LOW CURRENT'],['ID','INTERIOR DESIGN'],['IR','IRRIGATION'],['LF','LIFTS'],
    ['LP','LIQUID PETROLEUM GAS'],['LS','LANDSCAPE'],['LT','ELECTRICAL LIGHTING'],['LV','ELECTRICAL LOW VOLTAGE'],
    ['PW','ELECTRICAL POWER'],['SN','STANDARD'],['SP','CO-ORDINATED SITE PLAN'],['UM','URBAN AND MASTER PLANNING'],
    ['XX','MISCELLANEOUS']
  ];
  var CHART_DISC = ['CL', 'ST', 'AR', 'ME', 'EL', 'PL', 'FP'];
  var DISC_COLOR = { CL:'#EE3124', ST:'#2B2C2B', AR:'#C42127', ME:'#2F6FB0', EL:'#B45309', PL:'#12693A', FP:'#7C3AED', Other:'#8A8F98' };

  var DOCTYPES = [['MT','Material Submission'],['SD','Shop Drawing'],['SP','Specification'],['IT','Inspection & test plan'],
    ['MS','Method statement'],['MA','Manual'],['RP','Report'],['SH','Schedule'],['XX','Other']];
  var BUILDINGS = [['SUB','Substructure'],['SUP','Superstructure'],['POD','Podium'],['TR1','Tower 1'],['PRB','Parking Building'],['GEN','General']];

  // The workbook's 23 section headers, in its own order (drives grouping + the filter).
  var SECTIONS = ['GENERAL REQUIREMENT','SITEWORKS','REBAR','CONCRETE','MASONRY','STONEWORKS','TILING WORKS',
    'DRYWALLS AND CEILING WORKS','THERMAL & MOISTURE PROTECTION','DOOR AND JAMB','DOOR HARDWARES','METAL WORKS',
    'PAINTING WORKS','ALUMINUM GLASS & GLAZING WORKS','CABINETRY','SPECIALTIES','MECHANICAL WORKS','ELECTRICAL WORKS',
    'AUXILIARY WORKS','PLUMBING WORKS','FIRE PROTECTION WORKS','OTHER ALLIED SERVICES','RECTIFICATION WORKS'];

  // ---- state ---------------------------------------------------------------
  var UID = null, PROFILE = null, pid = null, rows = [], view = 'dashboard';
  var canWrite = false, isAdmin = false, loading = false;
  var sel = {}, collapsed = {}, noteDismissed = false;

  // ===== live collaboration (presence + "who's editing this submittal") =====
  // Shared PDCollab layer (Supabase Realtime): topbar avatars, a colored flag on
  // the row a teammate has open in the edit modal, and live row updates on save.
  var _collab = null, _collabPid = null, _remoteSel = {};
  function _selfName() { return (PROFILE && (PROFILE.name || PROFILE.email)) || 'Someone'; }
  function joinCollab() {
    if (!window.PDCollab) return;
    if (_collab) { _collab.leave(); _collab = null; }
    _remoteSel = {};
    if (!pid) { renderPresence([]); return; }
    _collab = PDCollab.join({
      key: 'material_submittal:' + pid, table: TABLE, projectId: pid,
      self: { id: UID, name: _selfName() },
      onPresence: function (members) {
        renderPresence(members);
        _remoteSel = {}; members.forEach(function (m) { if (!m.self && m.sel) _remoteSel[m.id] = { id: m.id, name: m.name, color: m.color, sel: m.sel }; });
        paintRemote();
      },
      onSelection: function (d) { if (d.sel) _remoteSel[d.id] = { id: d.id, name: d.name, color: d.color, sel: d.sel }; else delete _remoteSel[d.id]; paintRemote(); },
      onRemoteChange: applyRemoteChange
    });
  }
  function renderPresence(members) { var el = document.getElementById('ms-presence'); if (el) el.innerHTML = window.PDCollab ? PDCollab.avatarsHTML(members || []) : ''; }
  function broadcastCollabSel(rowId, editing) { if (_collab) _collab.setSelection(rowId ? { rowId: rowId, editing: !!editing } : null); }
  function _msClearEditing() { broadcastCollabSel(null); }
  function paintRemote() {
    if (!window.PDCollab) return;
    var host = document.getElementById('ms-view'); if (!host) return;
    PDCollab.clearCells(host);
    if (view !== 'log') return;
    Object.keys(_remoteSel).forEach(function (k) {
      var m = _remoteSel[k]; if (!m || !m.sel || !m.sel.rowId) return;
      var rid = (window.CSS && CSS.escape) ? CSS.escape(String(m.sel.rowId)) : m.sel.rowId;
      var tr = host.querySelector('tr[data-id="' + rid + '"]'); if (!tr) return;
      var td = tr.querySelector('.ms-fz2') || tr.querySelector('td'); if (td) PDCollab.paintCell(td, m);
    });
  }
  function applyRemoteChange(payload) {
    var evt = payload.eventType || payload.event;
    var rec = payload['new'] || payload.record || null, old = payload['old'] || payload.old_record || null;
    if (evt === 'DELETE') { var did = old && old.id; if (did == null) return; rows = rows.filter(function (x) { return String(x.id) !== String(did); }); }
    else if (rec) { var j = -1; for (var i = 0; i < rows.length; i++) { if (String(rows[i].id) === String(rec.id)) { j = i; break; } } if (j < 0) rows.push(rec); else rows[j] = rec; }
    else return;
    render();
  }
  var filters = { q: '', section: '', disc: '', status: '', pres: '', overdue: false };

  // ---- date helpers --------------------------------------------------------
  var MON = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  var MNAME = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  /* Parses what the workbook actually contains: "18-Mar-24", Excel serials, Date
     objects and ISO. Returns an ISO yyyy-mm-dd string (what Postgres `date` wants).

     ⚠️ TIMEZONE: never read a spreadsheet Date with LOCAL getters. SheetJS returns
     a cell displaying "18-Mar-24" as 2024-03-17T15:59:17Z (serial→ms rounding), so
     local getters yield the 17th in some zones and the 18th in others — the parsed
     date would depend on where the browser is. Everything below is UTC-only, and
     the Date branch rounds to the NEAREST UTC day to absorb that 15:59:17 drift.
     The importer also reads cells as FORMATTED TEXT (raw:false), so the normal path
     is the literal "18-Mar-24" string and never touches a Date at all. */
  function parseDate(v) {
    if (v == null || v === '') return null;
    // Duck-typed, not `instanceof Date`: a Date built in another realm (iframe, or a
    // test harness running the module in a vm context) fails instanceof and would
    // silently fall through to the string branch, shifting the date by a day.
    if (v && typeof v.getTime === 'function' && !isNaN(v.getTime()))
      return isoUTC(new Date(Math.round(v.getTime() / 86400000) * 86400000));
    if (typeof v === 'number' && isFinite(v)) {           // Excel serial (1900 system)
      var d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return isNaN(d) ? null : isoUTC(d);
    }
    var s = String(v).trim();
    if (!s || /^[-–—]+$/.test(s)) return null;
    var m = /^(\d{1,2})[-\/\s]([A-Za-z]{3,})[-\/\s](\d{2,4})$/.exec(s);   // 18-Mar-24
    if (m) {
      var mo = MON[m[2].slice(0, 3).toLowerCase()];
      if (mo == null) return null;
      var y = +m[3]; if (y < 100) y += 2000;
      return pad4(y) + '-' + pad2(mo + 1) + '-' + pad2(+m[1]);            // pure string maths
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    var m2 = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);                 // dd/mm/yyyy
    if (m2) { var y2 = +m2[3]; if (y2 < 100) y2 += 2000; return pad4(y2) + '-' + pad2(+m2[2]) + '-' + pad2(+m2[1]); }
    // Last resort: a locale string like "Mon Mar 18 2024 …" parses to LOCAL time, so
    // read it back with local getters (isoUTC would shift it a day west of UTC).
    var d2 = new Date(s);
    return isNaN(d2.getTime()) ? null : iso(d2);
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function pad4(n) { return String(n).padStart(4, '0'); }
  function isoUTC(d) { return pad4(d.getUTCFullYear()) + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
  function iso(d) { return pad4(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function fmtDate(s) {
    if (!s) return '';
    var p = String(s).slice(0, 10).split('-');
    if (p.length !== 3) return esc(s);
    return String(+p[2]).padStart(2, '0') + '-' + MNAME[+p[1] - 1] + '-' + String(p[0]).slice(2);
  }
  function monthKey(s) { return s ? String(s).slice(0, 7) : null; }          // yyyy-mm
  function todayISO() { return iso(new Date()); }

  // ---- row helpers ---------------------------------------------------------
  function statusOf(r) { return (r.status || '').trim(); }
  function statusMeta(name) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].name === name) return STATUSES[i];
    return null;
  }
  function discOf(r) { return (r.discipline || r.code_discipline || '').trim().toUpperCase(); }
  function sectionOf(r) { return (r.trade_section || '').trim() || 'UNCLASSIFIED'; }
  function isApproved(r) { return !!DONE[statusOf(r)]; }
  // Overdue = planned approval has passed and it still isn't approved. Blank plan
  // date can't be overdue (no commitment to miss).
  function isOverdue(r) {
    if (isApproved(r) || !r.plan_approval_date) return false;
    return String(r.plan_approval_date).slice(0, 10) < todayISO();
  }
  // Composed 7-part number; falls back to whatever was stored/imported.
  function codeOf(r) {
    var p = [r.code_project, r.code_building, r.code_company, r.code_doctype, r.code_discipline, r.code_floor, r.code_number];
    var got = p.filter(function (x) { return x != null && String(x).trim() !== ''; });
    return got.length >= 2 ? p.map(function (x) { return (x == null ? '' : String(x).trim()); }).filter(Boolean).join('-') : (r.submittal_no || '');
  }
  // Days past the PLANNED approval date (+N late, −N still to go). The log tracks
  // planned vs actual approval and nothing else — the per-document schedule link
  // was removed (the Project Schedule already connects to this log through the
  // Design Development POC roll-up).
  function agingDays(r) {
    var ref = r.plan_approval_date;
    if (!ref) return null;
    var refYear = +String(ref).slice(0, 4);
    if (refYear < 2015 || refYear > 2100) return null;   // sentinel/placeholder date, not real
    var today = new Date(); today.setHours(0, 0, 0, 0);
    return Math.round((today - new Date(String(ref).slice(0, 10) + 'T00:00:00')) / 86400000);
  }
  // ---- Schedule-activity picker (searchable) -------------------------------
  // ⚠️ A native <datalist> can NOT do this: browsers filter datalist options by
  // the option's `value`, which has to be the activity_id we store — so typing
  // part of an activity NAME matched nothing. This is a real dropdown that
  // searches both the ID and the name.
  // ==========================================================================
  // DASHBOARD MATHS
  // ==========================================================================

  // Workbook parity: COUNTIF over the status column — rows with a BLANK status are
  // not counted at all (that is why its total read 107 against 146 sheet rows).
  function statusCounts(list) {
    var m = {}, total = 0;
    STATUS_ORDER.forEach(function (s) { m[s] = 0; });
    list.forEach(function (r) {
      var s = statusOf(r); if (!s) return;
      if (!(s in m)) m[s] = 0;
      m[s]++; total++;
    });
    return { map: m, total: total };
  }

  // Monthly + cumulative counts of PLANNED (plan_approval_date) and ACTUAL
  // (date_approved) per discipline. Corrected maths: groups by `discipline`, counts
  // every submittal, each discipline exactly once.
  // `cutoff` (yyyy-mm, optional) stops the cumulative at that month — the workbook
  // did this via IF(month > CurrentMonth, NA(), …). Omitted = the whole timeline.
  function scurve(list, cutoff) {
    var months = {}, per = {};
    function bump(bucket, disc, mk) {
      if (!mk || (cutoff && mk > cutoff)) return;
      months[mk] = true;
      var key = CHART_DISC.indexOf(disc) >= 0 ? disc : 'Other';
      (per[key] = per[key] || { planned: {}, actual: {} });
      per[key][bucket][mk] = (per[key][bucket][mk] || 0) + 1;
    }
    list.forEach(function (r) {
      var d = discOf(r);
      bump('planned', d, monthKey(r.plan_approval_date));
      bump('actual',  d, monthKey(r.date_approved));
    });
    var keys = Object.keys(months).sort();
    if (!keys.length) return { months: [], series: [], totals: { planned: 0, actual: 0 } };
    // Fill the gaps so the curve is continuous across empty months.
    var all = [], cur = keys[0], last = keys[keys.length - 1], guard = 0;
    while (cur <= last && guard++ < 600) {
      all.push(cur);
      var y = +cur.slice(0, 4), mo = +cur.slice(5, 7);
      if (++mo > 12) { mo = 1; y++; }
      cur = y + '-' + String(mo).padStart(2, '0');
    }
    var order = CHART_DISC.filter(function (d) { return per[d]; }).concat(per.Other ? ['Other'] : []);
    var series = order.map(function (d) {
      var cp = 0, ca = 0;
      return {
        disc: d, color: DISC_COLOR[d] || DISC_COLOR.Other,
        planned: all.map(function (mk) { return (cp += (per[d].planned[mk] || 0)); }),
        actual:  all.map(function (mk) { return (ca += (per[d].actual[mk]  || 0)); })
      };
    });
    var tp = all.map(function (_, i) { return series.reduce(function (a, s) { return a + s.planned[i]; }, 0); });
    var ta = all.map(function (_, i) { return series.reduce(function (a, s) { return a + s.actual[i];  }, 0); });
    return {
      months: all, series: series,
      totalPlanned: tp, totalActual: ta,
      totals: { planned: tp[tp.length - 1] || 0, actual: ta[ta.length - 1] || 0 }
    };
  }

  // Reproduces the WORKBOOK's figure (grouped by the sparse `trade_code`, with
  // Structural double-counted) so the dashboard can show the reconciliation.
  // Reconciliation display ONLY — never use this for real reporting.
  function legacyScurve(list, cutoff) {
    var p = 0, a = 0, st = { p: 0, a: 0 }, dropped = 0;
    var within = function (d) { var mk = monthKey(d); return mk && (!cutoff || mk <= cutoff); };
    list.forEach(function (r) {
      var t = (r.trade_code || '').trim().toUpperCase();
      if (CHART_DISC.indexOf(t) < 0) { if (discOf(r)) dropped++; return; }   // blank/other → invisible to the old chart
      var hp = within(r.plan_approval_date), ha = within(r.date_approved);
      if (hp) p++; if (ha) a++;
      if (t === 'ST') { if (hp) st.p++; if (ha) st.a++; }                    // the duplicated row
    });
    return { planned: p + st.p, actual: a + st.a, dropped: dropped };
  }

  function kpis(list) {
    var sc = statusCounts(list);
    var approved = (sc.map['Approved'] || 0) + (sc.map['Approved w/ Comments'] || 0);
    return {
      total: list.length,
      counted: sc.total,
      approved: approved,
      approvedPct: sc.total ? approved / sc.total * 100 : 0,
      pending: sc.map['Pending Approval'] || 0,
      forSub: sc.map['For Submission'] || 0,
      rejected: (sc.map['Rejected'] || 0) + (sc.map['Resubmit'] || 0),
      overdue: list.filter(isOverdue).length
    };
  }

  // ==========================================================================
  // RENDER — DASHBOARD
  // ==========================================================================
  function renderDashboard() {
    var host = document.getElementById('ms-view');
    if (!rows.length) { host.innerHTML = emptyHTML(); wireEmpty(); return; }

    var k = kpis(rows), sc = statusCounts(rows), curve = scurve(rows), legacy = legacyScurve(rows);
    var h = '<div class="ms-dash">';

    // ⚠️ "Approved / Pending approval" are aggregates over SEVERAL statuses
    // (see kpis()), so there is no single status filter that reproduces them —
    // drilling them would land on a list whose count doesn't match the card.
    // Only cards backed by one filter value are clickable.
    h += kpiSection('Log Overview',
      kpi('Total submittals', k.total, k.counted !== k.total ? (k.total - k.counted) + ' with no status yet' : 'all have a status',
        '', { view: 'log', patch: {}, tip: 'Show all submittals in the Registry' }) +
      kpi('Approved', k.approved, k.approvedPct.toFixed(1) + '% of ' + k.counted + ' tracked', 'good') +
      kpi('Pending approval', k.pending, 'submitted, awaiting decision', k.pending ? 'warn' : '') +
      kpi('For submission', k.forSub, 'not yet submitted') +
      kpi('Rejected / resubmit', k.rejected, 'needs rework', k.rejected ? 'bad' : '') +
      kpi('Overdue', k.overdue, 'past planned approval', k.overdue ? 'bad' : '',
        { view: 'backlog', patch: { overdue: true }, tip: 'Show the overdue items in the Backlog' }));

    h += '<div class="ms-grid2">';

    // ---- status block (workbook parity) ----
    h += '<div class="ms-card"><h3>Material submittal log overview</h3>' +
      '<p class="ms-cardsub">Status mix across the ' + sc.total + ' submittal' + (sc.total === 1 ? '' : 's') + ' that carry a status.</p>' +
      '<div class="ms-donutwrap">' + donutSVG(sc) + '<div class="ms-legend">' +
      STATUS_ORDER.map(function (s) {
        var n = sc.map[s] || 0, pct = sc.total ? (n / sc.total * 100) : 0;
        // Legend rows drill into the Registry filtered to that status (#7).
        // Zero-count rows aren't links — there'd be nothing to show.
        return '<div' + (n ? ' class="ms-legendrow"' + drillAttr('log', { status: s }) +
            ' title="Show the ' + n + ' ' + esc(s) + ' submittal' + (n === 1 ? '' : 's') + ' in the Registry"' : '') + '>' +
          '<span class="ms-sw" style="background:' + statusColor(s) + '"></span>' +
          '<span style="flex:1">' + esc(s) + '</span><b>' + n + '</b> <span class="ms-mut">' + pct.toFixed(1) + '%</span></div>';
      }).join('') + '</div></div>';

    h += '<table class="ms-stat" style="margin-top:14px;"><thead><tr><th>Status</th><th>No. of Material Submittal</th><th>Wt %</th></tr></thead><tbody>';
    STATUS_ORDER.forEach(function (s) {
      var n = sc.map[s] || 0, pct = sc.total ? (n / sc.total * 100) : 0;
      h += '<tr' + (n ? ' class="ms-drillrow"' + drillAttr('log', { status: s }) +
            ' title="Show these ' + n + ' in the Registry"' : ' class="ms-zero"') + '><td>' + esc(s) +
        '<div class="ms-bar"><i style="width:' + pct.toFixed(2) + '%;background:' + statusColor(s) + '"></i></div></td>' +
        '<td>' + n + '</td><td>' + pct.toFixed(2) + '%</td></tr>';
    });
    h += '<tr><td>Total</td><td>' + sc.total + '</td><td>100.00%</td></tr></tbody></table></div>';

    // ---- S-curve ----
    h += '<div class="ms-card"><h3>Material submittal S-curve</h3>' +
      '<p class="ms-cardsub">Cumulative <b>planned</b> vs <b>actual approvals</b> by month, from the plan / actual approval dates.</p>' +
      '<div class="ms-chart">' + curveSVG(curve) + '</div>';

    h += '<table class="ms-stat" style="margin-top:14px;"><thead><tr><th>Discipline</th><th>Planned</th><th>Actual</th><th>%</th></tr></thead><tbody>';
    curve.series.forEach(function (s) {
      var p = s.planned[s.planned.length - 1], a = s.actual[s.actual.length - 1];
      // Discipline rows drill into the Registry filtered to that discipline (#7).
      h += '<tr class="ms-drillrow"' + drillAttr('log', { disc: s.disc }) +
        ' title="Show the ' + esc(discName(s.disc)) + ' submittals in the Registry">' +
        '<td><span class="ms-sw" style="display:inline-block;background:' + s.color + ';margin-right:7px;"></span>' +
        esc(discName(s.disc)) + '</td><td>' + p + '</td><td>' + a + '</td><td>' + (p ? (a / p * 100).toFixed(1) : '0.0') + '%</td></tr>';
    });
    h += '<tr><td>Overall</td><td>' + curve.totals.planned + '</td><td>' + curve.totals.actual + '</td><td>' +
      (curve.totals.planned ? (curve.totals.actual / curve.totals.planned * 100).toFixed(1) : '0.0') + '%</td></tr></tbody></table>';
    h += '</div></div>';   // /grid2

    // ---- open items by aging (WPM "Work Package by Aging" pattern) ----
    h += '<div class="ms-card"><h3>Open Items by Aging</h3>' + agingBarSVG(agingBuckets()) + '</div>';

    // ---- by period (WPM "Work Package by Period" pattern) ----
    h += '<div class="ms-card"><h3 style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
      'Submittals by Period — Planned vs Actual Approval' +
      '<span class="ms-seg" id="ms-permode">' +
        '<button class="ms-seg-btn active" data-mode="month">Monthly</button>' +
        '<button class="ms-seg-btn" data-mode="quarter">Quarterly</button>' +
      '</span>' +
      // ONE button that switches, not two mutually-exclusive buttons.
      '<button class="ms-seg ms-segswitch" id="ms-pervalmode" type="button" ' +
        'title="Switch between counts and % of all submittals">#</button>' +
      '</h3><div id="ms-period-chart" class="ms-pc-wrap"></div></div>';

    // ---- reconciliation note ----
    if (!noteDismissed && (legacy.planned !== curve.totals.planned || legacy.actual !== curve.totals.actual || legacy.dropped)) {
      h += '<div class="ms-note" id="ms-note"><span class="ms-note-ico" data-ico="risk" data-ico-size="16"></span><div>' +
        '<b>These totals differ from the source Excel — deliberately.</b><br>' +
        'This dashboard counts <b>' + curve.totals.planned + ' planned / ' + curve.totals.actual + ' actual</b>. ' +
        'The workbook’s chart reported <b>' + legacy.planned + ' / ' + legacy.actual + '</b> because it grouped by its ' +
        '“Trades” column' + (legacy.dropped ? ' — left blank on <b>' + legacy.dropped + '</b> submittal' + (legacy.dropped === 1 ? '' : 's') + ', which its chart silently dropped' : '') +
        ' — and its overall row listed Structural twice, double-counting it. ' +
        'Here every submittal is included and each discipline counts once.' +
        '</div><button class="ms-note-x" id="ms-note-x" title="Dismiss">&times;</button></div>';
    }

    h += '</div>';
    host.innerHTML = h;
    if (window.Icons && Icons.hydrate) Icons.hydrate(host);
    wireDrills(host);   // KPI cards, donut legend, status + discipline tables, aging bar
    var x = document.getElementById('ms-note-x');
    if (x) x.onclick = function () { noteDismissed = true; renderDashboard(); };
    var drawPeriod = function () {
      renderPeriodChart(document.getElementById('ms-period-chart'),
        periodScaled(periodBuckets(periodMode), periodValueMode, rows.length), periodValueMode);
    };
    drawPeriod();
    var pm = document.getElementById('ms-permode');
    if (pm) pm.querySelectorAll('.ms-seg-btn').forEach(function (b) {
      b.onclick = function () {
        periodMode = b.dataset.mode;
        pm.querySelectorAll('.ms-seg-btn').forEach(function (x2) { x2.classList.toggle('active', x2 === b); });
        drawPeriod();
      };
    });
    var pvm = document.getElementById('ms-pervalmode');
    if (pvm) {
      pvm.textContent = periodValueMode === 'pct' ? '%' : '#';
      pvm.onclick = function () {
        periodValueMode = (periodValueMode === 'count') ? 'pct' : 'count';
        pvm.textContent = periodValueMode === 'pct' ? '%' : '#';
        drawPeriod();
      };
    }
  }

  // ---- Open Items by Aging (WPM "Work Package by Aging" pattern) -----------
  // Unfiltered — an aggregate for the whole project, independent of the Registry/
  // Backlog filter bar's current selection.
  var AGING_ORDER = ['>60d overdue', '30-60d overdue', '0-30d (current)', 'Future', 'No due date'];
  var AGING_COLOR = { '>60d overdue':'#EE3124', '30-60d overdue':'#d97706',
    '0-30d (current)':'#8a8f98', 'Future':'#DCDBDB', 'No due date':'#c8c8c8' };
  // Single source of truth for which bucket a row falls in — used to build the
  // chart AND to filter the Backlog when a segment is clicked (#7), so the
  // drill-through can never disagree with the bar it came from.
  function agingBucketOf(r) {
    var a = agingDays(r);
    if (a == null) return 'No due date';
    if (a > 60)    return '>60d overdue';
    if (a > 30)    return '30-60d overdue';
    if (a >= 0)    return '0-30d (current)';
    return 'Future';
  }
  function agingBuckets() {
    var b = {}; AGING_ORDER.forEach(function (k) { b[k] = 0; });
    rows.forEach(function (r) {
      if (isApproved(r)) return;
      b[agingBucketOf(r)]++;
    });
    return b;
  }
  // The bar itself is built only from items that HAVE a due date — letting
  // "No due date" compete for bar space swamps the whole chart into one giant
  // grey blob (most submittals aren't linked to the schedule yet) with the
  // genuinely urgent buckets reduced to a sliver. The undated count is still
  // reported, just as a separate line, not a bar segment.
  var AGING_DATED = ['>60d overdue', '30-60d overdue', '0-30d (current)', 'Future'];
  function agingBarSVG(buckets) {
    var noDate = buckets['No due date'] || 0;
    var datedTotal = AGING_DATED.reduce(function (s, k) { return s + buckets[k]; }, 0);
    if (!datedTotal) {
      return '<p class="ms-mut">' + (noDate
        ? 'None of the ' + noDate + ' open item' + (noDate === 1 ? '' : 's') + ' are linked to a schedule activity yet — link one from its edit form to see aging here.'
        : 'No open items.') + '</p>';
    }
    // Segments + legend drill into the Backlog filtered to that bucket (#7).
    var bars = AGING_DATED.filter(function (k) { return buckets[k] > 0; }).map(function (k) {
      var pct = buckets[k] / datedTotal * 100;
      return '<div class="ms-agseg" style="width:' + pct + '%;background:' + AGING_COLOR[k] + ';"' +
        drillAttr('backlog', { aging: k }) +
        ' title="' + k + ': ' + buckets[k] + ' — click to list them in the Backlog">' +
        (pct > 6 ? buckets[k] : '') + '</div>';
    }).join('');
    var legend = AGING_DATED.filter(function (k) { return buckets[k] > 0; }).map(function (k) {
      return '<span class="ms-aglegend"' + drillAttr('backlog', { aging: k }) +
        ' title="Show these ' + buckets[k] + ' item' + (buckets[k] === 1 ? '' : 's') + ' in the Backlog">' +
        '<span style="width:10px;height:10px;background:' + AGING_COLOR[k] + ';display:inline-block;border-radius:2px;"></span>' +
        k + ' (' + buckets[k] + ')</span>';
    }).join('');
    return '<div style="height:36px;border-radius:6px;overflow:hidden;display:flex;">' + bars + '</div>' +
      '<div style="margin-top:8px;">' + legend + '</div>' +
      (noDate ? '<p class="ms-mut" style="font-size:12px;margin:8px 0 0;">+ ' +
        '<button class="ms-linklike"' + drillAttr('backlog', { aging: 'No due date' }) +
        ' title="List the unlinked open items in the Backlog">' + noDate + ' open item' + (noDate === 1 ? '' : 's') + '</button>' +
        ' not yet linked to a schedule activity (excluded above, no due date to measure against).</p>' : '');
  }

  // ---- Submittals by Period — Planned vs Actual (WPM "Work Package by Period") ---
  var periodMode = 'month';   // 'month' | 'quarter'
  var MNAME3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // Guards against sentinel/placeholder dates (seen live on Drawing Register's
  // legacy imports — a single bogus far-past date can blow the whole chart's
  // x-axis out to a multi-decade range) by treating anything outside a sane
  // project-planning window as "no date" instead of plotting it.
  function periodKeyOf(dateStr, mode) {
    var d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00'); if (isNaN(d)) return null;
    var y = d.getFullYear(), m = d.getMonth();
    if (y < 2015 || y > 2100) return null;
    if (mode === 'quarter') return y + '-Q' + (Math.floor(m / 3) + 1);
    return y + '-' + String(m + 1).padStart(2, '0');
  }
  function periodLabelOf(key, mode) {
    if (mode === 'quarter') { var p = key.split('-Q'); return 'Q' + p[1] + " '" + p[0].slice(2); }
    var p = key.split('-'); return MNAME3[+p[1] - 1] + " '" + p[0].slice(2);
  }
  function periodBuckets(mode) {
    var pMap = {}, aMap = {};
    rows.forEach(function (r) {
      if (r.plan_approval_date) { var k = periodKeyOf(r.plan_approval_date, mode); if (k) pMap[k] = (pMap[k]||0) + 1; }
      if (r.date_approved)      { var k2 = periodKeyOf(r.date_approved, mode); if (k2) aMap[k2] = (aMap[k2]||0) + 1; }
    });
    var keys = Object.keys(pMap).concat(Object.keys(aMap)).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort();
    var cumP = 0, cumA = 0;
    return keys.map(function (k) {
      cumP += pMap[k]||0; cumA += aMap[k]||0;
      return { key:k, label:periodLabelOf(k, mode), planned:pMap[k]||0, actual:aMap[k]||0, cumPlanned:cumP, cumActual:cumA };
    });
  }
  function niceCeil(v) {
    if (v <= 0) return 1;
    var pow = Math.pow(10, Math.floor(Math.log10(v))), f = v / pow;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  }
  // '#' shows raw counts; '%' shows every value as a % of all submittals in the
  // project — the conventional S-curve reading (curves climb toward 100%).
  var periodValueMode = 'count';   // 'count' | 'pct'
  function periodScaled(data, mode, total) {
    if (mode !== 'pct' || !total) return data;
    return data.map(function (d) {
      return { key:d.key, label:d.label, planned:d.planned/total*100, actual:d.actual/total*100,
        cumPlanned:d.cumPlanned/total*100, cumActual:d.cumActual/total*100 };
    });
  }
  function periodFmt(v, mode) { return mode==='pct' ? (Math.round(v*10)/10)+'%' : Math.round(v); }

  // Period chart — Chart.js (same stack as the Procurement dashboard) so sizing,
  // hover tooltips and data labels behave identically there and here. Replaces an
  // earlier hand-rolled SVG whose fixed viewBox had to be stretched to fill the
  // card, which distorted text and point markers.
  var _periodChart = null;
  function renderPeriodChart(container, data, mode) {
    if (_periodChart) { _periodChart.destroy(); _periodChart = null; }
    if (!data.length) { container.innerHTML = '<p class="ms-mut">No planned/actual approval dates recorded yet.</p>'; return; }
    container.innerHTML = '<canvas></canvas>';
    var pct = mode === 'pct';
    var dark = document.documentElement.classList.contains('pd-dark');
    var ink = dark ? '#F0EFEF' : '#231F20';
    var gridC = dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.06)';
    var plannedBar = dark ? '#8A8F98' : '#282C28';
    var fmt = function (v) { return v == null ? '' : (pct ? (Math.round(v*10)/10)+'%' : Math.round(v)); };
    _periodChart = new Chart(container.querySelector('canvas').getContext('2d'), {
      type: 'bar',
      data: {
        labels: data.map(function (d){ return d.label; }),
        datasets: [
          { label:'Planned this period', data:data.map(function(d){return d.planned;}), backgroundColor:plannedBar, borderRadius:3, order:2 },
          { label:'Actual this period',  data:data.map(function(d){return d.actual;}),  backgroundColor:'#EE3124', borderRadius:3, order:2 },
          { label:'Cumulative planned',  data:data.map(function(d){return d.cumPlanned;}), type:'line', borderColor:plannedBar, borderWidth:2, pointRadius:2, fill:false, tension:.15, order:1 },
          { label:'Cumulative approved', data:data.map(function(d){return d.cumActual;}),  type:'line', borderColor:'#EE3124', borderWidth:2, pointRadius:2, fill:false, tension:.15, order:1 }
        ]
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        interaction:{ mode:'index', intersect:false },
        plugins:{
          legend:{ position:'bottom', labels:{ usePointStyle:true, boxWidth:12, padding:10, color:ink, font:{size:11} } },
          tooltip:{ callbacks:{ label:function(c){ return c.dataset.label+': '+fmt(c.parsed.y); } } },
          datalabels:{ display:function(c){ return c.dataset.type!=='line' && data.length<=20 && c.dataset.data[c.dataIndex]>0; },
            anchor:'end', align:'end', offset:2, font:{size:9}, color:ink, formatter:fmt }
        },
        scales:{
          x:{ grid:{display:false}, ticks:{ color:ink, font:{size:9}, maxRotation:45, autoSkip:true, maxTicksLimit:24 } },
          y:{ beginAtZero:true, max: pct ? 100 : undefined, grid:{color:gridC},
              ticks:{ color:ink, font:{size:9}, callback:function(v){ return fmt(v); } },
              title:{ display:true, text: pct ? '% of submittals' : 'No. of submittals', color:ink, font:{size:10} } }
        }
      }
    });
  }

  // ---- Overview drill-through [UI review #7, ported from drawing-register] ---
  // Every aggregate that corresponds to a real ROW SET links into the list that
  // produced it. ⚠️ Aggregates that are NOT row sets stay non-clickable and get
  // no hover, so "looks clickable" always means "is clickable".
  function drillTo(targetView, patch) {
    patch = patch || {};
    filters.q = ''; filters.section = patch.section || ''; filters.disc = patch.disc || '';
    filters.status = patch.status || ''; filters.pres = patch.pres || '';
    filters.overdue = !!patch.overdue;
    bkAging = patch.aging || '';
    var set = function (id, v) {
      var el = document.getElementById(id); if (!el) return;
      v = v || '';
      // ⚠️ A <select> silently ignores a value with no matching <option>; the
      // filter would apply while the control still read "All …". Add it instead.
      if (v && el.tagName === 'SELECT' && !Array.prototype.some.call(el.options, function (o) { return o.value === v || o.text === v; })) {
        el.add(new Option(v, v));
      }
      el.value = v;
    };
    set('ms-f-search', ''); set('ms-f-section', filters.section);
    set('ms-f-discipline', filters.disc); set('ms-f-status', filters.status);
    set('ms-f-pres', filters.pres);
    var ov = document.getElementById('ms-f-overdue'); if (ov) ov.checked = filters.overdue;
    // A filtered log with sections collapsed shows headers and no rows, which
    // reads as "the drill found nothing".
    if (targetView === 'log') collapsed = {};
    view = targetView; switchTab(targetView);
  }
  function drillAttr(targetView, patch) {
    return ' data-drill="' + targetView + '" data-dpatch="' + esc(JSON.stringify(patch || {})) + '"' +
           ' role="button" tabindex="0"';
  }
  function wireDrills(host) {
    host.querySelectorAll('[data-drill]').forEach(function (el) {
      var go = function (e) {
        e.preventDefault(); e.stopPropagation();
        var p = {}; try { p = JSON.parse(el.dataset.dpatch || '{}'); } catch (err) {}
        drillTo(el.dataset.drill, p);
      };
      el.onclick = go;
      el.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') go(e); };
    });
  }

  function kpi(label, value, sub, cls, drill) {
    return '<div class="ms-kpi ' + (cls || '') + (drill ? ' ms-kpi-drill' : '') + '"' +
      (drill ? drillAttr(drill.view, drill.patch) + ' title="' + esc(drill.tip || ('Show these in the ' + drill.view)) + '"' : '') +
      '><div class="ms-kpi-l">' + esc(label) + '</div>' +
      '<div class="ms-kpi-v">' + value + '</div><div class="ms-kpi-s">' + esc(sub || '') + '</div></div>';
  }
  // Groups a KPI row under a small uppercase eyebrow label (WPM "Cost Overview" /
  // "Work Package Status" pattern) so a page with more than one KPI row reads as
  // separate sections instead of one long undifferentiated strip.
  function kpiSection(label, cardsHtml) {
    return '<div class="ms-kpi-section"><div class="ms-kpi-seclabel">' + esc(label) + '</div>' +
           '<div class="ms-kpis">' + cardsHtml + '</div></div>';
  }
  function statusColor(s) {
    return ({ 'Approved':'#12693A', 'Approved w/ Comments':'#3F6B21', 'Resubmit':'#9A4A15', 'Rejected':'#9B1C1C',
      'For Information':'#1E4E8C', 'Pending Approval':'#B45309', 'For Submission':'#8A8F98' })[s] || '#8A8F98';
  }
  function discName(c) {
    for (var i = 0; i < DISCIPLINES.length; i++) if (DISCIPLINES[i][0] === c) return c + ' — ' + title(DISCIPLINES[i][1]);
    return c === 'Other' ? 'Other disciplines' : c;
  }
  function title(s) { return String(s).toLowerCase().replace(/\b[a-z]/g, function (m) { return m.toUpperCase(); }); }

  function donutSVG(sc) {
    var R = 54, C = 2 * Math.PI * R, off = 0, segs = '';
    if (!sc.total) return '';
    STATUS_ORDER.forEach(function (s) {
      var n = sc.map[s] || 0; if (!n) return;
      var frac = n / sc.total, len = frac * C;
      segs += '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + statusColor(s) + '" stroke-width="22" ' +
        'stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" ' +
        'transform="rotate(-90 70 70)"><title>' + esc(s) + ': ' + n + '</title></circle>';
      off += len;
    });
    var approved = (sc.map['Approved'] || 0) + (sc.map['Approved w/ Comments'] || 0);
    return '<svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="Status mix">' + segs +
      '<text x="70" y="66" text-anchor="middle" style="font-size:21px;font-weight:800;fill:var(--pd-ink)">' +
      (sc.total ? Math.round(approved / sc.total * 100) : 0) + '%</text>' +
      '<text x="70" y="82" text-anchor="middle" style="font-size:9.5px">approved</text></svg>';
  }

  function curveSVG(c) {
    if (!c.months.length) return '<p class="ms-mut" style="font-size:12.5px;">No approval dates recorded yet — the curve appears once submittals carry planned or actual approval dates.</p>';
    var n = c.months.length;
    var W = Math.max(560, 46 * n + 90), H = 250, L = 44, R = 14, T = 14, B = 44;
    var cw = W - L - R, ch = H - T - B;
    var max = Math.max(1, c.totalPlanned[n - 1], c.totalActual[n - 1]);
    var step = niceStep(max / 4);
    var top = Math.ceil(max / step) * step;
    var X = function (i) { return L + (n === 1 ? cw / 2 : cw * i / (n - 1)); };
    var Y = function (v) { return T + ch - ch * (v / top); };
    var s = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Cumulative planned vs actual approvals">';
    for (var g = 0; g <= top; g += step) {
      s += '<line class="ms-grid" x1="' + L + '" y1="' + Y(g).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(g).toFixed(1) + '"/>' +
           '<text x="' + (L - 7) + '" y="' + (Y(g) + 3.5).toFixed(1) + '" text-anchor="end">' + g + '</text>';
    }
    s += '<line class="ms-axis" x1="' + L + '" y1="' + (T + ch) + '" x2="' + (W - R) + '" y2="' + (T + ch) + '"/>';
    // x labels — thin out so they never collide
    var every = Math.ceil(n / 14);
    c.months.forEach(function (mk, i) {
      if (i % every) return;
      s += '<text x="' + X(i).toFixed(1) + '" y="' + (T + ch + 15) + '" text-anchor="middle">' + MNAME[+mk.slice(5, 7) - 1] + '</text>' +
           '<text x="' + X(i).toFixed(1) + '" y="' + (T + ch + 26) + '" text-anchor="middle">' + mk.slice(2, 4) + '</text>';
    });
    function path(arr) { return arr.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join(' '); }
    s += '<path d="' + path(c.totalPlanned) + '" fill="none" stroke="#2B2C2B" stroke-width="2.4" stroke-linejoin="round"/>';
    s += '<path d="' + path(c.totalActual)  + '" fill="none" stroke="#EE3124" stroke-width="2.4" stroke-linejoin="round"/>';
    // end labels
    var lp = c.totalPlanned[n - 1], la = c.totalActual[n - 1];
    s += '<circle cx="' + X(n - 1).toFixed(1) + '" cy="' + Y(lp).toFixed(1) + '" r="3.2" fill="#2B2C2B"/>' +
         '<circle cx="' + X(n - 1).toFixed(1) + '" cy="' + Y(la).toFixed(1) + '" r="3.2" fill="#EE3124"/>';
    // legend
    s += '<g transform="translate(' + (L + 4) + ',' + (T + 4) + ')">' +
      '<line x1="0" y1="0" x2="16" y2="0" stroke="#2B2C2B" stroke-width="2.4"/><text x="21" y="3.5">Planned (' + lp + ')</text>' +
      '<line x1="0" y1="14" x2="16" y2="14" stroke="#EE3124" stroke-width="2.4"/><text x="21" y="17.5">Actual (' + la + ')</text></g>';
    return s + '</svg>';
  }
  function niceStep(x) {
    if (!isFinite(x) || x <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log(x) / Math.LN10)), f = x / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  // ==========================================================================
  // RENDER — LOG
  // ==========================================================================
  function visibleRows() {
    var q = filters.q.trim().toLowerCase();
    return rows.filter(function (r) {
      if (filters.section && sectionOf(r) !== filters.section) return false;
      if (filters.disc && discOf(r) !== filters.disc) return false;
      if (filters.status && statusOf(r) !== filters.status) return false;
      if (filters.pres && (r.type_presentation || '') !== filters.pres) return false;
      if (filters.overdue && !isOverdue(r)) return false;
      if (!q) return true;
      // trade_section is searchable on purpose: a planner typing "rebar" means the
      // REBAR section — no item text contains that word, so without it the search
      // returns nothing for the most natural query.
      return [codeOf(r), r.material, r.specification, r.brand, r.supplier, r.location,
              r.mas_id, r.reference_document, r.remarks, r.trade_section, r.discipline]
        .some(function (v) { return v && String(v).toLowerCase().indexOf(q) >= 0; });
    });
  }

  // ---- Registry column sort [UI review #3, ported from drawing-register] ----
  // ⚠️ Sorting is applied INSIDE each trade-section group, never across the whole
  // log — the section grouping is how this register is read (and how the workbook
  // is structured), so a flat sort would destroy it. `col:null` = the natural
  // sort_order/seq_no order from load(). Clicking cycles asc → desc → natural.
  var logSort = { col: null, dir: 1 };
  var LOG_SORTABLE = {
    code: 'Submittal No.', item: 'Item', discipline: 'Disc.', location: 'Location',
    brand: 'Brand', vendor: 'Vendor', presentation: 'Presentation',
    req: 'Req. baseline', psub: 'Plan sub.', asub: 'Actual sub.',
    pappr: 'Plan appr.', aappr: 'Actual appr.',
    approver: 'Approver', rev: 'Rev', status: 'Status', mas: 'MAS ID'
  };
  function logSortVal(r, col) {
    switch (col) {
      case 'code':         return String(codeOf(r) || '').toLowerCase();
      case 'item':         return String(r.material || '').toLowerCase();
      case 'discipline':   return String(discOf(r) || '');
      case 'location':     return String(r.location || '').toLowerCase();
      case 'brand':        return String(r.brand || '').toLowerCase();
      case 'vendor':       return String(r.supplier || '').toLowerCase();
      case 'presentation': return String(r.type_presentation || '');
      case 'req':          return r.date_required || '';
      case 'psub':         return r.plan_submission_date || '';
      case 'asub':         return r.date_submitted || '';
      case 'pappr':        return r.plan_approval_date || '';
      case 'aappr':        return r.date_approved || '';
      case 'approver':     return [r.approver_consultant, r.approver_client].filter(Boolean).join(' / ').toLowerCase();
      case 'rev':          return String(r.revision_no || '');
      case 'status':       return statusOf(r) || '';
      case 'mas':          return String(r.mas_id || '');
      default:             return 0;
    }
  }
  // Blanks last in BOTH directions — an empty date or status is "unknown", not
  // "earliest", and burying them is what you want when hunting the populated ends.
  function logSortList(list) {
    if (!logSort.col) return list;
    var col = logSort.col, dir = logSort.dir;
    return list.slice().sort(function (a, b) {
      var va = logSortVal(a, col), vb = logSortVal(b, col);
      var ea = (va === '' || va == null), eb = (vb === '' || vb == null);
      if (ea && eb) return 0;
      if (ea) return 1;
      if (eb) return -1;
      var cmp = va < vb ? -1 : (va > vb ? 1 : 0);
      return cmp * dir;
    });
  }
  function logSetSort(col) {
    if (!LOG_SORTABLE[col]) return;
    if (logSort.col !== col) { logSort.col = col; logSort.dir = 1; }
    else if (logSort.dir === 1) { logSort.dir = -1; }
    else { logSort.col = null; logSort.dir = 1; }   // third click → natural order
    renderLog();
  }
  function logTh(col, cls) {
    var active = logSort.col === col;
    var tip = active
      ? (logSort.dir === 1 ? 'Sorted ascending — click for descending' : 'Sorted descending — click to restore natural order')
      : 'Click to sort by this column';
    return '<th class="' + (cls || '') + ' ms-sortable' + (active ? ' ms-sorted' : '') +
      '" data-lcol="' + col + '" title="' + esc(tip) + '">' + esc(LOG_SORTABLE[col]) +
      (active ? ' <span class="ms-sortind">' + (logSort.dir === 1 ? '▲' : '▼') + '</span>' : '') + '</th>';
  }

  function renderLog() {
    var host = document.getElementById('ms-view');
    if (!rows.length) { host.innerHTML = emptyHTML(); wireEmpty(); return; }
    var list = visibleRows();
    document.getElementById('ms-count').textContent = 'Showing ' + list.length + ' of ' + rows.length;

    // group by trade section, in the workbook's order (unknown sections after)
    var groups = {}, order = [];
    list.forEach(function (r) {
      var s = sectionOf(r);
      if (!groups[s]) { groups[s] = []; order.push(s); }
      groups[s].push(r);
    });
    order.sort(function (a, b) {
      var ia = SECTIONS.indexOf(a), ib = SECTIONS.indexOf(b);
      if (ia < 0 && ib < 0) return a.localeCompare(b);
      if (ia < 0) return 1; if (ib < 0) return -1;
      return ia - ib;
    });

    // Header is the single source of truth for the column count — the group rows and
    // the empty state both span it, and a hardcoded number silently breaks the
    // moment a column is added.
    var HEAD = ['<th class="ms-cb"><input type="checkbox" id="ms-xall" title="Select all shown" /></th>',
      logTh('code', 'ms-fz1'), logTh('item', 'ms-fz2'),
      logTh('discipline'), logTh('location'), logTh('brand'), logTh('vendor'), logTh('presentation'),
      '<th class="ms-doccol">Doc</th>',
      logTh('req'), logTh('psub'), logTh('asub'), logTh('pappr'), logTh('aappr'),
      logTh('approver'), logTh('rev'), logTh('status'), logTh('mas'),
      // Top sheet is a READ action (it only prints what the row already holds),
      // so unlike the edit/delete column it is not gated on canWrite.
      '<th class="ms-tscol" title="MAS top sheet">Form</th>'];
    if (canWrite) HEAD.push('<th class="ms-actcol"></th>');
    var SPAN = HEAD.length;

    // Says a sort is active and restores the natural (workbook/import) order in
    // one click — the log has no drag-reorder, so this is purely an "undo".
    var sortChip = logSort.col ?
      '<div class="ms-listbar" style="margin-bottom:10px;">' +
        '<button class="ms-sortchip" id="ms-sortclear" title="Back to the natural order">' +
        'Sorted by ' + esc(LOG_SORTABLE[logSort.col]) + ' ' + (logSort.dir === 1 ? '▲' : '▼') +
        ' ' + ico('x', 12) + '</button></div>' : '';

    var h = sortChip + '<div class="pd-card ms-tablecard"><table class="ms-table"><thead><tr>' +
      HEAD.join('') + '</tr></thead><tbody>';

    if (!list.length) {
      h += '<tr><td colspan="' + SPAN + '" style="text-align:center;padding:34px;" class="ms-mut">No submittals match these filters.</td></tr>';
    }
    order.forEach(function (secName) {
      var g = groups[secName], isColl = !!collapsed[secName];
      var appr = g.filter(isApproved).length;
      h += '<tr class="ms-grp" data-sec="' + esc(secName) + '"><td colspan="' + SPAN + '">' +
        '<span class="ms-grp-caret' + (isColl ? ' ms-caret-col' : '') + '">' + ico('chevronDown', 12) + '</span>' + esc(secName) +
        '<span class="ms-grp-count">' + g.length + ' item' + (g.length === 1 ? '' : 's') + ' · ' + appr + ' approved</span></td></tr>';
      if (isColl) return;
      logSortList(g).forEach(function (r) {
        var st = statusOf(r), meta = statusMeta(st), od = isOverdue(r);
        h += '<tr' + (sel[r.id] ? ' class="ms-selrow"' : '') + ' data-id="' + esc(r.id) + '">' +
          '<td class="ms-cb"><input type="checkbox" data-cb="' + esc(r.id) + '"' + (sel[r.id] ? ' checked' : '') + ' /></td>' +
          '<td class="ms-fz1"><span class="ms-code">' + esc(codeOf(r) || '—') + '</span></td>' +
          '<td class="ms-fz2"><div class="ms-item">' + esc(r.material || '(untitled)') + '</div>' +
            (r.specification ? '<div class="ms-sub" title="' + esc(r.specification) + '">' + esc(r.specification) + '</div>' : '') + '</td>' +
          '<td class="ms-nowrap">' + esc(discOf(r) || '—') + '</td>' +
          '<td>' + esc(r.location || '') + '</td>' +
          '<td>' + esc(r.brand || '') + '</td>' +
          '<td>' + esc(r.supplier || '') + '</td>' +
          '<td>' + esc(r.type_presentation || '') + '</td>' +
          '<td class="ms-doccol">' + (r.file_url
            ? '<button class="ms-filebtn" data-file="' + esc(r.file_url) + '" title="Open ' + esc(fileLabel(r.file_url)) + '"><span data-ico="eye" data-ico-size="14"></span></button>'
            : '<span class="ms-mut ms-mini">—</span>') + '</td>' +
          '<td class="ms-nowrap ms-mut">' + fmtDate(r.date_required) + '</td>' +
          '<td class="ms-nowrap ms-mut">' + fmtDate(r.plan_submission_date) + '</td>' +
          '<td class="ms-nowrap">' + fmtDate(r.date_submitted) + '</td>' +
          '<td class="ms-nowrap ' + (od ? 'ms-od' : 'ms-mut') + '"' + (od ? ' title="Overdue — planned approval has passed"' : '') + '>' + fmtDate(r.plan_approval_date) + (od ? ' !' : '') + '</td>' +
          '<td class="ms-nowrap">' + fmtDate(r.date_approved) + '</td>' +
          '<td class="ms-nowrap ms-mini">' + esc([r.approver_consultant, r.approver_client].filter(Boolean).join(' / ')) + '</td>' +
          '<td class="ms-r">' + esc(r.revision_no || '') + '</td>' +
          '<td>' + (st ? '<span class="ms-pill ' + (meta ? meta.cls : 's-forsub') + '">' + esc(st) + '</span>' : '<span class="ms-mut ms-mini">—</span>') + '</td>' +
          '<td class="ms-nowrap ms-mini">' + esc(r.mas_id || '') + '</td>' +
          '<td class="ms-tscol"><button class="pd-btn ms-iconbtn" data-mas="' + esc(r.id) + '" title="Generate the MAS top sheet (F-GEN013)">' + ico('fileText', 15) + '</button></td>' +
          (canWrite ? '<td class="ms-actcol"><button class="pd-btn ms-iconbtn" data-edit="' + esc(r.id) + '" title="Edit">' + ico('pencil', 15) + '</button> ' +
            '<button class="pd-btn ms-iconbtn ms-iconbtn-del" data-del="' + esc(r.id) + '" title="Delete">' + ico('trash', 15) + '</button></td>' : '') +
          '</tr>';
      });
    });
    h += '</tbody></table></div>';

    var selN = Object.keys(sel).filter(function (k) { return sel[k]; }).length;
    if (selN && canWrite) {
      h = '<div class="ms-listbar" style="display:flex;gap:10px;align-items:center;margin-bottom:10px;">' +
        '<span style="font-weight:700;color:var(--pd-red);">' + selN + ' selected</span>' +
        '<select class="pd-select" id="ms-bulkstatus" style="max-width:210px;"><option value="">Set status…</option>' +
        STATUS_ORDER.map(function (s) { return '<option>' + esc(s) + '</option>'; }).join('') + '</select>' +
        '<button class="pd-btn" id="ms-bulkdel">Delete selected</button>' +
        '<button class="pd-btn" id="ms-selnone">Clear selection</button></div>' + h;
    }
    host.innerHTML = h;
    wireLog();
  }

  function wireLog() {
    var host = document.getElementById('ms-view');
    if (window.Icons && Icons.hydrate) Icons.hydrate(host);   // the Doc column uses data-ico
    host.querySelectorAll('[data-file]').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); viewFile(b.dataset.file); };
    });
    host.querySelectorAll('.ms-grp').forEach(function (tr) {
      tr.onclick = function () { var s = tr.dataset.sec; collapsed[s] = !collapsed[s]; renderLog(); };
    });
    // Column sort [#3] — click a header to cycle asc → desc → natural.
    host.querySelectorAll('th.ms-sortable[data-lcol]').forEach(function (th) {
      th.onclick = function () { logSetSort(th.dataset.lcol); };
    });
    var lsc = document.getElementById('ms-sortclear');
    if (lsc) lsc.onclick = function () { logSort.col = null; logSort.dir = 1; renderLog(); };
    host.querySelectorAll('[data-cb]').forEach(function (cb) {
      cb.onclick = function (e) { e.stopPropagation(); sel[cb.dataset.cb] = cb.checked; renderLog(); };
    });
    var xall = document.getElementById('ms-xall');
    if (xall) xall.onclick = function () {
      visibleRows().forEach(function (r) { sel[r.id] = xall.checked; });
      renderLog();
    };
    host.querySelectorAll('[data-mas]').forEach(function (b) {
      // stopPropagation: the row click opens the editor.
      b.onclick = function (e) {
        e.stopPropagation();
        openTopSheet('MAS', rows.find(function (r) { return String(r.id) === b.dataset.mas; }));
      };
    });
    host.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); openForm(rows.find(function (r) { return String(r.id) === b.dataset.edit; })); };
    });
    host.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); delRow(b.dataset.del); };
    });
    var bs = document.getElementById('ms-bulkstatus');
    if (bs) bs.onchange = function () { if (bs.value) bulkStatus(bs.value); };
    var bd = document.getElementById('ms-bulkdel'); if (bd) bd.onclick = bulkDelete;
    var sn = document.getElementById('ms-selnone'); if (sn) sn.onclick = function () { sel = {}; renderLog(); };
  }

  // ==========================================================================
  // Top sheets (F-GEN013 MAS / F-GEN011 RFA / F-GEN010 RFI)
  // --------------------------------------------------------------------------
  // Only MAS is generated FROM a record — it is the material submittal's own
  // cover sheet, so every field maps onto a column of this table. RFA and RFI
  // are separate PMO documents with no register here yet (the RFA template even
  // says in its own body that it must not be used for a material submittal), so
  // they open blank with just the project context filled in.
  // ==========================================================================
  var tsDefaults = null;                       // per-project, loaded lazily
  async function ensureTsDefaults() {
    if (tsDefaults && tsDefaults.__pid === pid) return tsDefaults;
    var d = await TopSheet.loadDefaults(pid);
    d.__pid = pid;
    tsDefaults = d;
    return d;
  }

  // MAS field mapping. The template's four description columns are Product Name
  // / Manufacturer / Specification-BOQ Ref / Location-Use, which correspond to
  // the log's material, brand+supplier, specification and location.
  function masDataOf(r) {
    var maker = [r.brand, r.supplier].filter(Boolean).join(' / ');
    return {
      projectCode: pid || '',
      masId:       r.mas_id || codeOf(r) || '',
      revision:    r.revision_no || '',
      date:        todayISO(),
      category:    sectionOf(r) === 'UNCLASSIFIED' ? '' : sectionOf(r),
      subCategory: discOf(r) || '',
      attachments: r.file_url ? 'Yes' : 'No',
      productName: r.material || '',
      manufacturer: maker,
      specRef:     r.specification || '',
      location:    [r.location, r.floor_levels].filter(Boolean).join(' — '),
      submittedBy: (PROFILE && PROFILE.name) || ''
    };
  }

  async function openTopSheet(kind, r) {
    if (!pid) { UI.toast('Select a project first.', 'error'); return; }
    var defaults = await ensureTsDefaults();
    TopSheet.open({
      kind: kind,
      project: { id: pid, name: projName() },
      defaults: defaults,
      data: kind === 'MAS' && r ? masDataOf(r) : {
        date: todayISO(),
        from: (PROFILE && PROFILE.name) || '',
        to: defaults.default_to || '',
        consultant: defaults.consultant_name || ''
      }
    });
  }

  function emptyHTML() {
    return '<div class="pd-card ms-empty"><h3>No material submittals yet</h3>' +
      '<p>Import the PMO workbook to load your existing log, or add submittals one at a time.</p>' +
      (canWrite ? '<p style="margin-top:14px;"><button class="pd-btn pd-btn-primary" id="ms-e-imp">Import from Excel</button> ' +
        '<button class="pd-btn" id="ms-e-add">Add a submittal</button></p>' : '') + '</div>';
  }
  function wireEmpty() {
    var a = document.getElementById('ms-e-imp'); if (a) a.onclick = function () { document.getElementById('ms-file').click(); };
    var b = document.getElementById('ms-e-add'); if (b) b.onclick = function () { openForm(null); };
  }

  // ==========================================================================
  // CRUD
  // ==========================================================================
  function openForm(r) {
    if (!canWrite) { UI.toast('You do not have permission to edit submittals.', 'error'); return; }
    var e = r || {};
    if (r) broadcastCollabSel(r.id, true);   // tell other viewers I'm editing this submittal
    function opts(list, cur, blank) {
      return (blank ? '<option value="">' + blank + '</option>' : '') + list.map(function (o) {
        var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? (o[0] + ' — ' + title(o[1])) : o;
        return '<option value="' + esc(v) + '"' + (String(cur || '') === String(v) ? ' selected' : '') + '>' + esc(l) + '</option>';
      }).join('');
    }
    function f(label, id, val, type) {
      return '<label>' + esc(label) + '<input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val == null ? '' : (type === 'date' ? String(val).slice(0, 10) : val)) + '" /></label>';
    }
    var body =
      '<div class="ms-sec">Material submittal number</div>' +
      '<div class="ms-codeparts">' +
        '<label>Project<input id="ms-c-proj" value="' + esc(e.code_project || '') + '" placeholder="TMS" /></label>' +
        '<label>Building<select id="ms-c-bldg">' + opts(BUILDINGS, e.code_building, '—') + '</select></label>' +
        '<label>Company<input id="ms-c-comp" value="' + esc(e.code_company || 'MCC') + '" placeholder="MCC" /></label>' +
        '<label>Doc type<select id="ms-c-doc">' + opts(DOCTYPES, e.code_doctype || 'MT', '—') + '</select></label>' +
        '<label>Discipline<select id="ms-c-disc">' + opts(DISCIPLINES, e.code_discipline || e.discipline, '—') + '</select></label>' +
        '<label>Floor level<input id="ms-c-floor" value="' + esc(e.code_floor || '') + '" placeholder="GEN" /></label>' +
        '<label>Number<input id="ms-c-num" value="' + esc(e.code_number || '') + '" placeholder="1000" /></label>' +
      '</div>' +
      '<div class="ms-codeprev" id="ms-codeprev"><span>Preview</span><br>—</div>' +

      '<div class="ms-sec">Classification</div>' +
      '<label>Trade section<select id="ms-f-sec2"><option value="">—</option>' +
        SECTIONS.map(function (s) { return '<option' + (e.trade_section === s ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') +
      '</select></label>' +
      '<label>Discipline (drives the dashboard)<select id="ms-f-disc2">' + opts(DISCIPLINES, e.discipline || e.code_discipline, '—') + '</select></label>' +
      f('Floor levels', 'ms-f-floors', e.floor_levels) +
      f('Location', 'ms-f-loc', e.location) +

      '<div class="ms-sec">Item</div>' +
      '<label class="ms-wide">Item<input id="ms-f-item" value="' + esc(e.material || '') + '" placeholder="e.g. Reinforcement Bar" /></label>' +
      '<label class="ms-wide">Specification<textarea id="ms-f-spec">' + esc(e.specification || '') + '</textarea></label>' +
      f('Reference document', 'ms-f-ref', e.reference_document) +
      f('Brand', 'ms-f-brand', e.brand) +
      f('Vendor / supplier', 'ms-f-vendor', e.supplier) +
      '<label>Type of presentation<select id="ms-f-pres2"><option value="">—</option>' +
        PRESENTATION.map(function (p) { return '<option' + (e.type_presentation === p ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') +
      '</select></label>' +

      '<div class="ms-sec">Dates</div>' +
      f('Required date baseline', 'ms-f-req', e.date_required, 'date') +
      f('Plan submission', 'ms-f-psub', e.plan_submission_date, 'date') +
      f('Actual submission', 'ms-f-asub', e.date_submitted, 'date') +
      f('Plan approval', 'ms-f-pappr', e.plan_approval_date, 'date') +
      f('Actual approval', 'ms-f-aappr', e.date_approved, 'date') +


      '<div class="ms-sec">Approval</div>' +
      '<label>Approver — consultant<input id="ms-f-cons" list="ms-dl-cons" value="' + esc(e.approver_consultant || '') + '" />' +
        '<datalist id="ms-dl-cons">' + CONSULTANTS.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist></label>' +
      f('Approver — client', 'ms-f-client', e.approver_client) +
      f('Revision no.', 'ms-f-rev', e.revision_no) +
      '<label>Status<select id="ms-f-stat2"><option value="">—</option>' +
        STATUS_ORDER.map(function (s) { return '<option' + (statusOf(e) === s ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') +
      '</select></label>' +
      f('MAS ID', 'ms-f-mas', e.mas_id) +
      '<label class="ms-wide">Remarks<textarea id="ms-f-rem">' + esc(e.remarks || '') + '</textarea></label>' +

      '<div class="ms-sec">Document</div>' +
      '<div class="ms-filefield">' +
        (e.file_url
          ? '<div class="ms-filenow" id="ms-file-now"><span data-ico="eye" data-ico-size="14"></span>' +
            '<button type="button" class="ms-filelink" id="ms-file-open">' + esc(fileLabel(e.file_url)) + '</button>' +
            '<button type="button" class="ms-filerm" id="ms-file-rm" title="Remove this attachment">&times;</button></div>'
          : '') +
        '<label class="ms-wide" style="margin:0;">' + (e.file_url ? 'Replace document' : 'Attach document') +
          ' <span class="ms-mut" style="font-weight:400;">(PDF, image, or any submittal document)</span>' +
          '<input id="ms-f-file" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.dwg,.zip" /></label>' +
      '</div>';

    var m = UI.modal('<div class="pd-modal-header"><h2 style="margin:0;">' + (r ? 'Edit' : 'Add') + ' material submittal</h2>' +
      '<button class="pd-modal-close" id="ms-m-x">&times;</button></div>' +
      '<div class="ms-form">' + body + '</div>' +
      '<div class="pd-modal-footer"><button class="pd-btn" id="ms-m-cancel">Cancel</button> ' +
      '<button class="pd-btn pd-btn-primary" id="ms-m-save">Save</button></div>');

    var el = function (id) { return m.el.querySelector('#' + id); };
    function syncPrev() {
      var parts = ['ms-c-proj','ms-c-bldg','ms-c-comp','ms-c-doc','ms-c-disc','ms-c-floor','ms-c-num']
        .map(function (i) { return (el(i).value || '').trim(); }).filter(Boolean);
      el('ms-codeprev').innerHTML = '<span>Preview</span><br>' + (parts.length ? esc(parts.join('-')) : '—');
    }
    ['ms-c-proj','ms-c-bldg','ms-c-comp','ms-c-doc','ms-c-disc','ms-c-floor','ms-c-num'].forEach(function (i) {
      el(i).addEventListener('input', syncPrev); el(i).addEventListener('change', syncPrev);
    });
    // Keep the dashboard discipline in step with the code's discipline part unless
    // the user has deliberately set it to something else.
    el('ms-c-disc').addEventListener('change', function () {
      if (!el('ms-f-disc2').value) el('ms-f-disc2').value = el('ms-c-disc').value;
    });
    syncPrev();

    if (window.Icons && Icons.hydrate) Icons.hydrate(m.el);

    // Attachment controls. `fileCleared` is only committed on Save, so cancelling
    // the dialog can never orphan or delete a document.
    var fileCleared = false;
    var openBtn = el('ms-file-open'), rmBtn = el('ms-file-rm');
    if (openBtn) openBtn.onclick = function () { viewFile(e.file_url); };
    if (rmBtn) rmBtn.onclick = function () {
      fileCleared = true;
      var now = el('ms-file-now'); if (now) now.remove();
      UI.toast('Attachment will be removed when you save.', 'info');
    };

    el('ms-m-x').onclick = function () { _msClearEditing(); m.close(); };
    el('ms-m-cancel').onclick = function () { _msClearEditing(); m.close(); };
    el('ms-m-save').onclick = async function () {
      var v = function (id) { var x = (el(id).value || '').trim(); return x === '' ? null : x; };
      var payload = {
        project_id: pid,
        code_project: v('ms-c-proj'), code_building: v('ms-c-bldg'), code_company: v('ms-c-comp'),
        code_doctype: v('ms-c-doc'), code_discipline: v('ms-c-disc'), code_floor: v('ms-c-floor'), code_number: v('ms-c-num'),
        trade_section: v('ms-f-sec2'), discipline: v('ms-f-disc2') || v('ms-c-disc'),
        floor_levels: v('ms-f-floors'), location: v('ms-f-loc'),
        material: v('ms-f-item'), specification: v('ms-f-spec'), reference_document: v('ms-f-ref'),
        brand: v('ms-f-brand'), supplier: v('ms-f-vendor'), type_presentation: v('ms-f-pres2'),
        date_required: v('ms-f-req'), plan_submission_date: v('ms-f-psub'), date_submitted: v('ms-f-asub'),
        plan_approval_date: v('ms-f-pappr'), date_approved: v('ms-f-aappr'),
        approver_consultant: v('ms-f-cons'), approver_client: v('ms-f-client'),
        revision_no: v('ms-f-rev'), status: v('ms-f-stat2'), mas_id: v('ms-f-mas'), remarks: v('ms-f-rem'),
        updated_at: new Date().toISOString()
      };
      payload.submittal_no = [payload.code_project, payload.code_building, payload.code_company, payload.code_doctype,
        payload.code_discipline, payload.code_floor, payload.code_number].filter(Boolean).join('-') || null;
      if (!payload.material) { UI.toast('Item is required.', 'error'); return; }
      // auto-fill Plan approval from the derived required-approval deadline when opted in
      var useReq = el('ms-f-usereq');
      if (useReq && useReq.checked && computedReq) payload.plan_approval_date = computedReq;

      // ---- attachment: upload BEFORE the row write, so a failed upload can't
      // leave the row pointing at an object that doesn't exist. -----------------
      var saveBtn = el('ms-m-save'), fileEl = el('ms-f-file');
      var picked = fileEl && fileEl.files && fileEl.files[0];
      var oldPath = r ? r.file_url : null, uploaded = null;
      if (picked) {
        saveBtn.disabled = true; saveBtn.textContent = 'Uploading…';
        try { uploaded = await uploadFile(picked); }
        catch (err) {
          saveBtn.disabled = false; saveBtn.textContent = 'Save';
          UI.toast('Upload failed: ' + (err.message || err), 'error');
          return;                                    // nothing written — safe to retry
        }
        payload.file_url = uploaded;
      } else if (fileCleared) {
        payload.file_url = null;
      }
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

      if (!r) payload.created_by = UID;
      var res = r ? await sb().from(TABLE).update(payload).eq('id', r.id).select().single()
                  : await sb().from(TABLE).insert(payload).select().single();
      if (res.error) {
        // Roll the orphan back rather than leaving it in the bucket forever.
        if (uploaded) await removeFiles([uploaded]);
        saveBtn.disabled = false; saveBtn.textContent = 'Save';
        UI.toast(res.error.message, 'error'); return;
      }
      // Row now points at the new object (or none) — drop the superseded one.
      if (oldPath && (uploaded || fileCleared) && oldPath !== payload.file_url) await removeFiles([oldPath]);

      if (r) Object.assign(r, res.data); else rows.push(res.data);
      if (window.PDSync) PDSync.cachePut('ms:' + pid, rows);   // keep the offline cache current
      _msClearEditing(); m.close(); UI.toast(r ? 'Submittal updated.' : 'Submittal added.', 'success');
      render();
    };
  }

  async function delRow(id) {
    var r = rows.find(function (x) { return String(x.id) === String(id); });
    if (!r || !confirm('Delete "' + (r.material || 'this submittal') + '"? This cannot be undone.')) return;
    var res = await sb().from(TABLE).delete().eq('id', id);
    if (res.error) { UI.toast(res.error.message, 'error'); return; }
    await removeFiles([r.file_url]);            // row is gone; drop its document too
    rows = rows.filter(function (x) { return String(x.id) !== String(id); });
    delete sel[id];
    UI.toast('Submittal deleted.', 'success'); render();
  }

  async function bulkStatus(status) {
    var ids = Object.keys(sel).filter(function (k) { return sel[k]; });
    if (!ids.length) return;
    rows.forEach(function (r) { if (sel[r.id]) r.status = status; });   // optimistic
    var patch = { status: status, updated_at: new Date().toISOString() };
    if (window.PDSync) {
      // Offline-capable: queue one update per id (each syncs on reconnect, field-level LWW).
      var failed = 0;
      for (var i = 0; i < ids.length; i++) { var w = await PDSync.write({ table: TABLE, op: 'update', id: ids[i], patch: patch }); if (!w.ok) failed++; }
      PDSync.cachePut('ms:' + pid, rows);
      if (failed) { UI.toast(failed + ' change(s) could not be saved.', 'error'); }
    } else {
      var res = await sb().from(TABLE).update(patch).in('id', ids);
      if (res.error) { UI.toast(res.error.message, 'error'); return; }
    }
    UI.toast('Updated ' + ids.length + ' submittal' + (ids.length === 1 ? '' : 's') + '.', 'success');
    sel = {}; render();
  }

  async function bulkDelete() {
    var ids = Object.keys(sel).filter(function (k) { return sel[k]; });
    if (!ids.length || !confirm('Delete ' + ids.length + ' submittal' + (ids.length === 1 ? '' : 's') + '? This cannot be undone.')) return;
    // Capture the paths BEFORE the rows leave `rows`, or they're unrecoverable.
    var paths = rows.filter(function (r) { return sel[r.id] && r.file_url; }).map(function (r) { return r.file_url; });
    for (var i = 0; i < ids.length; i += 100) {
      var res = await sb().from(TABLE).delete().in('id', ids.slice(i, i + 100));
      if (res.error) { UI.toast(res.error.message, 'error'); return; }
    }
    await removeFiles(paths);
    rows = rows.filter(function (r) { return !sel[r.id]; });
    sel = {}; UI.toast('Deleted ' + ids.length + ' submittal' + (ids.length === 1 ? '' : 's') + '.', 'success'); render();
  }

  async function clearAll() {
    if (!isAdmin) { UI.toast('Clearing the log is restricted to admins.', 'error'); return; }
    var m = UI.modal('<h2 style="margin-top:0;">Clear material submittal log</h2>' +
      '<p style="color:var(--pd-muted);font-size:13px;">This permanently deletes <strong>all ' + rows.length + ' submittals</strong> for project <strong>' + esc(pid) + '</strong> and cannot be undone. To confirm, type the project code below.</p>' +
      '<input class="pd-input" id="ms-clr-in" placeholder="Type ' + esc(pid) + ' to confirm" autocomplete="off" />' +
      '<div style="text-align:right;margin-top:12px;"><button class="pd-btn" id="ms-clr-x">Cancel</button> ' +
      '<button class="pd-btn pd-btn-danger" id="ms-clr-go" disabled>Delete all submittals</button></div>');
    var inp = m.el.querySelector('#ms-clr-in'), go = m.el.querySelector('#ms-clr-go');
    inp.oninput = function () { go.disabled = inp.value.trim() !== String(pid); };
    inp.focus();
    m.el.querySelector('#ms-clr-x').onclick = m.close;
    go.onclick = async function () {
      if (inp.value.trim() !== String(pid)) return;
      m.close();
      var paths = rows.filter(function (r) { return r.file_url; }).map(function (r) { return r.file_url; });
      var res = await sb().from(TABLE).delete().eq('project_id', pid);
      if (res.error) { UI.toast(res.error.message, 'error'); return; }
      await removeFiles(paths);
      rows = []; sel = {}; UI.toast('Log cleared.', 'success'); render();
    };
  }

  // ==========================================================================
  // IMPORT — the PMO workbook layout
  // ==========================================================================
  /* The sheet is NOT a flat table: rows 10/11/12 are a 3-tier merged header, and
     the body is broken up by single-cell TRADE SECTION rows (GENERAL REQUIREMENT,
     SITEWORKS, …) that own the rows beneath them. Column positions are fixed by
     that header, so we locate the header row and read by index rather than by
     fuzzy header matching (several headers repeat — "Floor Levels" appears twice). */
  var C = { NO:0, PROJ:1, BLDG:2, COMP:3, DOC:4, DISC:5, FLOOR:6, NUM:7, TRADE:8, FLOORS:9, LOC:10,
            ITEM:11, SPEC:12, REF:13, BRAND:14, VENDOR:15, PRES:16, REQ:17, PSUB:18, ASUB:19,
            PAPPR:20, AAPPR:21, CONS:22, CLIENT:23, REV:24, STATUS:25, REM:26, MAS:27 };

  function pickSheet(wb) {
    var want = wb.SheetNames.filter(function (n) { return /material\s*submittal\s*log/i.test(n); });
    return want[0] || wb.SheetNames.filter(function (n) { return /submittal/i.test(n) && !/dashboard/i.test(n); })[0] || wb.SheetNames[0];
  }

  // Matches the sign-off block that trails the data ("PREPARED AND CHECKED BY:",
  // "REVIEWED BY:", then names and job titles). Everything from there down is not data.
  var SIGNOFF_RE = /^\s*(prepared|reviewed|checked|noted|recommended|endorsed|verified|approved)\b.*\bby\b\s*:?\s*$/i;

  function parseWorkbook(wb) {
    var name = pickSheet(wb);
    // raw:false → cells arrive as their DISPLAYED text ("18-Mar-24"), which keeps
    // date parsing timezone-independent. See the note above parseDate.
    var aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
    var S = function (row, i) { var v = row[i]; return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); };

    // Find the header row ("NO." + "MATERIAL SUBMITTAL NUMBER"), then start after
    // its two sub-header rows. Falls back to the workbook's known position.
    var hdr = -1;
    for (var i = 0; i < Math.min(aoa.length, 40); i++) {
      var r = aoa[i] || [];
      if (/^no\.?$/i.test(S(r, 0)) && /material\s*submittal\s*number/i.test(S(r, 1))) { hdr = i; break; }
    }
    var start = hdr >= 0 ? hdr + 3 : 12;

    var out = [], sections = {}, section = '', skipped = 0, order = 0;
    for (var j = start; j < aoa.length; j++) {
      var row = aoa[j] || [];
      var filled = row.filter(function (x) { return String(x == null ? '' : x).trim() !== ''; }).length;
      if (!filled) continue;

      // Stop completely at the sign-off block — the rows below it are names and job
      // titles, which otherwise import as submittals ("REVIEWED BY:", "Project Manager").
      var isSignoff = false;
      for (var k = 0; k <= C.ITEM; k++) if (SIGNOFF_RE.test(S(row, k))) { isSignoff = true; break; }
      if (isSignoff) break;

      // A section header is a lone label in the first columns with no item.
      if (filled <= 2 && !S(row, C.ITEM)) {
        var lbl = (S(row, 0) || S(row, 1)).toUpperCase();
        if (lbl) { section = lbl; sections[lbl] = true; }
        continue;
      }
      /* A row is a real submittal when it carries substance — NOT merely when it has
         an Item. One row in the reference workbook (sheet row 33) has a full code,
         dates and a status but a blank Item; requiring an Item silently dropped it and
         put the status total one under the workbook's own COUNTIF. Its Item stays null
         and renders as "(untitled)" rather than being invented. */
      var item = S(row, C.ITEM);
      var substantive = item || S(row, C.NUM) || S(row, C.STATUS) || S(row, C.MAS);
      if (!substantive || filled < 3) { skipped++; continue; }

      var disc = S(row, C.DISC).toUpperCase();
      var code = [S(row, C.PROJ), S(row, C.BLDG), S(row, C.COMP), S(row, C.DOC), disc, S(row, C.FLOOR), S(row, C.NUM)].filter(Boolean);
      out.push({
        project_id: pid,
        code_project: S(row, C.PROJ) || null, code_building: S(row, C.BLDG) || null, code_company: S(row, C.COMP) || null,
        code_doctype: S(row, C.DOC) || null, code_discipline: disc || null, code_floor: S(row, C.FLOOR) || null,
        code_number: S(row, C.NUM) || null,
        submittal_no: code.length ? code.join('-') : null,
        trade_section: section || null,
        // Dashboard groups by `discipline`; fall back to the sparse Trades column
        // only when the code has no discipline part.
        discipline: disc || S(row, C.TRADE).toUpperCase() || null,
        trade_code: S(row, C.TRADE).toUpperCase() || null,   // reconciliation only
        floor_levels: S(row, C.FLOORS) || null, location: S(row, C.LOC) || null,
        material: item || null, specification: S(row, C.SPEC) || null, reference_document: S(row, C.REF) || null,
        brand: S(row, C.BRAND) || null, supplier: S(row, C.VENDOR) || null,
        type_presentation: normPres(S(row, C.PRES)),
        date_required: parseDate(row[C.REQ]), plan_submission_date: parseDate(row[C.PSUB]),
        date_submitted: parseDate(row[C.ASUB]), plan_approval_date: parseDate(row[C.PAPPR]),
        date_approved: parseDate(row[C.AAPPR]),
        approver_consultant: S(row, C.CONS) || null, approver_client: S(row, C.CLIENT) || null,
        revision_no: S(row, C.REV) || null, status: normStatus(S(row, C.STATUS)),
        remarks: S(row, C.REM) || null, mas_id: S(row, C.MAS) || null,
        seq_no: parseInt(S(row, C.NO), 10) || null, sort_order: order++
      });
    }
    return { sheet: name, records: out, sections: Object.keys(sections), skipped: skipped };
  }

  // Map loose spellings onto the Library sheet's vocabularies.
  function normStatus(s) {
    if (!s) return null;
    var t = s.toLowerCase().replace(/[.\s]+/g, ' ').trim();
    if (/^a$/.test(t)) return 'Approved';
    if (/^b$/.test(t)) return 'Approved w/ Comments';
    if (/^c$/.test(t)) return 'Resubmit';
    if (/^d$/.test(t)) return 'Rejected';
    if (/^f$/.test(t)) return 'For Information';
    if (/^p$/.test(t)) return 'For Submission';
    if (/approved\s*w|comment/.test(t)) return 'Approved w/ Comments';
    if (/approved/.test(t)) return 'Approved';
    if (/resubmit/.test(t)) return 'Resubmit';
    if (/reject/.test(t)) return 'Rejected';
    if (/information/.test(t)) return 'For Information';
    if (/pending/.test(t)) return 'Pending Approval';
    if (/submission|submit/.test(t)) return 'For Submission';
    return s;
  }
  function normPres(s) {
    if (!s) return null;
    var t = s.toLowerCase();
    for (var i = 0; i < PRESENTATION.length; i++) if (PRESENTATION[i].toLowerCase() === t) return PRESENTATION[i];
    if (/brochure|data\s*sheet/.test(t)) return 'Brochure and Technical Data Sheet';
    if (/board/.test(t)) return 'Sample Board';
    if (/mock/.test(t)) return 'Mock Up';
    if (/certif/.test(t)) return 'Product Certification';
    if (/test/.test(t)) return 'Test Results';
    if (/sample/.test(t)) return 'Sample';
    return s;
  }

  function onFile(ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    if (!canWrite) { UI.toast('You do not have permission to import.', 'error'); return; }
    var fr = new FileReader();
    fr.onload = function (e) {
      var parsed;
      try {
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
        parsed = parseWorkbook(wb);
      } catch (err) { UI.toast('Could not read that workbook: ' + (err.message || err), 'error'); return; }
      if (!parsed.records.length) {
        UI.toast('No submittals found on sheet "' + parsed.sheet + '" — is this the Material Submittal workbook?', 'error');
        return;
      }
      previewImport(parsed, file.name);
    };
    fr.readAsArrayBuffer(file);
  }

  function previewImport(parsed, fname) {
    var recs = parsed.records;
    var withStatus = recs.filter(function (r) { return r.status; }).length;
    var withAppr = recs.filter(function (r) { return r.plan_approval_date || r.date_approved; }).length;
    var noDisc = recs.filter(function (r) { return !r.discipline; }).length;

    var m = UI.modal('<div class="pd-modal-header"><h2 style="margin:0;">Import material submittals</h2>' +
      '<button class="pd-modal-close" id="ms-i-x">&times;</button></div>' +
      '<p style="color:var(--pd-muted);font-size:13px;margin:10px 0 0;">From <b>' + esc(fname) + '</b> · sheet <b>' + esc(parsed.sheet) + '</b></p>' +
      '<div class="ms-imp">' +
        '<div><b>' + recs.length + '</b><span>Submittals</span></div>' +
        '<div><b>' + parsed.sections.length + '</b><span>Trade sections</span></div>' +
        '<div><b>' + withStatus + '</b><span>With a status</span></div>' +
        '<div><b>' + withAppr + '</b><span>With approval dates</span></div>' +
      '</div>' +
      (noDisc ? '<p class="ms-mut" style="font-size:12.5px;">' + noDisc + ' submittal' + (noDisc === 1 ? '' : 's') + ' have no discipline code — they will be grouped under “Other” on the dashboard.</p>' : '') +
      (parsed.skipped ? '<p class="ms-mut" style="font-size:12.5px;">' + parsed.skipped + ' non-item row' + (parsed.skipped === 1 ? '' : 's') + ' skipped (blank or sign-off rows).</p>' : '') +
      '<label class="ms-chk" style="margin-top:6px;"><input type="checkbox" id="ms-i-repl" ' + (rows.length ? 'checked' : '') + ' /> Replace the ' + rows.length + ' submittal' + (rows.length === 1 ? '' : 's') + ' already in this project</label>' +
      '<div class="pd-modal-footer"><button class="pd-btn" id="ms-i-cancel">Cancel</button> ' +
      '<button class="pd-btn pd-btn-primary" id="ms-i-go">Import ' + recs.length + '</button></div>');

    m.el.querySelector('#ms-i-x').onclick = m.close;
    m.el.querySelector('#ms-i-cancel').onclick = m.close;
    m.el.querySelector('#ms-i-go').onclick = async function () {
      var replace = m.el.querySelector('#ms-i-repl').checked;
      m.close();
      await doImport(recs, replace);
    };
  }

  async function doImport(recs, replace) {
    var host = document.getElementById('ms-view');
    host.innerHTML = '<div class="pd-card ms-empty"><h3><span class="ms-spin"></span>Importing…</h3><p id="ms-imp-p">Preparing…</p></div>';
    var p = document.getElementById('ms-imp-p');
    if (replace) {
      p.textContent = 'Clearing existing submittals…';
      // Their documents go too — otherwise every re-import leaves the previous
      // set orphaned in the bucket with no row referencing them.
      var paths = rows.filter(function (x) { return x.file_url; }).map(function (x) { return x.file_url; });
      var del = await sb().from(TABLE).delete().eq('project_id', pid);
      if (del.error) { UI.toast('Could not clear existing: ' + del.error.message, 'error'); load(); return; }
      await removeFiles(paths);
    }
    recs.forEach(function (r) { r.created_by = UID; });
    var ok = 0, CH = 200;
    for (var i = 0; i < recs.length; i += CH) {
      p.textContent = 'Importing ' + Math.min(i + CH, recs.length) + ' of ' + recs.length + '…';
      var res = await sb().from(TABLE).insert(recs.slice(i, i + CH));
      if (res.error) {
        // A missing column means the migration hasn't been run — say so plainly
        // rather than failing with Postgres' wording.
        var msg = /column|schema cache|PGRST204/i.test(res.error.message || '')
          ? 'Import failed — run migrations/2026-07-20-material-submittal-full.sql first. (' + res.error.message + ')'
          : res.error.message;
        UI.toast(msg, 'error'); break;
      }
      ok += recs.slice(i, i + CH).length;
    }
    UI.toast('Imported ' + ok + ' submittal' + (ok === 1 ? '' : 's') + '.', ok ? 'success' : 'error');
    sel = {}; collapsed = {};
    await load();
  }

  // ==========================================================================
  // EXPORT / PRINT
  // ==========================================================================
  function exportExcel() {
    var list = visibleRows();
    if (!list.length) { UI.toast('Nothing to export.', 'error'); return; }
    var aoa = list.map(function (r) {
      return {
        'NO.': r.seq_no || '',
        'Material Submittal Number': codeOf(r),
        'Trade Section': r.trade_section || '',
        'Discipline': discOf(r),
        'Floor Levels': r.floor_levels || '',
        'Location': r.location || '',
        'Item': r.material || '',
        'Specification': r.specification || '',
        'Reference Document': r.reference_document || '',
        'Brand': r.brand || '',
        'Vendor': r.supplier || '',
        'Type of Presentation': r.type_presentation || '',
        'Required Date Baseline': fmtDate(r.date_required),
        'Plan Submission Date': fmtDate(r.plan_submission_date),
        'Actual Submission Date': fmtDate(r.date_submitted),
        'Plan Approval Date': fmtDate(r.plan_approval_date),
        'Actual Approval Date': fmtDate(r.date_approved),
        'Approver - Consultant': r.approver_consultant || '',
        'Approver - Client': r.approver_client || '',
        'Revision No.': r.revision_no || '',
        'Status': statusOf(r),
        'Remarks': r.remarks || '',
        'MAS ID': r.mas_id || '',
        // Filename only — the object is private, so a link would be useless once
        // its signed URL expires (60s).
        'Document': fileLabel(r.file_url)
      };
    });
    var ws = XLSX.utils.json_to_sheet(aoa);
    ws['!cols'] = Object.keys(aoa[0]).map(function (k) { return { wch: k === 'Item' || k === 'Specification' ? 34 : Math.max(12, k.length + 2) }; });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Material Submittal Log');
    XLSX.writeFile(wb, 'Material Submittal Log - ' + (projName() || pid) + '.xlsx');
  }
  function projName() {
    var s = document.getElementById('ms-project');
    return s && s.selectedIndex >= 0 ? s.options[s.selectedIndex].textContent : '';
  }

  // ==========================================================================
  // SHELL
  // ==========================================================================
  function render() {
    // Overview is an aggregate dashboard (no filters); Registry + Backlog are both
    // submittal-level lists, so they share the filter bar.
    document.getElementById('ms-filters').style.display = view === 'dashboard' ? 'none' : '';
    // Registry only: viewport-height flex shell so the log card fills the space
    // left over, instead of trusting a hardcoded chrome height (see
    // `body.ms-fit` in module.css). Overview/Backlog keep page scrolling.
    document.body.classList.toggle('ms-fit', view === 'log');
    if (view === 'dashboard') renderDashboard();
    else if (view === 'backlog') renderBacklog();
    else renderLog();
    syncClearFilt();
    paintRemote();
  }

  // ---- Backlog: submittals needing action, most urgent first ---------------
  // "Needing action" = not yet approved (Approved / Approved w/ Comments are the
  // only DONE statuses), sorted so overdue / late-vs-need-by rows lead.
  // `bkAging` is a Backlog-ONLY filter set by clicking a segment of the Overview's
  // aging bar (#7). Deliberately not in the shared filter bar: aging is derived
  // from the planned approval date, is meaningful only for open items, and the Registry
  // has no aging column to filter on.
  var bkAging = '';
  function backlogRows() {
    return visibleRows().filter(function (r) {
      if (isApproved(r)) return false;
      if (bkAging && agingBucketOf(r) !== bkAging) return false;
      return true;
    });
  }
  // Ranked on the submittal's own planned approval date. Smaller = more urgent.
  function backlogUrgency(r) {
    var d = agingDays(r);
    if (d != null) return -d;                       // most overdue first
    if (isOverdue(r)) return -1000;
    return statusOf(r) === 'Rejected' ? 500 : 1000;
  }
  // Sortable columns (WPM Backlog pattern: click a header to sort by it, click
  // again to flip direction). Defaults to "most overdue first".
  var bkSort = { col: 'urgency', dir: 1 };
  var BK_COLS = [
    { col:'code', label:'Code' }, { col:'item', label:'Item' },
    { col:'section', label:'Section' }, { col:'discipline', label:'Discipline' },
    { col:'status', label:'Status' },
    { col:'aging', label:'Aging (d)' }
  ];
  function bkSortVal(r, col) {
    switch (col) {
      case 'code':       return (codeOf(r) || '').toLowerCase();
      case 'item':       return (r.material || '').toLowerCase();
      case 'section':    return sectionOf(r);
      case 'discipline': return discOf(r);
      case 'status':     return statusOf(r);
      case 'aging':      { var a = agingDays(r); return a == null ? -1e9 : a; }
      default:           return backlogUrgency(r);
    }
  }
  function bkSetSort(col) {
    if (bkSort.col === col) bkSort.dir = -bkSort.dir;
    else { bkSort.col = col; bkSort.dir = (col === 'aging') ? -1 : 1; }
    renderBacklog();
  }

  // A backlog can run into the thousands — the table scrolls inside its own
  // capped-height card (KPIs/header stay put) and only the first BK_PAGE rows
  // paint until "Show all" is clicked, same fix as Drawing Register's Backlog.
  var BK_PAGE = 200;
  var bkShowAll = false;

  function renderBacklog() {
    var host = document.getElementById('ms-view');
    var list = backlogRows();
    var anyFilt = !!(filters.q || filters.section || filters.disc || filters.status || filters.pres || filters.overdue || bkAging);
    if (!list.length) {
      // ⚠️ Must still offer a way out of a drill-through that matched nothing,
      // or the aging filter is a dead end with no visible cause.
      host.innerHTML = '<p class="ms-mut" style="padding:24px;">' +
        (anyFilt ? 'No open items match these filters.' : 'No open items — every submittal is approved.') +
        (bkAging ? ' <button class="ms-linklike" id="ms-agclear">Clear the “' + esc(bkAging) + '” filter</button>' : '') + '</p>';
      var ac0 = document.getElementById('ms-agclear');
      if (ac0) ac0.onclick = function () { bkAging = ''; renderBacklog(); };
      return;
    }
    list = list.slice().sort(function (a, b) {
      var va = bkSortVal(a, bkSort.col), vb = bkSortVal(b, bkSort.col);
      var cmp = va < vb ? -1 : (va > vb ? 1 : 0);
      return cmp * bkSort.dir;
    });

    var overdue = list.filter(isOverdue).length;
    // Overdue against the submittal's OWN planned approval date.
    var late = list.filter(function (r) { var d = agingDays(r); return d != null && d > 0; }).length;
    var rejected = list.filter(function (r) { return statusOf(r) === 'Rejected'; }).length;

    // "Rejected" is a status → a real filter. Overdue is the existing overdue-only
    // checkbox. Open items / late are already what this view shows, so they only
    // clear back rather than pretending to be their own filters.
    var kpis = kpiSection('Backlog Overview',
      kpi('Open items', list.length, 'not yet approved', '',
        (bkAging || filters.status || filters.overdue) ? { view: 'backlog', patch: {}, tip: 'Clear the filters and show every open item' } : null) +
      kpi('Overdue', overdue, 'past planned approval', overdue ? 'bad' : '',
        overdue ? { view: 'backlog', patch: { overdue: true }, tip: 'Filter the Backlog to overdue items' } : null) +
      kpi('Late vs need-by', late, 'past the schedule deadline', late ? 'bad' : '') +
      kpi('Rejected', rejected, 'needs resubmission', '',
        rejected ? { view: 'backlog', patch: { status: 'Rejected' }, tip: 'Filter the Backlog to Rejected' } : null));

    var shown = (bkShowAll || list.length<=BK_PAGE) ? list : list.slice(0, BK_PAGE);

    var CB = canWrite;
    var body = shown.map(function (r) {
      var meta = statusMeta(statusOf(r)), st = statusOf(r), a = agingDays(r);
      return '<tr class="ms-bk-row' + (sel[r.id] ? ' ms-selrow' : '') + '" data-id="' + r.id + '">' +
        (CB ? '<td class="ms-cb"><input type="checkbox" data-cb="' + esc(r.id) + '"' + (sel[r.id] ? ' checked' : '') + ' /></td>' : '') +
        '<td><span class="ms-code">' + esc(codeOf(r) || '—') + '</span></td>' +
        '<td>' + esc(r.material || '(untitled)') + '</td>' +
        '<td>' + esc(sectionOf(r)) + '</td>' +
        '<td>' + esc(discOf(r) || '—') + '</td>' +
        '<td>' + (st ? '<span class="ms-pill ' + (meta ? meta.cls : 's-forsub') + '">' + esc(st) + '</span>' : '<span class="ms-mut ms-mini">—</span>') + '</td>' +
        '<td class="ms-r ms-nowrap' + (a != null && a > 0 ? ' ms-aging-late' : '') + '">' + (a == null ? '<span class="ms-mut ms-mini">—</span>' : (a > 0 ? '+' : '') + a + 'd') + '</td>' +
        // Doc column — the Backlog is where an open submittal gets chased, so its
        // document must be reachable without opening the full editor.
        '<td class="ms-bk-doc">' + (r.file_url
          ? '<button class="ms-filebtn" data-file="' + esc(r.file_url) + '" title="Open ' + esc(fileLabel(r.file_url)) + '">' + ico('eye', 14) + '</button>'
          : '<span class="ms-mut ms-mini">—</span>') + '</td>' +
      '</tr>';
    }).join('');

    var head = (CB ? '<th class="ms-cb"><input type="checkbox" id="ms-bk-xall" title="Select all shown" /></th>' : '') +
      BK_COLS.map(function (c) {
        var active = bkSort.col === c.col;
        return '<th class="ms-sortable" data-col="' + c.col + '">' + c.label +
          (active ? ' <span class="ms-sortind">' + (bkSort.dir === 1 ? '▲' : '▼') + '</span>' : '') + '</th>';
      }).join('') +
      '<th class="ms-bk-doc">Doc</th>';

    // Same bulk bar as the log (same ids → the same bulkStatus/bulkDelete, both
    // of which end in the view-aware render(), so they work from here unchanged).
    var selN = Object.keys(sel).filter(function (k) { return sel[k]; }).length;
    var selbar = (CB && selN) ?
      '<div class="ms-listbar ms-bk-selbar" style="display:flex;gap:10px;align-items:center;margin-bottom:10px;">' +
        '<span style="font-weight:700;color:var(--pd-red);">' + selN + ' selected</span>' +
        '<select class="pd-select" id="ms-bulkstatus" style="max-width:210px;"><option value="">Set status…</option>' +
        STATUS_ORDER.map(function (s) { return '<option>' + esc(s) + '</option>'; }).join('') + '</select>' +
        '<button class="pd-btn" id="ms-bulkdel">Delete selected</button>' +
        '<button class="pd-btn" id="ms-selnone">Clear selection</button></div>' : '';

    var moreBar = (list.length > BK_PAGE) ?
      '<div class="ms-bk-more">' +
        (bkShowAll
          ? 'Showing all ' + list.length + ' — <button class="ms-linklike" id="ms-bk-collapse">collapse to first ' + BK_PAGE + '</button>'
          : 'Showing ' + BK_PAGE + ' of ' + list.length + ' — <button class="ms-linklike" id="ms-bk-showall">show all</button>') +
      '</div>' : '';

    host.innerHTML = kpis +
      '<div class="pd-card ms-tablecard"><h3>Open items' +
      '<span class="ms-mut" style="font-weight:400;font-size:12.5px;margin-left:8px;">' +
      (anyFilt ? 'Showing ' + list.length + ' filtered' : list.length + ' total') + '</span>' +
      // The aging filter arrives by drill-through and isn't in the filter bar, so
      // it must be visible and removable here.
      (bkAging ? '<button class="ms-sortchip ms-agchip" id="ms-agclear" title="Clear the aging filter">' +
        esc(bkAging) + ' ' + ico('x', 12) + '</button>' : '') + '</h3>' + selbar +
      '<div class="ms-bk-scroll"><table class="ms-table ms-bk-table"><thead><tr>' + head + '</tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>' + moreBar + '</div>';

    var showAllBtn = document.getElementById('ms-bk-showall');
    if (showAllBtn) showAllBtn.onclick = function () { bkShowAll = true; renderBacklog(); };
    var collapseBtn = document.getElementById('ms-bk-collapse');
    if (collapseBtn) collapseBtn.onclick = function () { bkShowAll = false; renderBacklog(); };

    host.querySelectorAll('.ms-bk-table th.ms-sortable').forEach(function (th) {
      th.onclick = function () { bkSetSort(th.dataset.col); };
    });
    host.querySelectorAll('.ms-bk-row').forEach(function (tr) {
      tr.onclick = function () {
        var r = rows.find(function (x) { return String(x.id) === tr.dataset.id; });
        if (r) openForm(r);
      };
    });
    // ⚠️ Both the Doc button and the checkbox sit inside a row whose click opens
    // the editor, so both MUST stopPropagation or they also pop the modal.
    host.querySelectorAll('[data-file]').forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); viewFile(b.dataset.file); };
    });
    host.querySelectorAll('[data-cb]').forEach(function (cb) {
      cb.onclick = function (e) { e.stopPropagation(); sel[cb.dataset.cb] = cb.checked; renderBacklog(); };
    });
    var xall = document.getElementById('ms-bk-xall');
    if (xall) xall.onclick = function (e) {
      e.stopPropagation();
      // ⚠️ Only the PAINTED slice — "select all shown" must never silently act on
      // rows hidden behind the 200-row page cap.
      shown.forEach(function (r) { sel[r.id] = xall.checked; });
      renderBacklog();
    };
    if (xall) xall.checked = shown.length > 0 && shown.every(function (r) { return sel[r.id]; });
    var bs = document.getElementById('ms-bulkstatus');
    if (bs) bs.onchange = function () { if (bs.value) bulkStatus(bs.value); };
    var bd = document.getElementById('ms-bulkdel'); if (bd) bd.onclick = bulkDelete;
    var sn = document.getElementById('ms-selnone'); if (sn) sn.onclick = function () { sel = {}; renderBacklog(); };
    var ac = document.getElementById('ms-agclear');
    if (ac) ac.onclick = function () { bkAging = ''; renderBacklog(); };
    wireDrills(host);   // the Backlog KPI cards
    if (window.Icons && Icons.hydrate) Icons.hydrate(host);
  }

  function syncClearFilt() {
    var on = !!(filters.q || filters.section || filters.disc || filters.status || filters.pres || filters.overdue);
    var b = document.getElementById('ms-f-clear');
    if (b) b.hidden = !on;
  }

  function fillFilters() {
    function fill(id, values, cur) {
      var s = document.getElementById(id);
      var first = s.options[0].outerHTML;
      s.innerHTML = first + values.map(function (v) {
        return '<option' + (cur === v ? ' selected' : '') + '>' + esc(v) + '</option>';
      }).join('');
    }
    var secs = SECTIONS.filter(function (s) { return rows.some(function (r) { return sectionOf(r) === s; }); });
    rows.forEach(function (r) { var s = sectionOf(r); if (secs.indexOf(s) < 0) secs.push(s); });
    fill('ms-f-section', secs, filters.section);
    var discs = []; rows.forEach(function (r) { var d = discOf(r); if (d && discs.indexOf(d) < 0) discs.push(d); });
    fill('ms-f-discipline', discs.sort(), filters.disc);
    fill('ms-f-status', STATUS_ORDER, filters.status);
    fill('ms-f-pres', PRESENTATION, filters.pres);
  }

  async function load() {
    if (!pid) { rows = []; render(); return; }
    loading = true;
    document.getElementById('ms-view').innerHTML = skeletonHTML();
    // ⚠️ KEYSET-PAGINATED, and it must stay that way. A single select caps at
    // 1000 rows in Supabase, so the previous one-shot `.order('sort_order')`
    // fetch silently TRUNCATED any project with >1000 submittals — every KPI,
    // donut, S-curve and total would under-report with no error. Same bug the
    // 2026-07-21 audit fixed in project_schedule / drawing_register /
    // progress_photos; this table was missed. Paginate by `id` (a stable,
    // indexed, non-null key — `sort_order` is neither unique nor non-null, so
    // it cannot drive a keyset cursor), then restore the display order in
    // memory below exactly as before.
    var all = [], last = null, res = null;
    while (true) {
      var q = sb().from(TABLE).select('*').eq('project_id', pid)
        .order('id', { ascending: true }).limit(1000);
      if (last) q = q.gt('id', last);
      res = await q;
      if (res.error) break;
      var batch = res.data || []; all = all.concat(batch);
      if (batch.length < 1000) break;
      last = batch[batch.length - 1].id;
    }
    loading = false;
    if (res && res.error) {
      // Offline / network failure → open from the last cached copy so the log still works
      // (bulk status changes made now queue via PDSync and sync on reconnect).
      if (window.PDSync) { var c = await PDSync.cacheGet('ms:' + pid); if (c && c.rows) { rows = c.rows.slice(); fillFilters(); render(); return; } }
      // The module ships ahead of its migration on some environments — be explicit.
      var missing = /column|schema cache|PGRST204|does not exist/i.test(res.error.message || '');
      document.getElementById('ms-view').innerHTML = '<div class="pd-card ms-empty"><h3>Could not load the log</h3><p>' +
        esc(res.error.message) + '</p>' + (missing ? '<p class="ms-mut">Run <code>migrations/2026-07-20-material-submittal-full.sql</code> in the Supabase SQL editor, then reload.</p>' : '') + '</div>';
      return;
    }
    rows = all;
    // Stable order: sort_order then the workbook's own NO., then item.
    rows.sort(function (a, b) {
      var d = (a.sort_order || 0) - (b.sort_order || 0); if (d) return d;
      d = (a.seq_no || 0) - (b.seq_no || 0); if (d) return d;
      return String(a.material || '').localeCompare(String(b.material || ''));
    });
    if (window.PDSync) PDSync.cachePut('ms:' + pid, rows);   // refresh the offline cache
    fillFilters();
    render();
  }

  function switchTab(v) {
    // Registry and Backlog are different lists; a selection carried between them
    // would leave the bulk bar counting rows you can no longer see.
    if (view !== v) sel = {};
    view = v;
    document.querySelectorAll('.ms-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.view === v); });
    render();
  }

  async function init(user, profile) {
    UID = (user && user.id) || (profile && profile.id) || null;
    PROFILE = profile;
    isAdmin = !!(profile && (profile.role === 'admin' || profile.role === 'super_admin'));
    canWrite = !!(profile && ['super_admin', 'admin', 'planner'].indexOf(profile.role) !== -1);
    UI.initShell();

    document.getElementById('ms-clear').style.display = isAdmin ? '' : 'none';
    if (!canWrite) {
      ['ms-add', 'ms-import'].forEach(function (id) { var b = document.getElementById(id); if (b) b.style.display = 'none'; });
    }

    // ---- project selector (shared searchable browser) ----
    var selEl = document.getElementById('ms-project');
    var projects = [];
    try { projects = (await PDb.getProjects()) || []; } catch (e) { projects = []; }
    projects = projects.filter(function (p) { return !AppAuth.canAccessProject || AppAuth.canAccessProject(profile, p.id); });
    selEl.innerHTML = projects.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name || p.id) + '</option>'; }).join('');
    var stored = sessionStorage.getItem('pd_project');
    if (stored && projects.some(function (p) { return String(p.id) === String(stored); })) selEl.value = stored;
    pid = selEl.value || (projects[0] && projects[0].id) || null;
    if (UI.enhanceProjectSelect) UI.enhanceProjectSelect(selEl);
    selEl.addEventListener('change', function () {
      pid = selEl.value;
      sessionStorage.setItem('pd_project', pid);
      sel = {}; collapsed = {}; noteDismissed = false;
      // A drill-through aging filter / column sort / page cap must not leak
      // across projects.
      bkAging = ''; bkShowAll = false; logSort = { col: null, dir: 1 };
      tsDefaults = null;                    // client name is per project

      load();
      joinCollab();
    });

    // ---- tabs ----
    document.querySelectorAll('.ms-tab').forEach(function (t) {
      t.onclick = function () { switchTab(t.dataset.view); };
    });

    // ---- tools ----
    document.getElementById('ms-add').onclick = function () { openForm(null); };
    document.getElementById('ms-import').onclick = function () { document.getElementById('ms-file').click(); };
    document.getElementById('ms-file').addEventListener('change', onFile);
    document.getElementById('ms-export').onclick = exportExcel;
    document.getElementById('ms-print').onclick = function () {
      if (view !== 'log') switchTab('log');
      setTimeout(function () { window.print(); }, 60);
    };
    document.getElementById('ms-clear').onclick = clearAll;
    document.getElementById('ms-rfa').onclick = function () { openTopSheet('RFA', null); };
    document.getElementById('ms-rfi').onclick = function () { openTopSheet('RFI', null); };

    // ---- filters ----
    var q = document.getElementById('ms-f-search'), t = null;
    q.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { filters.q = q.value; render(); }, 160);
    });
    document.getElementById('ms-f-section').addEventListener('change', function (e) { filters.section = e.target.value; render(); });
    document.getElementById('ms-f-discipline').addEventListener('change', function (e) { filters.disc = e.target.value; render(); });
    document.getElementById('ms-f-status').addEventListener('change', function (e) { filters.status = e.target.value; render(); });
    document.getElementById('ms-f-pres').addEventListener('change', function (e) { filters.pres = e.target.value; render(); });
    document.getElementById('ms-f-overdue').addEventListener('change', function (e) { filters.overdue = e.target.checked; render(); });
    document.getElementById('ms-f-clear').onclick = function () {
      filters = { q: '', section: '', disc: '', status: '', pres: '', overdue: false };
      q.value = '';
      ['ms-f-section', 'ms-f-discipline', 'ms-f-status', 'ms-f-pres'].forEach(function (id) { document.getElementById(id).value = ''; });
      document.getElementById('ms-f-overdue').checked = false;
      render();
    };

    await load();
    joinCollab();
  }

  // Exposed for the harness/tests as well as the page.
  return {
    init: init,
    _internals: { parseWorkbook: parseWorkbook, scurve: scurve, legacyScurve: legacyScurve,
      statusCounts: statusCounts, kpis: kpis, parseDate: parseDate, normStatus: normStatus,
      normPres: normPres, setPid: function (x) { pid = x; } }
  };
})();
