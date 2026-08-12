// ============================================================================
// Top sheets (TopSheet) — PMO controlled forms, rendered for print/PDF
// ----------------------------------------------------------------------------
//   F-GEN013 Rev 0   Material Submittal        (MAS)
//   F-GEN011 Rev 0   Request for Approval      (RFA)
//   F-GEN010 Rev 0   Request for Information   (RFI)
//
// ⚠️ THE BLANK F-GEN TEMPLATES ARE NOT THE FORM IN USE.
// The first build of this file was transcribed from the blank workbooks. Two
// real, issued documents (a TMS201 MAS and an SLT101 RFA) then showed the
// operative forms have moved on, and MAS/RFA are now built from those instead:
//
//   MAS  + Megawide logo above the sheet; + a PROJECT CODE row; "Attachment
//        included?" is a Yes/No CHECKBOX PAIR, not free text; and each review
//        block prints the FOUR review-status options as checkboxes.
//   RFA  the description area is a 3x4 CHECKBOX GRID of document types, not a
//        free-text box; the document table's last column is "Pages" (blank
//        template: "Copies"); the signature band is "Company" with THREE rows
//        (Prepared / Checked / Approved), not one plus a return date; and the
//        two review bands are titled "…REVIEW AND APPROVAL".
//
// RFI has no issued sample yet, so it still follows its blank template — with
// the Yes/No attachment checkboxes carried across, since both issued forms
// render that field that way. Flagged in the module CLAUDE.md.
//
// Column geometry is measured from the issued RFA's own rule lines: column A is
// 7.5% of the form width and columns B–I are 11.5625% each (the blank template
// implied 9 equal columns, which is visibly wrong against the real sheet).
//
// Usage:
//   TopSheet.open({ kind:'MAS', project:{id,name}, defaults:{...}, data:{...} })
//
// Every field stays editable before printing: the paper form is what the client
// signs, and the log rarely carries the reviewer's exact wording.
//
// Printing is the browser's own "Save as PDF" — no PDF library. The layout is
// already A4 in topsheet.css, so the print dialog produces the exact sheet and
// nothing has to be kept in sync with a second rendering engine.
// ============================================================================

window.TopSheet = (function () {
  'use strict';

  var esc = function (s) { return Fmt.esc(s == null ? '' : String(s)); };

  var FORMS = {
    MAS: { no: 'F-GEN013 Rev 0', title: 'MATERIAL SUBMITTAL (MAS)',      label: 'Material Submittal' },
    RFA: { no: 'F-GEN011 Rev 0', title: 'REQUEST FOR APPROVAL (RFA)',    label: 'Request for Approval' },
    RFI: { no: 'F-GEN010 Rev 0', title: 'REQUEST FOR INFORMATION (RFI)', label: 'Request for Information' }
  };

  var COPIES = '1 - Owner       2 - Consultant       3 - Megawide     4 - Others _____________';

  // The four options printed under "Submittal Review Status" on both issued
  // forms. Always printed unticked — the reviewer ticks one by hand, and the
  // log's own status is Megawide's record, not the consultant's decision.
  var REVIEW_STATUS = [
    'Approved',
    'Approved with comments / Approved as noted',
    'Not Approved - Revise / Resubmit',
    'Rejected'
  ];

  // RFA document-type checklist, transcribed from the issued RFA (3 columns x
  // 4 rows, read across).
  var RFA_TYPES = [
    ['Schedules', 'Method Statement / Methodology', 'Preliminary As-Built'],
    ['Plans / Programmes (Quality, etc.)', 'Inspection & Test Reports', 'As-Built Drawings'],
    ['Plans / Shop Drawings / Sketches', 'Performance Certification / Verification', 'Operation & Maintenance Manuals'],
    ['Diagrams', 'Mock-ups and Panels', 'Others (see Description)']
  ];

  var MNAME = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // Both issued forms date as dd-MMM-yy (13-Mar-26 / 31-Jul-26). Pure integer
  // maths on the ISO string — never local Date getters, which shift the day
  // east of Greenwich (the same trap the log's importer documents).
  function fmtDate(s) {
    if (!s) return '';
    var p = String(s).slice(0, 10).split('-');
    if (p.length !== 3 || isNaN(+p[0])) return String(s);
    return String(+p[2]).padStart(2, '0') + '-' + MNAME[+p[1] - 1] + '-' + String(p[0]).slice(2);
  }

  // A–I grid, measured from the issued RFA's rule lines.
  function colgroup() {
    var c = '<col style="width:7.5%">';
    for (var i = 0; i < 8; i++) c += '<col style="width:11.5625%">';
    return '<colgroup>' + c + '</colgroup>';
  }

  function td(o) {
    o = o || {};
    var a = '';
    if (o.cs) a += ' colspan="' + o.cs + '"';
    if (o.rs) a += ' rowspan="' + o.rs + '"';
    if (o.h) a += ' style="height:' + o.h + '"';
    return '<td class="' + (o.cls || '') + '"' + a + '>' + (o.v == null ? '' : o.v) + '</td>';
  }
  // Filled values print bold, so they read as entries on a blank controlled form.
  function val(v) { var s = esc(v); return s ? '<span class="ts-val">' + s + '</span>' : ''; }
  function pre(v) { var s = esc(v); return s ? '<div class="ts-pre ts-val">' + s + '</div>' : ''; }

  // An empty tick box + label. `on` ticks it; only ever used for the Yes/No
  // attachment pair, which the app does know the answer to.
  function box(label, on) {
    return '<span class="ts-cbx"><span class="ts-box' + (on ? ' ts-on' : '') + '"></span>' +
      (label ? '<span class="ts-cbl">' + esc(label) + '</span>' : '') + '</span>';
  }
  // The issued MAS stacks Yes/No vertically and title-cases them; the issued RFA
  // puts YES/NO side by side in caps. Both are reproduced rather than unified.
  function yesNo(v, opts) {
    opts = opts || {};
    var s = String(v == null ? '' : v).trim().toLowerCase();
    var yes = s === 'yes' || s === 'y' || s === 'true';
    var no  = s === 'no'  || s === 'n' || s === 'false';
    var Y = opts.caps ? 'YES' : 'Yes', N = opts.caps ? 'NO' : 'No';
    if (opts.pick) return box(opts.pick === 'yes' ? Y : N, opts.pick === 'yes' ? yes : no);
    return '<span class="ts-yn">' + box(Y, yes) + box(N, no) + '</span>';
  }
  function reviewStatusCell(cls) {
    var h = '<div class="ts-rs-hd">Submittal Review Status</div>';
    h += REVIEW_STATUS.map(function (s) { return '<div class="ts-rs">' + box(s, false) + '</div>'; }).join('');
    return td({ cs: 4, cls: cls, v: h });
  }

  function docOpen(kind, withLogo) {
    return '<div class="ts-doc" id="ts-doc">' +
      (withLogo ? '<div class="ts-logo"><img src="' + logoSrc() + '" alt="Megawide Construction"></div>' : '') +
      '<table class="ts-t">' + colgroup() + '<tbody>';
  }
  function docClose(kind) {
    // No form number is printed in the body: neither issued sheet carries one
    // (it lives in the file name). It stays on the dialog header instead.
    return '</tbody></table></div>';
  }
  // Module pages sit one level deeper than the shell, so the asset path differs.
  function logoSrc() {
    return (/\/modules\//.test(location.pathname) ? '../../' : '') + 'assets/img/logo-print.png';
  }
  function band(text) {
    return '<tr>' + td({ cs: 9, cls: 'ts-band bt br bb bl', v: esc(text) }) + '</tr>';
  }

  // ==========================================================================
  // MAS — F-GEN013, built from the issued TMS201 sheet.
  // ==========================================================================
  function renderMAS(d) {
    var h = docOpen('MAS', true);
    h += '<tr>' + td({ cs: 9, cls: 'ts-band ts-band-c bt br bl', v: esc(FORMS.MAS.title), h: '8mm' }) + '</tr>';
    // PROJECT NAME | Date
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-b ts-11 bt bb bl br', v: 'PROJECT NAME:' }) +
      td({ cs: 3, cls: 'ts-10 bt bb br', v: val(d.projectName), h: '9mm' }) +
      td({ cls: 'ts-b ts-11 bt br bb', v: 'Date:' }) +
      td({ cs: 3, cls: 'ts-10 ts-c bt br bb', v: val(fmtDate(d.date)) }) + '</tr>';
    // PROJECT CODE — present on the issued form, absent from the blank template.
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-b ts-11 bt bb bl br', v: 'PROJECT CODE:' }) +
      td({ cs: 7, cls: 'ts-10 bt br bb', v: val(d.projectCode) }) + '</tr>';
    // CLIENT
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-b ts-11 bt bb bl br', v: 'CLIENT:' }) +
      td({ cs: 7, cls: 'ts-10 bt br bb', v: val(d.client) }) + '</tr>';
    // shaded spacer
    h += '<tr>' + td({ cs: 9, cls: 'ts-band bt br bb bl', h: '3mm' }) + '</tr>';
    // MAS ID | Revision No. (each label with its own value box)
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-11 bt bl', v: 'MAS ID.:' }) +
      td({ cs: 3, cls: 'ts-10 bt br bb bl', v: val(d.masId) }) +
      td({ cs: 2, cls: 'ts-11 bt bb', v: 'Revision No.' }) +
      td({ cs: 2, cls: 'ts-10 ts-c bt br bb bl', v: val(d.revision) }) + '</tr>';
    // MAS Category | Attachment included? — label spans 2 rows, Yes/No stacked
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-11 bl', v: 'MAS Category:' }) +
      td({ cs: 3, cls: 'ts-10 br bb bl', v: val(d.category) }) +
      td({ cs: 2, rs: 2, cls: 'ts-11 bb', v: 'Attachment included?' }) +
      td({ cs: 2, cls: 'ts-10 br bl', v: yesNo(d.attachments, { pick: 'yes' }) }) + '</tr>';
    // MAS Sub-category
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-11 bl bb', v: 'MAS Sub-category' }) +
      td({ cs: 3, cls: 'ts-10 br bb bl', v: val(d.subCategory) }) +
      td({ cs: 2, cls: 'ts-10 br bb bl', v: yesNo(d.attachments, { pick: 'no' }) }) + '</tr>';
    h += band('Material Submittal Description');
    // description table header
    h += '<tr>' +
      td({ cs: 3, cls: 'ts-10 ts-c bt br bb bl', v: 'Product Name', h: '9mm' }) +
      td({ cs: 2, cls: 'ts-10 ts-c bt br bb bl', v: 'Manufacturer /<br>Supplier' }) +
      td({ cs: 2, cls: 'ts-10 ts-c bt br bb bl', v: 'Specification / BOQ<br>Ref.' }) +
      td({ cs: 2, cls: 'ts-10 ts-c bt br bb', v: 'Location / Use' }) + '</tr>';
    // description body
    h += '<tr>' +
      td({ cs: 3, cls: 'ts-10 bt br bb bl', v: pre(d.productName), h: '62mm' }) +
      td({ cs: 2, cls: 'ts-10 ts-c bt br bb bl ts-mid', v: pre(d.manufacturer) }) +
      td({ cs: 2, cls: 'ts-10 bt br bb bl ts-mid', v: pre(d.specRef) }) +
      td({ cs: 2, cls: 'ts-10 ts-c bt br bb ts-mid', v: pre(d.location) }) + '</tr>';
    h += band('MEGAWIDE CONSTRUCTION CORPORATION');
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 bt br bl', v: 'Submitted by:' }) +
      td({ cs: 4, cls: 'ts-10 ts-c bt br', v: 'Responded by Client' }) + '</tr>';
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 ts-c br bb bl ts-bot', v: val(d.submittedBy) +
        (d.submittedByTitle ? '<div class="ts-sub">' + esc(d.submittedByTitle) + '</div>' : ''), h: '20mm' }) +
      td({ cs: 4, cls: 'ts-10 ts-c br bb' }) + '</tr>';
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 ts-c bt br bb bl', v: 'Name / Signature / Date' }) +
      td({ cs: 4, cls: 'ts-10 ts-c bt br bb', v: 'Name / Signature / Date' }) + '</tr>';
    h += band("PROJECT MANAGEMENT / CONSULTANT'S REVIEW AND APPROVAL");
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 bt br bl', v: 'For and on behalf of Client / Owner<div>Comments:</div>', h: '30mm' }) +
      reviewStatusCell('ts-10 bt br') + '</tr>';
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 ts-c bt br bb bl', v: 'Name / Signature / Date' }) +
      td({ cs: 4, cls: 'ts-10 br bb' }) + '</tr>';
    h += band("CLIENT / OWNERS' REVIEW AND APPROVAL");
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 bt br bl', v: 'For and on behalf of Client / Owner<div>Comments:</div>', h: '30mm' }) +
      reviewStatusCell('ts-10 bt br') + '</tr>';
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 ts-c bt br bb bl', v: 'Name / Signature / Date' }) +
      td({ cs: 4, cls: 'ts-10 br bb' }) + '</tr>';
    h += '<tr>' +
      td({ cls: 'ts-9 bt bb bl', v: 'Copies:' }) +
      td({ cs: 8, cls: 'ts-9 bt br bb ts-pre-sp', v: COPIES }) + '</tr>';
    return h + docClose('MAS');
  }

  // ==========================================================================
  // RFA — F-GEN011, built from the issued SLT101 sheet.
  // ==========================================================================
  function renderRFA(d) {
    var h = docOpen('RFA', false);
    h += '<tr>' + td({ cs: 9, cls: 'ts-band ts-band-c bt br bl', v: esc(FORMS.RFA.title), h: '8mm' }) + '</tr>';
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-b ts-10 bt bb bl br', v: 'PROJECT NAME:' }) +
      td({ cs: 7, cls: 'ts-10 bt br bb', v: val(d.projectName) }) + '</tr>';
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-b ts-10 bt bb bl br', v: 'CLIENT:' }) +
      td({ cs: 7, cls: 'ts-10 bt br bb', v: val(d.client) }) + '</tr>';
    // TO (2 lines) | RFA Date
    h += '<tr>' +
      td({ rs: 2, cls: 'ts-10 bt bb bl br', v: 'TO:' }) +
      td({ cs: 3, cls: 'ts-10 bt br bl', v: val(d.to) }) +
      td({ cs: 2, rs: 2, cls: 'ts-10 bt br bb', v: 'RFA Date:' }) +
      td({ cs: 3, rs: 2, cls: 'ts-10 ts-c bt br bb', v: val(fmtDate(d.date)) }) + '</tr>';
    h += '<tr>' + td({ cs: 3, cls: 'ts-10 br bb bl', v: val(d.toCompany) }) + '</tr>';
    // FROM (2 lines) | Date Required
    h += '<tr>' +
      td({ rs: 2, cls: 'ts-10 bt bb bl br', v: 'FROM:' }) +
      td({ cs: 3, cls: 'ts-10 bt br bl', v: val(d.from) }) +
      td({ cs: 2, rs: 2, cls: 'ts-10 bt br bb', v: 'Date Required:' }) +
      td({ cs: 3, rs: 2, cls: 'ts-10 ts-c bt br bb', v: val(fmtDate(d.dateRequired)) }) + '</tr>';
    h += '<tr>' + td({ cs: 3, cls: 'ts-10 br bb bl', v: val(d.fromCompany) }) + '</tr>';
    h += '<tr>' + td({ cs: 9, cls: 'ts-band bt br bb bl', h: '2mm' }) + '</tr>';
    // RFA ID | Attachments included?
    // Widths follow the issued sheet's rules: the ID value runs from the end of
    // column A to column E, which is what keeps a full document code on one line.
    h += '<tr>' +
      td({ cls: 'ts-10 bt bl', v: 'RFA ID:' }) +
      td({ cs: 4, cls: 'ts-10 bt', v: val(d.rfaId) }) +
      td({ cs: 2, cls: 'ts-10 bt', v: 'Attachments included?' }) +
      td({ cs: 2, cls: 'ts-10 bt br', v: yesNo(d.attachments, { caps: true }) }) + '</tr>';
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-10 bl', v: 'RFA Category:' }) +
      td({ cs: 7, cls: 'ts-10 br', v: val(d.category) }) + '</tr>';
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-10 bl bb', v: 'RFA Sub-category:' }) +
      td({ cs: 7, cls: 'ts-10 br bb', v: val(d.subCategory) }) + '</tr>';
    h += band('RFA DESCRIPTION');
    h += '<tr>' + td({ cs: 9, cls: 'ts-8 br bl',
      v: 'Note: This form should not be used for Material Submittal. A Material Submittal form is available separately.' }) + '</tr>';
    // 3x4 document-type checklist
    var ticked = {};
    (d.types || []).forEach(function (t) { ticked[t] = 1; });
    RFA_TYPES.forEach(function (row) {
      h += '<tr>' +
        td({ cs: 3, cls: 'ts-8 bl', v: box(row[0], !!ticked[row[0]]) }) +
        td({ cs: 3, cls: 'ts-8', v: box(row[1], !!ticked[row[1]]) }) +
        td({ cs: 3, cls: 'ts-8 br', v: box(row[2], !!ticked[row[2]]) }) + '</tr>';
    });
    // document table — the issued form's last column is Pages, not Copies
    h += '<tr>' +
      td({ cs: 3, cls: 'ts-9 ts-c bt br bb bl', v: 'Document No.' }) +
      td({ cs: 2, cls: 'ts-9 ts-c bt br bb bl', v: 'Rev.' }) +
      td({ cs: 3, cls: 'ts-9 ts-c bt br bb bl', v: 'Description' }) +
      td({ cls: 'ts-9 ts-c bt br bb bl', v: 'Pages' }) + '</tr>';
    var docs = d.documents || [];
    for (var i = 0; i < 4; i++) {
      var r = docs[i] || {};
      h += '<tr>' +
        td({ cs: 3, cls: 'ts-9 ts-c br bb bl', v: val(r.no), h: '7mm' }) +
        td({ cs: 2, cls: 'ts-9 ts-c br bb bl', v: val(r.rev) }) +
        td({ cs: 3, cls: 'ts-9 ts-c br bb bl', v: val(r.description) }) +
        td({ cls: 'ts-9 ts-c br bb bl', v: val(r.pages) }) + '</tr>';
    }
    h += band('Company');
    // three signature rows
    [['Prepared and submitted by:', d.preparedBy], ['Checked by:', d.checkedBy], ['Approved by:', d.approvedBy]]
      .forEach(function (p) {
        h += '<tr>' +
          td({ cs: 2, cls: 'ts-10 bl bb', v: p[0], h: '10mm' }) +
          td({ cs: 3, cls: 'ts-10 ts-c bb', v: val(p[1]) }) +
          td({ cls: 'ts-10 bb', v: 'Sign:' }) +
          td({ cs: 2, cls: 'ts-10 bb' }) +
          td({ cls: 'ts-10 br bb', v: 'Date:' }) + '</tr>';
      });
    h += band("CONSULTANT'S REVIEW AND APPROVAL");
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 bt br bl', v: 'For and on behalf of Client / Owner<div>Comments:</div>', h: '26mm' }) +
      reviewStatusCell('ts-10 bt br') + '</tr>';
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 ts-c bt br bb bl', v: 'Name / Signature / Date' }) +
      td({ cs: 4, cls: 'ts-10 br bb' }) + '</tr>';
    h += band("CLIENT / OWNERS' REVIEW AND APPROVAL");
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 bt br bl', v: 'For and on behalf of Client / Owner<div>Comments:</div>', h: '26mm' }) +
      reviewStatusCell('ts-10 bt br') + '</tr>';
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 ts-c bt br bb bl', v: 'Name / Signature / Date' }) +
      td({ cs: 4, cls: 'ts-10 br bb' }) + '</tr>';
    h += '<tr>' +
      td({ cls: 'ts-9 bt bb bl', v: 'Copies:' }) +
      td({ cs: 8, cls: 'ts-9 bt br bb ts-pre-sp', v: COPIES }) + '</tr>';
    return h + docClose('RFA');
  }

  // ==========================================================================
  // RFI — F-GEN010. Still from the blank template (no issued sample yet); the
  // Yes/No attachment boxes are carried across from the two issued forms.
  // ==========================================================================
  function renderRFI(d) {
    var h = docOpen('RFI', false);
    h += '<tr>' + td({ cs: 9, cls: 'ts-band ts-band-c bt br bl', v: esc(FORMS.RFI.title), h: '10mm' }) + '</tr>';
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-b ts-10 bt br bb bl', v: 'PROJECT NAME:' }) +
      td({ cs: 7, cls: 'ts-10 bt br bb', v: val(d.projectName) }) + '</tr>';
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-b ts-10 bt br bb bl', v: 'CLIENT:' }) +
      td({ cs: 7, cls: 'ts-10 bt br bb', v: val(d.client) }) + '</tr>';
    h += '<tr>' +
      td({ rs: 2, cls: 'ts-10 bt br bb bl', v: 'TO:' }) +
      td({ cs: 3, cls: 'ts-10 bt br bl', v: d.to ? val(d.to) : 'Name &amp; Position' }) +
      td({ cs: 2, rs: 2, cls: 'ts-10 bt br bb', v: 'RFI Date:' }) +
      td({ cs: 3, rs: 2, cls: 'ts-10 ts-c bt br bb', v: val(fmtDate(d.date)) }) + '</tr>';
    h += '<tr>' + td({ cs: 3, cls: 'ts-10 br bb bl', v: d.toCompany ? val(d.toCompany) : 'Company' }) + '</tr>';
    h += '<tr>' +
      td({ rs: 2, cls: 'ts-10 bt br bb bl', v: 'FROM:' }) +
      td({ cs: 3, cls: 'ts-10 bt br bl', v: d.from ? val(d.from) : 'Name &amp; Position' }) +
      td({ cs: 2, rs: 2, cls: 'ts-10 bt br bb', v: 'Date Required:' }) +
      td({ cs: 3, rs: 2, cls: 'ts-10 ts-c bt br bb', v: val(fmtDate(d.dateRequired)) }) + '</tr>';
    h += '<tr>' + td({ cs: 3, cls: 'ts-10 br bb bl', v: val(d.fromCompany) }) + '</tr>';
    h += '<tr>' + td({ cs: 9, cls: 'ts-band bt br bb bl', h: '2mm' }) + '</tr>';
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-10 bt bl', v: 'RFI ID:' }) +
      td({ cs: 2, cls: 'ts-10 bt', v: val(d.rfiId) }) +
      td({ cs: 2, cls: 'ts-10 bt', v: 'Attachments included?' }) +
      td({ cs: 3, cls: 'ts-10 bt br', v: yesNo(d.attachments, { caps: true }) }) + '</tr>';
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-10 bl', v: 'RFI Category:' }) +
      td({ cs: 7, cls: 'ts-10 br', v: val(d.category) }) + '</tr>';
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-10 bl bb', v: 'RFI Sub-category:' }) +
      td({ cs: 7, cls: 'ts-10 br bb', v: val(d.subCategory) }) + '</tr>';
    h += band('RFI DESCRIPTION');
    h += '<tr>' + td({ cs: 9, cls: 'ts-10 bt br bl', v: pre(d.description), h: '34mm' }) + '</tr>';
    h += '<tr>' + td({ cs: 9, cls: 'ts-10 br bl', v: 'For and on behalf of MEGAWIDE CONSTRUCTION CORPORATION' }) + '</tr>';
    h += signRow(val(d.from));
    h += band("DESIGN CONSULTANT'S RESPONSE");
    h += '<tr>' + td({ cs: 9, cls: 'ts-10 bt br bl', h: '34mm' }) + '</tr>';
    h += '<tr>' + td({ cs: 9, cls: 'ts-10 br bl',
      v: 'For and on behalf of ' + (d.consultant ? val(d.consultant) : '[Engineer]') }) + '</tr>';
    h += signRow('');
    h += band("PROJECT MANAGEMENT / CLIENT'S APPROVAL");
    h += '<tr>' + td({ cs: 9, cls: 'ts-10 bt br bl', h: '34mm' }) + '</tr>';
    h += '<tr>' + td({ cs: 9, cls: 'ts-10 br bl', v: 'For and on behalf of [Project Management / Client]' }) + '</tr>';
    h += signRow('', true);
    h += '<tr>' + td({ cs: 9, cls: 'ts-8 bt br bb bl',
      v: 'Note: In case that a change in the Contract Amount or Contract Time is required, notify Project Manager within 48 hours from your receipt of the above response and prior to your proceeding with affected work.' }) + '</tr>';
    h += '<tr>' +
      td({ cls: 'ts-9 bt bb bl', v: 'Copies:' }) +
      td({ cs: 8, cls: 'ts-9 bt br bb ts-pre-sp', v: COPIES }) + '</tr>';
    return h + docClose('RFI');
  }
  // RFI's repeated Name / Sign / Date strip.
  function signRow(name, last) {
    var b = last ? ' bb' : '';
    return '<tr>' +
      td({ cls: 'ts-10 bb bl', v: 'Name:', h: '10mm' }) +
      td({ cs: 3, cls: 'ts-10 bb', v: name }) +
      td({ cls: 'ts-10 bb', v: 'Sign:' }) +
      td({ cs: 2, cls: 'ts-10 bb' }) +
      td({ cls: 'ts-10 bb', v: 'Date:' }) +
      td({ cls: 'ts-10 br' + b }) + '</tr>';
  }

  var RENDER = { MAS: renderMAS, RFA: renderRFA, RFI: renderRFI };
  function render(kind, data) { return RENDER[kind](data || {}); }

  // ==========================================================================
  // Fill-in dialog. Each form asks only for what its own sheet prints.
  // ==========================================================================
  var FIELDS = {
    MAS: [
      ['projectCode', 'Project code'], ['masId', 'MAS ID'], ['revision', 'Revision No.'],
      ['date', 'Date', 'date'], ['category', 'MAS Category'], ['subCategory', 'MAS Sub-category'],
      ['attachments', 'Attachment included?', 'yesno'],
      ['productName', 'Product Name', 'area'], ['manufacturer', 'Manufacturer / Supplier', 'area'],
      ['specRef', 'Specification / BOQ Ref.', 'area'], ['location', 'Location / Use', 'area'],
      ['submittedBy', 'Submitted by'], ['submittedByTitle', 'Submitted by — position']
    ],
    RFA: [
      ['rfaId', 'RFA ID'], ['date', 'RFA Date', 'date'], ['dateRequired', 'Date Required', 'date'],
      ['to', 'TO — name & position'], ['toCompany', 'TO — company'],
      ['from', 'FROM — name & position'], ['fromCompany', 'FROM — company'],
      ['category', 'RFA Category'], ['subCategory', 'RFA Sub-category'],
      ['attachments', 'Attachments included?', 'yesno'],
      ['types', 'Document types', 'types'],
      ['preparedBy', 'Prepared and submitted by'], ['checkedBy', 'Checked by'], ['approvedBy', 'Approved by']
    ],
    RFI: [
      ['rfiId', 'RFI ID'], ['date', 'RFI Date', 'date'], ['dateRequired', 'Date Required', 'date'],
      ['to', 'TO — name & position'], ['toCompany', 'TO — company'],
      ['from', 'FROM — name & position'], ['fromCompany', 'FROM — company'],
      ['category', 'RFI Category'], ['subCategory', 'RFI Sub-category'],
      ['attachments', 'Attachments included?', 'yesno'],
      ['description', 'RFI Description', 'area'], ['consultant', 'Design Consultant (Engineer)']
    ]
  };

  function open(opts) {
    opts = opts || {};
    var kind = opts.kind || 'MAS';
    var data = Object.assign({}, opts.data || {});
    data.projectName = data.projectName || (opts.project && (opts.project.name || opts.project.id)) || '';
    data.projectCode = data.projectCode || (opts.project && opts.project.id) || '';
    data.client = data.client || (opts.defaults && opts.defaults.client_name) || '';
    if (!data.types) data.types = [];

    var form = FIELDS[kind].map(function (f) {
      var key = f[0], label = f[1], type = f[2] || 'text';
      var v = data[key] == null ? '' : data[key];
      var input;
      if (type === 'area') {
        input = '<textarea class="pd-input ts-f" data-k="' + key + '" rows="2">' + esc(v) + '</textarea>';
      } else if (type === 'yesno') {
        input = '<select class="pd-select ts-f" data-k="' + key + '">' +
          ['', 'Yes', 'No'].map(function (o) {
            return '<option value="' + esc(o) + '"' + (String(v) === o ? ' selected' : '') + '>' + (o || '—') + '</option>';
          }).join('') + '</select>';
      } else if (type === 'types') {
        var flat = []; RFA_TYPES.forEach(function (r) { flat = flat.concat(r); });
        input = '<div class="ts-typegrid">' + flat.map(function (t) {
          return '<label><input type="checkbox" class="ts-ft" value="' + esc(t) + '"' +
            (data.types.indexOf(t) !== -1 ? ' checked' : '') + ' /> ' + esc(t) + '</label>';
        }).join('') + '</div>';
      } else {
        input = '<input class="pd-input ts-f" data-k="' + key + '" type="' +
          (type === 'date' ? 'date' : 'text') + '" value="' + esc(v) + '" />';
      }
      return '<label class="ts-fld"><span>' + esc(label) + '</span>' + input + '</label>';
    }).join('');

    var m = UI.modal(
      '<div class="pd-modal-header"><h2 style="margin:0;">' + esc(FORMS[kind].label) + ' top sheet</h2>' +
        '<button class="pd-btn" id="ts-x" title="Close">&times;</button></div>' +
      '<div class="ts-wrap">' +
        '<div class="ts-side ts-noprint">' +
          '<div class="ts-side-hd">' + esc(FORMS[kind].no) + '</div>' +
          '<label class="ts-fld"><span>Project</span><input class="pd-input" value="' + esc(data.projectName) + '" disabled /></label>' +
          '<label class="ts-fld"><span>Client</span><input class="pd-input ts-f" data-k="client" value="' + esc(data.client) + '" /></label>' +
          form +
        '</div>' +
        '<div class="ts-prev" id="ts-prev">' + render(kind, data) + '</div>' +
      '</div>' +
      '<div class="pd-modal-actions ts-noprint">' +
        '<button class="pd-btn" id="ts-cancel">Cancel</button>' +
        '<button class="pd-btn pd-btn-primary" id="ts-print">Print / Save as PDF</button>' +
      '</div>', { noBackdropClose: true });

    var prev = m.el.querySelector('#ts-prev');
    function repaint() { prev.innerHTML = render(kind, data); }

    m.el.querySelectorAll('.ts-f').forEach(function (el) {
      var ev = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, function () { data[el.dataset.k] = el.value; repaint(); });
    });
    m.el.querySelectorAll('.ts-ft').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var i = data.types.indexOf(cb.value);
        if (cb.checked && i === -1) data.types.push(cb.value);
        else if (!cb.checked && i !== -1) data.types.splice(i, 1);
        repaint();
      });
    });
    m.el.querySelector('#ts-x').onclick = m.close;
    m.el.querySelector('#ts-cancel').onclick = m.close;
    m.el.querySelector('#ts-print').onclick = function () {
      // Gated on this class so the "hide everything except .ts-doc" print rule
      // can never affect an ordinary Ctrl+P of the page behind the modal.
      document.body.classList.add('ts-printing');
      var done = function () { document.body.classList.remove('ts-printing'); };
      window.addEventListener('afterprint', done, { once: true });
      setTimeout(function () { window.print(); }, 60);
      setTimeout(done, 4000);   // Safari/older Chrome do not always fire afterprint
    };
    return m;
  }

  // ---- per-project defaults (migration 0012) -------------------------------
  async function loadDefaults(projectId) {
    if (!projectId || !window.__sb) return {};
    try {
      var res = await window.__sb.from('topsheet_defaults')
        .select('*').eq('project_id', projectId).maybeSingle();
      return (res && res.data) || {};
    } catch (e) { return {}; }
  }

  return {
    open: open, render: render, loadDefaults: loadDefaults, FORMS: FORMS,
    _internals: { FIELDS: FIELDS, RFA_TYPES: RFA_TYPES, REVIEW_STATUS: REVIEW_STATUS, fmtDate: fmtDate }
  };
})();
