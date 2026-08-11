// ============================================================================
// Megawide Engineering App — Cross-module read model (EngData)
// ----------------------------------------------------------------------------
// The dashboard and the notifications page need aggregates that span modules,
// but MODULE_CONTRACT.md is emphatic that modules must not query each other's
// tables. This file is the sanctioned exception: a SHELL-owned, READ-ONLY
// aggregation layer. It never writes. Modules keep owning their own writes.
//
// ⚠️ The status vocabularies below are duplicated from the two modules on
// purpose — they are the modules' own private constants and the shell cannot
// import them (no module system). They MUST stay in sync:
//   drawing-register/module.js   → STATUSES, LEGACY_STATUS, isApprovedStatus()
//   material-submittal/module.js → STATUSES, DONE, isOverdue()
// If a module's status list changes, change it here too or the dashboard will
// quietly under-count. There is a self-check in EngData.selfTest() for this.
//
// Nothing here is hardcoded data — only vocabulary. Every count is a live query
// scoped by project, and RLS guarantees a user aggregates only rows they may
// read (so a `user` assigned to one project sees that project's totals only).
// ============================================================================

(function () {
  function sb() { return window.getSB(); }

  // ---- Drawing Register vocabulary (mirrors module.js) ---------------------
  var DR_STATUSES = ['Not Started', 'In Progress', 'Submitted', 'Resubmit',
                     'Approved w/ comments', 'Approved', 'Cancelled'];
  var DR_LEGACY = { 'Ongoing': 'In Progress', 'Pending': 'Submitted',
                    'Approved w/o comments': 'Approved' };
  function drStatus(s) { return (s && DR_LEGACY[s]) || s || 'Not Started'; }
  function drApproved(s) {
    s = drStatus(s);
    return s === 'Approved' || s === 'Approved w/ comments';
  }
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
    if (s === 'Submitted') return 'eng-c-warn';
    if (s === 'Resubmit') return 'eng-c-bad';
    if (s === 'In Progress') return 'eng-c-wip';
    if (s === 'Cancelled') return 'eng-c-off';
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
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

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
    drStatus: drStatus, drStatusCls: drStatusCls,
    msStatus: msStatus, msStatusCls: msStatusCls,

    // ---- Drawing Register ------------------------------------------------
    async drawingStats(pid) {
      var rows = await fetchAll('drawing_register',
        'id,drawing_no,drawing_code,title,revision,status,node_kind,parent_id,submissions,updated_at,discipline',
        pid);

      // The table stores the phase/discipline/category TREE in the same table as
      // the drawings (node_kind), and a sheet is a drawing row with parent_id.
      // Counting raw rows would inflate every KPI, so: a "drawing" is a
      // node_kind='drawing' (or null, for legacy rows) row with no parent.
      var draw   = rows.filter(function (r) { return (r.node_kind || 'drawing') === 'drawing' && !r.parent_id; });
      var sheets = rows.filter(function (r) { return (r.node_kind || 'drawing') === 'drawing' && !!r.parent_id; });

      var approved = 0, underReview = 0, forRevision = 0, notStarted = 0, cancelled = 0;
      draw.forEach(function (r) {
        var s = drStatus(r.status);
        if (drApproved(s)) approved++;
        if (s === 'Submitted' || s === 'Resubmit') underReview++;
        if (s === 'Resubmit') forRevision++;
        if (s === 'Not Started') notStarted++;
        if (s === 'Cancelled') cancelled++;
      });

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
    async selfTest(pid) {
      var d = await fetchAll('drawing_register', 'status', pid);
      var m = await fetchAll('material_submittal', 'status', pid);
      var unknownDR = {}, unknownMS = {};
      d.forEach(function (r) {
        var s = drStatus(r.status);
        if (DR_STATUSES.indexOf(s) === -1) unknownDR[s] = (unknownDR[s] || 0) + 1;
      });
      m.forEach(function (r) {
        var s = msStatus(r.status);
        if (MS_STATUSES.indexOf(s) === -1) unknownMS[s] = (unknownMS[s] || 0) + 1;
      });
      var out = { drawing_register: unknownDR, material_submittal: unknownMS };
      console.log('[EngData.selfTest] statuses this file does not recognise:', out);
      return out;
    },
  };

  window.EngData = EngData;
})();
