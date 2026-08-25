// ============================================================================
// Megawide Engineering App — Cross-module read model (EngData)
// ----------------------------------------------------------------------------
// The dashboard and the notifications page need aggregates that span modules,
// but MODULE_CONTRACT.md is emphatic that modules must not query each other's
// tables. This file is the sanctioned exception: a SHELL-owned, READ-ONLY
// aggregation layer. It never writes. Modules keep owning their own writes.
//
// ⚠️ The status vocabularies below are duplicated from the modules on purpose —
// they are the modules' own private constants and the shell cannot import them
// (no module system). They MUST stay in sync:
//   drawing-register/module.js   → STATUSES, LEGACY_STATUS, isApprovedStatus()
//   material-submittal/module.js → STATUSES, DONE, isOverdue()
//   value-engineering/module.js  → STATUSES (its open/won flags), savingOf/realisedOf
//   initiatives/module.js        → STATUSES (its closed flag), isOverdue()
//   method-register/module.js    → STATUSES, LEGACY_STATUS, `counts` (the N=1 gate)
// If a module's status list changes, change it here too or the dashboard will
// quietly under-count. There is a self-check in EngData.selfTest() for this.
//
// ⚠️ `initiatives` is ORG-WIDE (nullable project_id) and is the one table here
// that must NOT be read through fetchAll() — see fetchAllOrgWide().
//
// Nothing here is hardcoded data — only vocabulary. Every count is a live query
// scoped by project, and RLS guarantees a user aggregates only rows they may
// read (so a `user` assigned to one project sees that project's totals only).
// ============================================================================

(function () {
  function sb() { return window.getSB(); }

  // ---- Drawing Register vocabulary (mirrors module.js) ---------------------
  // Display order for the status chart. The first seven mirror module.js's own
  // STATUSES (what the UI offers). The last three are NOT offered by the UI but
  // are present in years of migrated Planning App data, so they must be declared
  // here or they fall outside the chart's ordering.
  var DR_STATUSES = ['Not Started', 'In Progress', 'Submitted', 'Resubmit',
                     'Approved w/ comments', 'Approved', 'Cancelled',
                     'For Review', 'Revise & Resubmit', 'Superseded'];
  var DR_LEGACY = { 'Ongoing': 'In Progress', 'Pending': 'Submitted',
                    'Approved w/o comments': 'Approved' };
  function drStatus(s) { return (s && DR_LEGACY[s]) || s || 'Not Started'; }
  function drApproved(s) {
    s = drStatus(s);
    return s === 'Approved' || s === 'Approved w/ comments';
  }

  // ⚠️ KPI BUCKETS — the migrated Planning App data contains statuses that are in
  // NEITHER DR_STATUSES above NOR the module's own LEGACY_STATUS map, because both
  // lists describe the vocabulary the UI offers, not the vocabulary years of real
  // data actually contain. On BAU101 the real values include:
  //
  //     For Review (12)   Revise & Resubmit (2)   Superseded (2)
  //
  // drStatus() passes an unrecognised value straight through, so those rendered
  // correctly in the chart but matched none of the KPI conditions — the dashboard
  // reported "0 Under Review" and "0 For Revision" while 14 drawings sat in
  // exactly those states. Silently wrong, which is worse than visibly broken.
  //
  // Buckets are kept SEPARATE from labels on purpose. Folding 'For Review' into
  // 'Submitted' via DR_LEGACY would fix the counts but relabel the user's own
  // data in the chart — people recognise their register by its own words. So the
  // label is preserved and only the bucketing is normalised.
  var DR_BUCKET = {
    'Approved':             'approved',
    'Approved w/ comments': 'approved',
    'Submitted':            'underReview',
    'For Review':           'underReview',   // real data; same meaning as Submitted
    'Resubmit':             'forRevision',
    'Revise & Resubmit':    'forRevision',   // real data; same meaning as Resubmit
    'In Progress':          'inProgress',
    'Not Started':          'notStarted',
    'Cancelled':            'cancelled',
    'Superseded':           'cancelled'      // replaced by a newer drawing — not live work
  };
  // 'Resubmit' is deliberately in forRevision only, not also underReview: a
  // drawing sent back for rework is owed by US, not awaiting someone else's
  // review, and counting it twice made the two tiles sum past the total.
  function drBucket(s) { return DR_BUCKET[drStatus(s)] || null; }
  // Colour by MEANING, not by module. The available tokens are only ok/warn/bad
  // plus the brand reds, so the mapping is: grey = nothing owed yet, neutral =
  // we are working on it, amber = waiting on someone else, red = rejected/rework,
  // green = done. Submitted is deliberately AMBER, not red — it is a healthy
  // in-flight state, and rendering it in brand red made a normal register look
  // like it was full of failures, and made it hard to tell from Resubmit.
  function drStatusCls(s) {
    s = drStatus(s);
    if (s === 'Approved') return 'eng-c-ok';
    if (s === 'Approved w/ comments') return 'eng-c-okc';
    if (s === 'Submitted' || s === 'For Review') return 'eng-c-warn';
    if (s === 'Resubmit' || s === 'Revise & Resubmit') return 'eng-c-bad';
    if (s === 'In Progress') return 'eng-c-wip';
    if (s === 'Cancelled' || s === 'Superseded') return 'eng-c-off';
    return 'eng-c-ns';
  }

  // ---- Material Submittal vocabulary (mirrors module.js) -------------------
  var MS_STATUSES = ['Approved', 'Approved w/ Comments', 'Resubmit', 'Rejected',
                     'For Information', 'Pending Approval', 'For Submission'];
  var MS_DONE = { 'Approved': 1, 'Approved w/ Comments': 1 };
  function msStatus(s) { return s || 'Pending Approval'; }
  function msStatusCls(s) {
    s = msStatus(s);
    if (s === 'Approved') return 'eng-c-ok';
    if (s === 'Approved w/ Comments') return 'eng-c-okc';
    if (s === 'Resubmit') return 'eng-c-warn';
    if (s === 'Rejected') return 'eng-c-bad';
    if (s === 'For Information') return 'eng-c-info';
    if (s === 'For Submission') return 'eng-c-ns';
    return 'eng-c-wip';
  }
  // ---- Value Engineering vocabulary (mirrors module.js) --------------------
  // ⚠️ `open` / `won` mirror the module's own STATUSES flags. They must stay a
  // PARTITION — every status in exactly one of open / won / rejected — or the
  // tiles stop summing to the total, the failure DR_BUCKET documents above.
  var VE_STATUSES = ['Proposed', 'Under Review', 'Endorsed', 'Approved',
                     'Implemented', 'On Hold', 'Rejected'];
  var VE_OPEN = { 'Proposed': 1, 'Under Review': 1, 'Endorsed': 1, 'On Hold': 1 };
  var VE_WON  = { 'Approved': 1, 'Implemented': 1 };
  function veStatus(s) { return (s || '').trim() || 'Proposed'; }
  function veStatusCls(s) {
    s = veStatus(s);
    if (s === 'Implemented') return 'eng-c-ok';
    if (s === 'Approved') return 'eng-c-okc';
    if (s === 'Endorsed' || s === 'Under Review') return 'eng-c-warn';
    if (s === 'Rejected') return 'eng-c-bad';
    if (s === 'On Hold') return 'eng-c-wip';
    return 'eng-c-ns';
  }

  // ---- Initiatives vocabulary (mirrors module.js) --------------------------
  var IN_STATUSES = ['Idea', 'Planned', 'In Progress', 'On Hold', 'Completed', 'Cancelled'];
  var IN_CLOSED = { 'Completed': 1, 'Cancelled': 1 };
  function inStatus(s) { return (s || '').trim() || 'Idea'; }
  function inStatusCls(s) {
    s = inStatus(s);
    if (s === 'Completed') return 'eng-c-ok';
    if (s === 'In Progress') return 'eng-c-warn';
    if (s === 'Cancelled') return 'eng-c-bad';
    if (s === 'On Hold') return 'eng-c-wip';
    if (s === 'Planned') return 'eng-c-info';
    return 'eng-c-ns';
  }

  // ---- Method Register vocabulary (mirrors module.js) ----------------------
  // ⚠️ `counts` (the workbook's N=1 flag) gates EVERY figure here, exactly as it
  // does in the module — a register that ignored it would over-report the
  // programme by ~3x on the workbook it was built from. See method-register's
  // CLAUDE.md.
  var MR_STATUSES = ['Open', 'Approved', 'Approved w/ Comments', 'Disapproved'];
  // The workbook writes 'Approved' with no qualifier and '-' for "nothing yet" —
  // reproduced VERBATIM from the module's own LEGACY_STATUS.
  var MR_LEGACY = { '-': '', 'approved w/comments': 'Approved w/ Comments',
    'approved with comments': 'Approved w/ Comments', 'disapprove': 'Disapproved' };
  function mrStatus(s) {
    s = (s || '').trim();
    var k = MR_LEGACY[s.toLowerCase()];
    s = k === undefined ? s : k;
    return s || 'Open';   // blank / '-' is the module's unnamed "not yet" state
  }
  function mrStatusCls(s) {
    s = mrStatus(s);
    if (s === 'Approved') return 'eng-c-ok';
    if (s === 'Approved w/ Comments') return 'eng-c-okc';
    if (s === 'Disapproved') return 'eng-c-bad';
    return 'eng-c-ns';
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }
  function n(v) { return (v === null || v === undefined || v === '' || isNaN(+v)) ? null : +v; }

  // Paged read. The modules use keyset pagination because a big register can
  // exceed PostgREST's 1000-row default cap; the dashboard must do the same or
  // its totals silently stop at 1000.
  async function fetchAll(table, cols, pid) {
    var out = [], last = null, PAGE = 1000;
    for (;;) {
      var q = sb().from(table).select(cols).eq('project_id', pid).order('id').limit(PAGE);
      if (last) q = q.gt('id', last);
      var res = await q;
      if (res.error) throw res.error;
      var rows = res.data || [];
      out = out.concat(rows);
      if (rows.length < PAGE) break;
      last = rows[rows.length - 1].id;
    }
    return out;
  }

  // ⚠️ The org-wide variant. `fetchAll` hardcodes `.eq('project_id', pid)`, which
  // is right for every project-scoped table and WRONG for `initiatives`, whose
  // project_id is nullable — that filter drops every company-wide row, i.e. most
  // of the table. This one applies no project predicate and lets RLS decide;
  // callers split the rows themselves. Do not "fix" one into the other.
  async function fetchAllOrgWide(table, cols) {
    var out = [], last = null, PAGE = 1000;
    for (;;) {
      var q = sb().from(table).select(cols).order('id').limit(PAGE);
      if (last) q = q.gt('id', last);
      var res = await q;
      if (res.error) throw res.error;
      var rows = res.data || [];
      out = out.concat(rows);
      if (rows.length < PAGE) break;
      last = rows[rows.length - 1].id;
    }
    return out;
  }

  // ==========================================================================
  // PORTFOLIO — the same drawing model, read across EVERY accessible project
  // --------------------------------------------------------------------------
  // ⚠️ USES fetchAllOrgWide ON A PROJECT-SCOPED TABLE, AND THAT IS ITS INTENDED
  // USE. `fetchAll` hardcodes `.eq('project_id', pid)`, which is exactly wrong for
  // a portfolio: we want every project the signed-in user may read and no more.
  // Applying no project predicate and letting RLS decide is what makes this
  // correct — a `user` assigned to one project gets a one-project portfolio,
  // with no code here deciding that.
  //
  // ⚠️ COMPUTED IN THE CLIENT FROM RAW ROWS, NOT BY A SQL RPC, DELIBERATELY.
  // A `portfolio_engineering_summary()` RPC was the obvious move (planning-app has
  // one for resources) and was rejected: the drawing register's roll-up rules are
  // intricate — a sheet is a drawing whose parent is a drawing, a single-sheet
  // row's STATUS is its approval, sentinel dates must be refused — and every one of
  // those would have to be re-expressed in SQL. That is a SECOND DEFINITION of
  // numbers the register already defines, and this repo's history is full of what
  // that costs (`rollup()` vs `syncParent()` disagreeing about "approved" produced a
  // row that stored 1/2 and displayed 0/2). The same rules are applied here, in one
  // place, over the same vocabulary this file already shares with the modules.
  //
  // ⚠️ THE HONEST LIMIT, AND IT MUST STAY STATED IN THE UI: design progress here is
  // counted in DRAWINGS, while the per-project Overview counts CD/SD/FCD/TWD in
  // TRACKING UNITS (`is_tracking_unit`, a Technical Officer's designation). Those are
  // two different bases and their percentages legitimately differ. Reproducing the
  // tracking-unit basis needs the whole level tree and its nested-unit refusal rule,
  // which is the register's own job. ISD is the one level whose basis is identical
  // (partial sheet credit), so ISD figures here match the register exactly — which is
  // precisely why ISD gets its own reporting on the portfolio.
  var PORTFOLIO_WARN_ROWS = 40000;

  function validApprovalDate(d) {
    // Same guard, same range, as the register's validDate(): a legacy import
    // sentinel like '2000-01-06' is not a date and must never win a min()/max().
    if (!d) return false;
    var y = +String(d).slice(0, 4);
    return y >= 2015 && y <= 2100;
  }

  // The five fixed top levels, in the register's own order. A register that holds a
  // name outside this set still reports — under its own name, at the end — rather
  // than being dropped.
  var TOP_LEVELS = ['Concept Design', 'Schematic Design', 'For Construction Drawings',
    'Temporary Works Drawings', 'Individual Services Drawings'];
  var ISD = 'Individual Services Drawings';

  // ⚠️ AGING VOCABULARY COPIED VERBATIM FROM drawing-register's agingBucketOf(),
  // not re-derived. That module calls it "the single source of truth for which bucket a
  // row falls in — used to build the chart, to colour the Aging cell, and to filter the
  // Backlog, so the three can never disagree". A portfolio that bucketed the same
  // drawings differently would be a fourth opinion, and the one people compare against
  // the register.
  var AGING_ORDER = ['>60d overdue', '31–60d overdue', '1–30d overdue',
                     'Due ≤7 days', 'Not due yet', 'No due date'];
  function agingBucket(days) {
    if (days == null)  return 'No due date';
    if (days > 60)     return '>60d overdue';
    if (days > 30)     return '31–60d overdue';
    if (days > 0)      return '1–30d overdue';
    if (days >= -7)    return 'Due ≤7 days';
    return 'Not due yet';
  }
  // Whole days between two ISO dates by UTC arithmetic on the date parts only, so no
  // timezone can shift it — the trap this repo documents repeatedly.
  function daysBetweenISO(a, b) {
    if (!a || !b) return null;
    var x = String(a).slice(0, 10).split('-'), y = String(b).slice(0, 10).split('-');
    if (x.length !== 3 || y.length !== 3) return null;
    var ta = Date.UTC(+x[0], +x[1] - 1, +x[2]), tb = Date.UTC(+y[0], +y[1] - 1, +y[2]);
    if (isNaN(ta) || isNaN(tb)) return null;
    return Math.round((tb - ta) / 86400000);
  }

  async function portfolio(opts) {
    opts = opts || {};
    var today = todayISO();
    var rows = await fetchAllOrgWide('drawing_register',
      'id,project_id,drawing_no,drawing_code,title,status,node_kind,parent_id,phase,' +
      'no_of_sheets,approved_sheets,planned_approval,actual_approval,updated_at');

    // Said out loud rather than silently truncated — the planning app's cross-project
    // S-Curve warns the same way above 20,000 activities.
    var warning = rows.length >= PORTFOLIO_WARN_ROWS
      ? 'Read ' + rows.length.toLocaleString() + ' drawing rows across the portfolio. ' +
        'This is a large read; consider narrowing the project filter.'
      : null;

    var byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });
    function isNodeRow(r) { return !!r && !!r.node_kind && r.node_kind !== 'drawing'; }
    // ⚠️ THE RULE, copied from the register rather than re-derived: a sheet is a
    // drawing whose PARENT IS ITSELF A DRAWING. Since 0017 a drawing also carries a
    // level node's parent_id, so "has a parent" would classify every drawing as a
    // sheet — the exact bug that made the dashboard tile read zero.
    function isSheetRow(r) {
      if (!r.parent_id) return false;
      var p = byId[r.parent_id];
      return !!p && !isNodeRow(p);
    }

    var proj = {};                       // project_id -> aggregate
    function bucketFor(pidKey, phase) {
      var p = proj[pidKey] || (proj[pidKey] = {
        project_id: pidKey, drawings: 0, approvedDrawings: 0, sheets: 0, approvedSheets: 0,
        overdue: 0, minPlanned: null, maxPlanned: null, maxActual: null,
        levels: {}, isd: null,
        // ⚠️ Kept PER PROJECT, never pre-summed. The portfolio's project filter and its
        // group-head grouping both narrow the set after this runs, so a total computed
        // here could not be narrowed and would silently describe the whole department
        // while the page claimed to show one group.
        months: {},     // 'YYYY-MM' -> { planned, actual }  (approvals, for the S-curve)
        status: {},     // drStatus label -> count
        aging: {}       // aging bucket -> count, OPEN drawings only
      });
      var L = p.levels[phase] || (p.levels[phase] = {
        phase: phase, drawings: 0, approvedDrawings: 0, sheets: 0, approvedSheets: 0,
        overdue: 0, minPlanned: null, maxPlanned: null, maxActual: null
      });
      return { p: p, L: L };
    }

    rows.forEach(function (r) {
      if (isNodeRow(r)) return;          // the level tree is structure, not work
      if (isSheetRow(r)) return;         // a sheet's counters live inside its parent
      var pidKey = r.project_id || '(none)';
      var phase = (r.phase || '').trim() || '(unclassified)';
      var b = bucketFor(pidKey, phase), p = b.p, L = b.L;

      var tot = n(r.no_of_sheets) || 0;
      // ⚠️ A SINGLE-SHEET ROW'S STATUS *IS* ITS APPROVAL — the register's approvedOf()
      // rule. Trusting approved_sheets alone under-reports every row whose importer
      // set a status but never filled the counter; the register measured 11 such rows
      // on BAU101 alone.
      var ap = tot <= 1 ? (drApproved(r.status) ? 1 : 0) : (n(r.approved_sheets) || 0);

      p.drawings++; L.drawings++;
      p.sheets += tot; L.sheets += tot;
      p.approvedSheets += ap; L.approvedSheets += ap;
      if (drApproved(r.status)) { p.approvedDrawings++; L.approvedDrawings++; }

      var pl = r.planned_approval;
      if (validApprovalDate(pl)) {
        if (!p.minPlanned || pl < p.minPlanned) p.minPlanned = pl;
        if (!p.maxPlanned || pl > p.maxPlanned) p.maxPlanned = pl;
        if (!L.minPlanned || pl < L.minPlanned) L.minPlanned = pl;
        if (!L.maxPlanned || pl > L.maxPlanned) L.maxPlanned = pl;
        // Overdue = its own committed date has passed and it is not approved.
        if (pl < today && !drApproved(r.status)) { p.overdue++; L.overdue++; }
      }
      var ac = r.actual_approval;
      if (validApprovalDate(ac)) {
        if (!p.maxActual || ac > p.maxActual) p.maxActual = ac;
        if (!L.maxActual || ac > L.maxActual) L.maxActual = ac;
      }

      // ---- approvals over time -----------------------------------------------
      // A drawing contributes to the PLANNED series in the month it was due and to the
      // ACTUAL series in the month it was approved. Those are different months whenever
      // anything ran late, which is the entire point of plotting them together.
      var mk;
      if (validApprovalDate(pl)) {
        mk = pl.slice(0, 7);
        (p.months[mk] = p.months[mk] || { planned: 0, actual: 0 }).planned++;
      }
      if (validApprovalDate(ac)) {
        mk = ac.slice(0, 7);
        (p.months[mk] = p.months[mk] || { planned: 0, actual: 0 }).actual++;
      }

      // ---- status ------------------------------------------------------------
      // drStatus() maps the legacy spellings, so a register still holding 'Ongoing' or
      // 'For Review' is counted under the name it became rather than as its own slice.
      var st = drStatus(r.status);
      p.status[st] = (p.status[st] || 0) + 1;

      // ---- aging of the OPEN queue -------------------------------------------
      // ⚠️ The open test mirrors the register's own: not approved, OR sent back for
      // rework. `Resubmit` is not an approved status so the second clause is redundant
      // today — it is kept because the register keeps it, and these two must not drift.
      if (!drApproved(r.status) || st === 'Resubmit') {
        var ad = validApprovalDate(pl) ? daysBetweenISO(pl, today) : null;
        var ab = agingBucket(ad);
        p.aging[ab] = (p.aging[ab] || 0) + 1;
      }
    });

    // Finish each project: percentages, the ordered level list, and ISD pulled out.
    var list = Object.keys(proj).map(function (k) {
      var p = proj[k];
      p.levels = Object.keys(p.levels).sort(function (a, b) {
        var ia = TOP_LEVELS.indexOf(a), ib = TOP_LEVELS.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
      }).map(function (nm) {
        var L = p.levels[nm];
        L.pctSheets = L.sheets ? Math.round((L.approvedSheets / L.sheets) * 100) : 0;
        L.pctDrawings = L.drawings ? Math.round((L.approvedDrawings / L.drawings) * 100) : 0;
        return L;
      });
      // ⚠️ ISD is reported on the SHEET basis and everything else on the DRAWING
      // basis, and the two are never added together. That is the same decision the
      // register's Overview Gantt made: one headline number cannot describe two
      // counting bases, so each states its own.
      p.isd = p.levels.filter(function (L) { return L.phase === ISD; })[0] || null;
      p.design = p.levels.filter(function (L) { return L.phase !== ISD; });
      p.designDrawings = p.design.reduce(function (a, L) { return a + L.drawings; }, 0);
      p.designApproved = p.design.reduce(function (a, L) { return a + L.approvedDrawings; }, 0);
      p.pctDesign = p.designDrawings ? Math.round((p.designApproved / p.designDrawings) * 100) : 0;
      p.pctSheets = p.sheets ? Math.round((p.approvedSheets / p.sheets) * 100) : 0;
      return p;
    });

    return { projects: list, rowsRead: rows.length, warning: warning, today: today,
             TOP_LEVELS: TOP_LEVELS, ISD: ISD, AGING_ORDER: AGING_ORDER };
  }

  function tally(rows, keyFn, order, clsFn) {
    var m = {};
    rows.forEach(function (r) { var k = keyFn(r); m[k] = (m[k] || 0) + 1; });
    // Known statuses first in their canonical order, then any unexpected value
    // still present in the data (so bad imports are visible, not swallowed).
    var seen = {}, out = [];
    order.forEach(function (k) {
      seen[k] = 1;
      if (m[k]) out.push({ label: k, n: m[k], cls: clsFn(k) });
    });
    Object.keys(m).forEach(function (k) {
      if (!seen[k]) out.push({ label: k, n: m[k], cls: clsFn(k) });
    });
    return out;
  }

  var EngData = {
    DR_STATUSES: DR_STATUSES, MS_STATUSES: MS_STATUSES,
    VE_STATUSES: VE_STATUSES, IN_STATUSES: IN_STATUSES, MR_STATUSES: MR_STATUSES,
    drStatus: drStatus, drStatusCls: drStatusCls,
    msStatus: msStatus, msStatusCls: msStatusCls,
    veStatus: veStatus, veStatusCls: veStatusCls,
    inStatus: inStatus, inStatusCls: inStatusCls,
    mrStatus: mrStatus, mrStatusCls: mrStatusCls,

    // ---- Drawing Register ------------------------------------------------
    async drawingStats(pid) {
      var rows = await fetchAll('drawing_register',
        'id,drawing_no,drawing_code,title,revision,status,node_kind,parent_id,submissions,updated_at,discipline',
        pid);

      // The table stores the level TREE in the same table as the drawings
      // (node_kind), and a sheet is a drawing row whose parent is another drawing.
      // Counting raw rows would inflate every KPI.
      //
      // ⚠️ "no parent_id" IS NOT "not a sheet" any more (migration 0017). parent_id
      // now also links a drawing to its LEVEL node, so the old test classified every
      // drawing as a sheet and this tile silently reported zero drawings. Which kind
      // of edge it is depends on the PARENT: a sheet's parent is itself a drawing.
      var byId = {};
      rows.forEach(function (r) { byId[r.id] = r; });
      function isNodeRow(r) { return !!r && !!r.node_kind && r.node_kind !== 'drawing'; }
      function isSheetRow(r) {
        if (!r.parent_id) return false;
        var p = byId[r.parent_id];
        return !!p && !isNodeRow(p);
      }
      var draw   = rows.filter(function (r) { return !isNodeRow(r) && !isSheetRow(r); });
      var sheets = rows.filter(function (r) { return !isNodeRow(r) &&  isSheetRow(r); });

      // Bucketed via drBucket so real-world statuses ('For Review',
      // 'Revise & Resubmit', 'Superseded') land in a tile instead of vanishing.
      var approved = 0, underReview = 0, forRevision = 0, notStarted = 0,
          cancelled = 0, inProgress = 0, unbucketed = [];
      draw.forEach(function (r) {
        switch (drBucket(r.status)) {
          case 'approved':    approved++;    break;
          case 'underReview': underReview++; break;
          case 'forRevision': forRevision++; break;
          case 'notStarted':  notStarted++;  break;
          case 'cancelled':   cancelled++;   break;
          case 'inProgress':  inProgress++;  break;
          default: unbucketed.push(drStatus(r.status));
        }
      });
      // A status nobody has bucketed is counted in `total` but in no tile, so the
      // tiles silently under-report. Surface it rather than let it hide.
      if (unbucketed.length) {
        console.warn('[EngData] drawing statuses in no KPI bucket — dashboard tiles ' +
          'will under-report. Add them to DR_BUCKET in engdata.js:',
          Array.from(new Set(unbucketed)));
      }

      // Most recently touched drawings, with the revision actually reached.
      var latest = draw.slice().sort(function (a, b) {
        return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
      }).slice(0, 8).map(function (r) {
        var subs = Array.isArray(r.submissions) ? r.submissions : [];
        var rev = subs.length ? subs[subs.length - 1].rev : r.revision;
        return { drawing_no: r.drawing_no || r.drawing_code, title: r.title,
                 revision: rev, status: drStatus(r.status) };
      });

      return {
        total: draw.length,
        sheets: sheets.length,
        approved: approved,
        underReview: underReview,
        forRevision: forRevision,
        notStarted: notStarted,
        // "Active" = a live document: neither finished nor abandoned.
        active: draw.length - approved - cancelled,
        pctApproved: draw.length ? Math.round(approved / draw.length * 100) : 0,
        byStatus: tally(draw, function (r) { return drStatus(r.status); }, DR_STATUSES, drStatusCls),
        latest: latest,
      };
    },

    // ---- Material Submittal Log ------------------------------------------
    async submittalStats(pid) {
      var rows = await fetchAll('material_submittal',
        'id,submittal_no,material,status,revision_no,plan_approval_date,date_approved,date_submitted,updated_at,discipline',
        pid);

      var today = todayISO();
      var approved = 0, approvedC = 0, rejected = 0, forReview = 0, overdue = 0, resubmit = 0;
      var attention = [];
      rows.forEach(function (r) {
        var s = msStatus(r.status);
        if (s === 'Approved') approved++;
        if (s === 'Approved w/ Comments') approvedC++;
        if (s === 'Rejected') rejected++;
        if (s === 'Resubmit') resubmit++;
        if (s === 'Pending Approval') forReview++;
        // Overdue mirrors the module's isOverdue(): a planned approval date in
        // the past on something not yet approved. No plan date = no commitment
        // to miss, so it is never overdue.
        if (!MS_DONE[s] && r.plan_approval_date &&
            String(r.plan_approval_date).slice(0, 10) < today) {
          overdue++;
          attention.push(r);
        }
      });
      attention.sort(function (a, b) {
        return String(a.plan_approval_date).localeCompare(String(b.plan_approval_date));
      });

      return {
        total: rows.length,
        approved: approved, approvedC: approvedC, rejected: rejected,
        forReview: forReview, resubmit: resubmit, overdue: overdue,
        pctApproved: rows.length ? Math.round((approved + approvedC) / rows.length * 100) : 0,
        byStatus: tally(rows, function (r) { return msStatus(r.status); }, MS_STATUSES, msStatusCls),
        attention: attention.slice(0, 8),
      };
    },

    // ---- Method Register ---------------------------------------------------
    // ⚠️ Mirrors the module's own totals(): every figure is a real SUM, INCLUDING
    // the two percentages, over COUNTED items only (node_kind is null AND
    // counts !== false). The module's Summary separately reproduces the source
    // workbook's own AVERAGE-of-ratios total to prove it differs — that
    // reconciliation is specific to the one workbook this module was built
    // against and is not reproduced here; the dashboard reports the aggregate
    // only, same as the sibling KPI rows do for their own modules.
    async methodStats(pid) {
      var rows = await fetchAll('method_register',
        'id,node_kind,trade_code,status,ball_in,counts,target_date,updated_at', pid);
      var items = rows.filter(function (r) { return !r.node_kind && r.counts !== false; });

      var app = 0, awc = 0, dis = 0, engg = 0, ops = 0, closed = 0, unassigned = 0, unbucketed = [];
      var byTrade = {};
      items.forEach(function (r) {
        var s = mrStatus(r.status);
        if (s === 'Approved') app++;
        else if (s === 'Approved w/ Comments') awc++;
        else if (s === 'Disapproved') dis++;
        else if (s !== 'Open') unbucketed.push(s);   // MR_STATUSES is closed, so this should never fire
        var b = (r.ball_in || '').trim().toLowerCase();
        if (b === 'engg') engg++; else if (b === 'ops') ops++;
        else if (b === 'closed') closed++; else unassigned++;

        var tc = r.trade_code || '(unassigned)';
        if (!byTrade[tc]) byTrade[tc] = { code: tc, total: 0, submitted: 0 };
        byTrade[tc].total++;
        if (s === 'Approved' || s === 'Approved w/ Comments' || s === 'Disapproved') byTrade[tc].submitted++;
      });
      if (unbucketed.length) {
        console.warn('[EngData] method_register statuses in no KPI bucket — dashboard ' +
          'tiles will under-report. Add them to methodStats() in engdata.js:',
          Array.from(new Set(unbucketed)));
      }

      var submitted = app + awc + dis;

      // Trades with the most work still outstanding — what someone opening the
      // dashboard can actually act on. Ties broken by trade code for a stable order.
      var byTradeList = Object.keys(byTrade).map(function (k) { return byTrade[k]; })
        .sort(function (a, b) {
          return (b.total - b.submitted) - (a.total - a.submitted) || a.code.localeCompare(b.code);
        }).slice(0, 8);

      return {
        total: items.length,
        submitted: submitted, approved: app, awc: awc, disapproved: dis,
        balance: items.length - submitted,
        progress: items.length ? Math.round(submitted / items.length * 100) : 0,
        pctApproved: items.length ? Math.round(app / items.length * 100) : 0,
        unassigned: unassigned, engg: engg, ops: ops, closed: closed,
        byStatus: tally(items, function (r) { return mrStatus(r.status); }, MR_STATUSES, mrStatusCls),
        byTrade: byTradeList,
      };
    },

    // ---- Value Engineering List ------------------------------------------
    // ⚠️ Mirrors the module's own rule: the CLAIMED saving and the REALISED one
    // are different numbers and are never added together. `pipeline` is the
    // claim of undecided items, `approvedSaving` the claim of Approved +
    // Implemented, `realised` is baseline − actual. A dashboard that summed them
    // would report a project as having saved money it has not spent yet.
    async veStats(pid) {
      var rows = await fetchAll('value_engineering',
        'id,ve_no,title,discipline,status,baseline_cost,proposed_cost,actual_cost,' +
        'schedule_impact_days,decision_date,updated_at', pid);

      var open = 0, won = 0, rejected = 0, implemented = 0, unbucketed = [];
      var pipeline = 0, approvedSaving = 0, realised = 0, rejectedValue = 0, days = 0;
      rows.forEach(function (r) {
        var s = veStatus(r.status);
        var b = n(r.baseline_cost), p = n(r.proposed_cost), a = n(r.actual_cost);
        var sav = (b == null || p == null) ? null : b - p;
        if (s === 'Rejected') {
          rejected++; if (sav != null) rejectedValue += sav;
        } else if (VE_OPEN[s]) {
          open++; if (sav != null) pipeline += sav;
        } else if (VE_WON[s]) {
          won++;
          if (sav != null) approvedSaving += sav;
          days += n(r.schedule_impact_days) || 0;
          if (s === 'Implemented') {
            implemented++;
            if (b != null && a != null) realised += b - a;
          }
        } else {
          // Same discipline as DR_BUCKET: a status in no bucket is counted in
          // `total` but in no tile, so the tiles silently under-report.
          unbucketed.push(s);
        }
      });
      if (unbucketed.length) {
        console.warn('[EngData] VE statuses in no KPI bucket — dashboard tiles will ' +
          'under-report. Add them to VE_OPEN/VE_WON in engdata.js:',
          Array.from(new Set(unbucketed)));
      }

      // The biggest claims still awaiting a decision — what someone opening the
      // dashboard can actually act on.
      var pending = rows.filter(function (r) { return VE_OPEN[veStatus(r.status)]; })
        .map(function (r) {
          var b = n(r.baseline_cost), p = n(r.proposed_cost);
          return { ve_no: r.ve_no, title: r.title, status: veStatus(r.status),
                   saving: (b == null || p == null) ? null : b - p };
        })
        .sort(function (x, y) { return (y.saving || 0) - (x.saving || 0); })
        .slice(0, 8);

      return {
        total: rows.length,
        open: open, won: won, rejected: rejected, implemented: implemented,
        pipeline: pipeline, approvedSaving: approvedSaving, realised: realised,
        rejectedValue: rejectedValue, days: days,
        acceptance: (won + rejected) ? Math.round(won / (won + rejected) * 100) : 0,
        byStatus: tally(rows, function (r) { return veStatus(r.status); }, VE_STATUSES, veStatusCls),
        pending: pending,
      };
    },

    // ---- Initiatives (ORG-WIDE) -------------------------------------------
    // ⚠️ This is the one module that is NOT scoped to a project, so "the numbers
    // for this project" is not a well-formed question. The dashboard reports
    // everything that APPLIES here — initiatives pinned to this project, PLUS
    // company-wide ones, which genuinely do apply — and excludes only those
    // pinned to a DIFFERENT project. The split is returned so the section can
    // state it rather than blur it; reporting the pinned ones alone would leave
    // the section permanently empty on most projects, and reporting the union
    // without saying so would look like this project owns company work.
    async initiativeStats(pid) {
      var all = await fetchAllOrgWide('initiatives',
        'id,init_no,title,category,department,owner_name,project_id,status,priority,' +
        'progress_pct,target_date,benefit_type,benefit_value,updated_at');

      var rows = all.filter(function (r) { return !r.project_id || r.project_id === pid; });
      var linked = rows.filter(function (r) { return !!r.project_id; }).length;
      var org = rows.length - linked;

      var today = todayISO();
      var active = 0, completed = 0, cancelled = 0, overdue = 0;
      var costBenefit = 0, costRows = 0, progSum = 0, progN = 0;
      rows.forEach(function (r) {
        var s = inStatus(r.status);
        if (s === 'In Progress') active++;
        if (s === 'Completed') completed++;
        if (s === 'Cancelled') cancelled++;
        // Overdue mirrors the module's isOverdue(): past target and still open.
        // A closed initiative is never overdue however late it finished.
        if (!IN_CLOSED[s] && r.target_date && String(r.target_date).slice(0, 10) < today) overdue++;
        // ⚠️ Cost-type only. A peso figure on a Safety initiative is a different
        // kind of number and is never added in — the module refuses to, and the
        // dashboard must agree or the two screens disagree about the total.
        if (r.benefit_type === 'Cost') {
          var v = n(r.benefit_value);
          if (v != null) { costBenefit += v; costRows++; }
        }
        // ⚠️ Progress averaged over IN PROGRESS rows only — it is hand-entered,
        // with no task breakdown rolling it up, so averaging it over ideas and
        // cancelled work reports a number that means nothing.
        if (s === 'In Progress') {
          var p = n(r.progress_pct);
          if (p != null) { progSum += Math.max(0, Math.min(100, p)); progN++; }
        }
      });

      var attention = rows.filter(function (r) {
        return !IN_CLOSED[inStatus(r.status)] && r.target_date &&
               String(r.target_date).slice(0, 10) < today;
      }).sort(function (a, b) {
        return String(a.target_date).localeCompare(String(b.target_date));
      }).slice(0, 8);

      return {
        total: rows.length, linked: linked, org: org,
        active: active, completed: completed, cancelled: cancelled, overdue: overdue,
        costBenefit: costBenefit, costRows: costRows,
        avgProgress: progN ? Math.round(progSum / progN) : null,
        byStatus: tally(rows, function (r) { return inStatus(r.status); }, IN_STATUSES, inStatusCls),
        attention: attention,
      };
    },

    // ---- Audit trail feed -------------------------------------------------
    // Reads the engineering_activity view from migration 0002. Throws if that
    // migration has not been run — callers should catch and degrade gracefully.
    async recentActivity(pid, limit) {
      var q = sb().from('engineering_activity')
        .select('id,at,table_name,record_id,project_id,action,actor,record_label,summary')
        .order('at', { ascending: false })
        .limit(limit || 25);
      if (pid) q = q.eq('project_id', pid);
      var res = await q;
      if (res.error) throw res.error;
      return res.data || [];
    },

    activityRowHTML: function (a) {
      // 'users' entries come from migration 0007 (privilege changes). Without an
      // entry here the feed printed the raw table name — "updated users
      // fmlozano@…". "access for" makes the sentence read properly:
      //   "Fernando Miguel Lozano updated access for fmlozano@… / role: admin → super_admin"
      var MOD = {
        drawing_register: 'Drawing',
        material_submittal: 'Submittal',
        method_register: 'Method statement',
        value_engineering: 'VE proposal',
        initiatives: 'Initiative',
        users: 'access for'
      };
      var when = a.at ? new Date(a.at) : null;
      var ico = a.action === 'DELETE' ? 'trash' : (a.action === 'INSERT' ? 'plus' : 'pencil');
      var verb = a.action === 'INSERT' ? 'created' : a.action === 'DELETE' ? 'deleted' : 'updated';
      // For INSERT/DELETE the view's `summary` is just the word "created" /
      // "deleted", which the sentence already says — printing both read as
      // "Jose Rizal created Drawing A-103 created". Only show the detail line
      // when it adds something (the status/revision/field diff on an update).
      var detail = (a.summary && a.summary !== verb) ? a.summary : '';
      return '<div class="eng-feed-row">' +
        '<span class="eng-feed-ico eng-feed-' + a.action.toLowerCase() + '" data-ico="' + ico + '" data-ico-size="14"></span>' +
        '<span class="eng-feed-txt"><strong>' + Fmt.esc(a.actor || '(unknown)') + '</strong> ' +
          Fmt.esc(verb) + ' ' +
          Fmt.esc(MOD[a.table_name] || a.table_name) + ' ' +
          '<em>' + Fmt.esc(a.record_label || '—') + '</em>' +
          (detail ? '<small>' + Fmt.esc(detail) + '</small>' : '') + '</span>' +
        '<span class="eng-feed-when" title="' + Fmt.esc(a.at || '') + '">' +
          (when ? Fmt.esc(when.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) : '') +
        '</span></div>';
    },

    // Guards the duplicated vocabulary above. Call from the console after
    // changing a module's status list: EngData.selfTest() logs any status
    // present in the data that this file does not know about.
    // ⚠️ Checks TWO different things, because they fail differently:
    //
    //   unrecognised — the status is not in DR_STATUSES/MS_STATUSES, so it is not
    //     in the chart's declared display order. Cosmetic: it still renders.
    //   UNBUCKETED — the status maps to no KPI bucket, so it is counted in
    //     `total` but in none of the tiles. This is the one that makes the
    //     dashboard silently WRONG, and the original selfTest did not check it:
    //     it only tested label membership. That is how "0 Under Review" shipped
    //     while 12 'For Review' drawings existed.
    //
    // Uses console.warn (not log) when something is wrong, so it survives a
    // console filtered to warnings and is not mistaken for routine output.
    async selfTest(pid) {
      var d = await fetchAll('drawing_register', 'status', pid);
      var m = await fetchAll('material_submittal', 'status', pid);
      // A table whose migration has not been run must not abort the whole check.
      async function tryAll(fn) { try { return await fn(); } catch (e) { return null; } }
      var v = await tryAll(function () { return fetchAll('value_engineering', 'status', pid); });
      // ⚠️ Org-wide: no project predicate. See fetchAllOrgWide.
      var i = await tryAll(function () { return fetchAllOrgWide('initiatives', 'status,project_id'); });
      var mr = await tryAll(function () { return fetchAll('method_register', 'status,node_kind,counts', pid); });

      var unknownDR = {}, unknownMS = {}, unknownVE = {}, unknownIN = {}, unknownMR = {};
      var unbucketedDR = {}, unbucketedVE = {};
      d.forEach(function (r) {
        var s = drStatus(r.status);
        if (DR_STATUSES.indexOf(s) === -1) unknownDR[s] = (unknownDR[s] || 0) + 1;
        if (!drBucket(r.status)) unbucketedDR[s] = (unbucketedDR[s] || 0) + 1;
      });
      m.forEach(function (r) {
        var s = msStatus(r.status);
        if (MS_STATUSES.indexOf(s) === -1) unknownMS[s] = (unknownMS[s] || 0) + 1;
      });
      (v || []).forEach(function (r) {
        var s = veStatus(r.status);
        if (VE_STATUSES.indexOf(s) === -1) unknownVE[s] = (unknownVE[s] || 0) + 1;
        // The VE tiles partition on open / won / rejected — anything in none of
        // the three is counted in `total` but in no tile.
        if (!VE_OPEN[s] && !VE_WON[s] && s !== 'Rejected') unbucketedVE[s] = (unbucketedVE[s] || 0) + 1;
      });
      (i || []).forEach(function (r) {
        var s = inStatus(r.status);
        if (IN_STATUSES.indexOf(s) === -1) unknownIN[s] = (unknownIN[s] || 0) + 1;
      });
      // ⚠️ Only counted items (node_kind null, counts !== false) — the same gate
      // methodStats() applies. A structural trade/group/subgroup row's own
      // `status` column is always null and must not be reported as "unknown".
      (mr || []).filter(function (r) { return !r.node_kind && r.counts !== false; }).forEach(function (r) {
        var s = mrStatus(r.status);
        if (MR_STATUSES.indexOf(s) === -1) unknownMR[s] = (unknownMR[s] || 0) + 1;
      });

      function any(o) { return !!Object.keys(o).length; }
      var out = {
        unrecognised: { drawing_register: unknownDR, material_submittal: unknownMS,
                        value_engineering: unknownVE, initiatives: unknownIN,
                        method_register: unknownMR },
        unbucketed:   { drawing_register: unbucketedDR, value_engineering: unbucketedVE },
        skipped: [].concat(v ? [] : ['value_engineering'], i ? [] : ['initiatives'], mr ? [] : ['method_register']),
        ok: !any(unknownDR) && !any(unknownMS) && !any(unknownVE) && !any(unknownIN) && !any(unknownMR) &&
            !any(unbucketedDR) && !any(unbucketedVE),
      };
      if (any(unbucketedDR)) {
        console.warn('[EngData.selfTest] ✗ statuses in NO KPI bucket — the dashboard ' +
          'tiles UNDER-REPORT. Add to DR_BUCKET in engdata.js:', unbucketedDR);
      }
      if (any(unbucketedVE)) {
        console.warn('[EngData.selfTest] ✗ VE statuses in NO KPI bucket — the dashboard ' +
          'tiles UNDER-REPORT. Add to VE_OPEN/VE_WON in engdata.js:', unbucketedVE);
      }
      if (any(unknownDR) || any(unknownMS) || any(unknownVE) || any(unknownIN) || any(unknownMR)) {
        console.warn('[EngData.selfTest] ⚠️ statuses missing from the declared ' +
          'display order (cosmetic — they still render):', out.unrecognised);
      }
      if (out.skipped.length) {
        console.warn('[EngData.selfTest] — not checked (table unreadable, migration ' +
          'probably not run):', out.skipped);
      }
      if (out.ok) console.log('[EngData.selfTest] ✓ every status recognised and bucketed');
      return out;
    },
  };

  // The portfolio read model + the pure helpers a harness needs to drive it without
  // a database. Exposed for the same reason every module exposes its internals: a
  // verification harness must run the SHIPPED functions, not a copy of them.
  EngData.portfolio = portfolio;
  EngData._portfolio = {
    validApprovalDate: validApprovalDate, TOP_LEVELS: TOP_LEVELS, ISD: ISD,
    AGING_ORDER: AGING_ORDER, agingBucket: agingBucket, daysBetweenISO: daysBetweenISO,
    drApproved: drApproved, PORTFOLIO_WARN_ROWS: PORTFOLIO_WARN_ROWS,
    // Runs the real aggregation over rows supplied by the caller, bypassing only the
    // network. Keeps the maths under test while the fetch is not.
    aggregate: function (rows, today) {
      var _f = fetchAllOrgWide, _t = todayISO;
      fetchAllOrgWide = function () { return Promise.resolve(rows); };
      if (today) todayISO = function () { return today; };
      return portfolio().then(function (out) {
        fetchAllOrgWide = _f; todayISO = _t; return out;
      }, function (e) { fetchAllOrgWide = _f; todayISO = _t; throw e; });
    }
  };

  window.EngData = EngData;
})();
