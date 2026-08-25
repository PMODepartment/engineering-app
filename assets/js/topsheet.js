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
// TWO OUTPUTS, and the difference between them matters:
//   Print     the browser's own dialog. Pixel-exact, no library, best for paper.
//             Gives the app NO file — it writes wherever the user chooses and
//             tells this code nothing.
//   Download  a PDF Blob built here (html2pdf), with any PDF attachment merged
//             underneath by pdf-lib, so the sheet sits on top of the document it
//             covers. This is the thing the user asked for.
//
// ⚠️ Printing and the PDF are TWO RENDERERS OF ONE LAYOUT, not two layouts. Both
// consume the same `render(kind, data)` markup and the same topsheet.css, which
// states the sheet in millimetres. Never fork the markup for one of them.
// ⚠️ THERE IS DELIBERATELY NO "EMAIL" BUTTON. Sending from inside the app was built
// (a Microsoft Graph Edge Function, `supabase/functions/send-mail`) and then dropped on
// the owner's call: issuing a top sheet is ordinary correspondence, and people already
// do that from Outlook — where they have their signature, their distribution lists and
// a Sent Items they trust. Downloading the PDF and attaching it is fewer moving parts
// and no tenant-wide send permission to govern. `sendMail`/`openCompose` remain in this
// file and the function remains deployed but UNREFERENCED, so re-wiring is adding the
// button back rather than rebuilding. Do not re-add it without asking.
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
  // A signature caption with the signatory's name printed above it, when one was
  // given. ⚠️ THE NAME IS OPTIONAL AND THE CAPTION IS NOT. Signatories change — the
  // consultant's reviewer this month is not next month's — so the app cannot know them
  // and must not invent them. Typing one prints it; leaving it blank prints the bare
  // caption exactly as the issued form does, for signing by hand.
  function signCap(name) {
    var n = esc(name || '');
    return (n ? '<div class="ts-val ts-signname">' + n + '</div>' : '') +
      '<div>Name / Signature / Date</div>';
  }
  // "For and on behalf of X". Falls back to the issued form's own wording rather than
  // printing an empty behalf-of line.
  function behalf(v, fallback) {
    return 'For and on behalf of ' + (v ? esc(v) : (fallback || 'Client / Owner'));
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
      // ⚠️ 46mm. Twice now this box has been the place the MAS sheet's overflow was
      // paid from, because it is the only cell on the form that is deliberately empty
      // space AND sizes its own row (the review blocks below do not — their height comes
      // from the four-line review-status column beside them, so trimming those is a
      // no-op, measured).
      //   62 -> 54mm: the sheet rendered 304.69mm against A4's 297 and paged onto a
      //               near-blank second sheet — true of the Print path all along.
      //   54 -> 46mm: printing an optional signatory name above each of the two
      //               "Name / Signature / Date" captions adds ~3.2mm apiece, taking it
      //               to 303.36mm. Signatories change and must be typeable, so the
      //               space comes from here.
      // 46mm still leaves far more room than the four short fields beside it need.
      // ⚠️ ORIGINAL NOTE, still true — Measured: at 62mm the sheet
      // rendered 304.69mm tall against A4's 297mm, so it overflowed by 7.69mm and paged
      // onto a near-blank second sheet. That was true of the Print path all along; it only
      // became obvious once the PDF export made the page count checkable (RFA and RFI both
      // measure exactly 297mm and were never affected — this is a MAS-only overflow, so
      // the fix belongs here and not in `.ts-doc`'s shared padding).
      // The 8mm comes out of this free-text box rather than any labelled row or signature
      // band: it is the one block on the form that is deliberately empty space, and 54mm
      // still leaves far more room than the four fields beside it need.
      td({ cs: 3, cls: 'ts-10 bt br bb bl', v: pre(d.productName), h: '46mm' }) +
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
      td({ cs: 4, cls: 'ts-10 ts-c br bb ts-bot', v: val(d.respondedBy) +
        (d.respondedByTitle ? '<div class="ts-sub">' + esc(d.respondedByTitle) + '</div>' : '') }) + '</tr>';
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 ts-c bt br bb bl', v: 'Name / Signature / Date' }) +
      td({ cs: 4, cls: 'ts-10 ts-c bt br bb', v: 'Name / Signature / Date' }) + '</tr>';
    h += band("PROJECT MANAGEMENT / CONSULTANT'S REVIEW AND APPROVAL");
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 bt br bl',
           // ⚠️ The height here is NOT what sizes this row — the review-status column
           // beside it (a heading plus four checkbox lines) is taller and wins. Trimming
           // this value to claw back space does nothing; measured, 30mm and 26mm give an
           // identical sheet. Take space from the product box above instead.
           v: behalf(d.consultantName) + '<div>Comments:</div>' + pre(d.consultantComments), h: '30mm' }) +
      reviewStatusCell('ts-10 bt br') + '</tr>';
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 ts-c bt br bb bl', v: signCap(d.consultantSignatory) }) +
      td({ cs: 4, cls: 'ts-10 br bb' }) + '</tr>';
    h += band("CLIENT / OWNERS' REVIEW AND APPROVAL");
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 bt br bl',
           v: behalf(d.clientName || d.client) + '<div>Comments:</div>' + pre(d.clientComments), h: '30mm' }) +
      reviewStatusCell('ts-10 bt br') + '</tr>';
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 ts-c bt br bb bl', v: signCap(d.clientSignatory) }) +
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
      // ⚠️ ts-nowrap: column A is 7.5% of the sheet (≈16mm, measured from the issued
      // form) and "RFA ID:" wrapped to two lines in it, which both looked wrong and cost
      // ~4mm of a sheet that has none to spare. Kept as a nowrap rather than widening the
      // column, because the column widths were measured off the real form.
      td({ cls: 'ts-10 bt bl ts-nowrap', v: 'RFA ID:' }) +
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
    // ⚠️ TWO REAL BUGS WERE FIXED HERE, both found once a register started supplying
    // this table (before that nothing populated `documents`, so neither was reachable):
    //
    //  1. IT READ `r.no`, AND EVERY PRODUCER WRITES `doc_no`. So the document table
    //     printed BLANK — on a controlled transmittal form whose whole purpose is to
    //     list what is being sent for approval. `r.no` is still accepted as a fallback
    //     so any caller written against the old shape keeps working.
    //  2. IT RENDERED EXACTLY 4 ROWS AND SILENTLY DROPPED THE REST. An RFA that
    //     transmits eight drawings would have printed four of them and lost four, with
    //     nothing on the sheet saying so. It now prints EVERY document, padding to four
    //     so a blank form still looks like the issued one. More than four grows the
    //     sheet past A4 and it paginates — which is correct: a second page is far
    //     better than a document that was never listed.
    // ⚠️ PAD TO FOUR ROWS ONLY WHILE THERE IS ROOM FOR IT. The issued blank form has
    // four document rows, so a sheet carrying nothing (or one or two documents) still
    // looks like the form people know. But each blank row costs 8.3mm on a sheet with
    // barely any slack, and a REAL RFA measured 299.07mm against A4's 297 — tipping a
    // perfectly ordinary transmittal onto a second page. Once there are three or more
    // real documents the padding has done its job and the space is better spent fitting
    // on one page.
    var nRows = docs.length >= 3 ? docs.length : 4;
    for (var i = 0; i < nRows; i++) {
      var r = docs[i] || {};
      h += '<tr>' +
        td({ cs: 3, cls: 'ts-9 ts-c br bb bl', v: val(r.doc_no != null ? r.doc_no : r.no), h: '7mm' }) +
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
      td({ cs: 5, cls: 'ts-10 bt br bl',
           v: behalf(d.consultantName) + '<div>Comments:</div>' + pre(d.consultantComments), h: '26mm' }) +
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
      // ⚠️ `[Engineer]` is the blank form's PLACEHOLDER, not a value. Typing the
      // consultant replaces it; leaving it blank keeps the bracketed placeholder, which
      // is what the issued blank form shows.
      v: 'For and on behalf of ' + (d.consultant ? val(d.consultant) : '[Engineer]') }) + '</tr>';
    h += signRow(val(d.consultantSignatory));
    h += band("PROJECT MANAGEMENT / CLIENT'S APPROVAL");
    h += '<tr>' + td({ cs: 9, cls: 'ts-10 bt br bl', h: '34mm' }) + '</tr>';
    h += '<tr>' + td({ cs: 9, cls: 'ts-10 br bl',
      v: 'For and on behalf of ' + (d.clientName ? val(d.clientName)
        : (d.client ? val(d.client) : '[Project Management / Client]')) }) + '</tr>';
    h += signRow(val(d.clientSignatory), true);
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
      ['submittedBy', 'Submitted by'], ['submittedByTitle', 'Submitted by — position'],
      // ⚠️ SIGNATORY BLOCK — everything the app cannot know. Reviewers and their
      // companies change between submittals, so these are typed, never derived, and every
      // one is OPTIONAL: left blank the sheet prints the issued form's own wording and a
      // bare signature line to be completed by hand.
      ['respondedBy', 'Responded by (client) — name'],
      ['respondedByTitle', 'Responded by — position'],
      ['consultantName', 'Consultant / PM — company on the review block'],
      ['consultantSignatory', 'Consultant / PM — signatory name'],
      ['consultantComments', "Consultant / PM — comments", 'area'],
      ['clientName', 'Client / owner — company on the review block'],
      ['clientSignatory', 'Client / owner — signatory name'],
      ['clientComments', 'Client / owner — comments', 'area']
    ],
    RFA: [
      ['rfaId', 'RFA ID'], ['date', 'RFA Date', 'date'], ['dateRequired', 'Date Required', 'date'],
      ['to', 'TO — name & position'], ['toCompany', 'TO — company'],
      ['from', 'FROM — name & position'], ['fromCompany', 'FROM — company'],
      ['category', 'RFA Category'], ['subCategory', 'RFA Sub-category'],
      ['attachments', 'Attachments included?', 'yesno'],
      ['types', 'Document types', 'types'],
      ['preparedBy', 'Prepared and submitted by'], ['checkedBy', 'Checked by'], ['approvedBy', 'Approved by'],
      // See the note on the MAS block — same reasoning, same optionality.
      ['consultantName', 'Consultant — company on the review block'],
      ['consultantSignatory', 'Consultant — signatory name'],
      ['consultantComments', 'Consultant — comments', 'area'],
      ['clientName', 'Client / owner — company on the review block'],
      ['clientSignatory', 'Client / owner — signatory name'],
      ['clientComments', 'Client / owner — comments', 'area']
    ],
    RFI: [
      ['rfiId', 'RFI ID'], ['date', 'RFI Date', 'date'], ['dateRequired', 'Date Required', 'date'],
      ['to', 'TO — name & position'], ['toCompany', 'TO — company'],
      ['from', 'FROM — name & position'], ['fromCompany', 'FROM — company'],
      ['category', 'RFI Category'], ['subCategory', 'RFI Sub-category'],
      ['attachments', 'Attachments included?', 'yesno'],
      ['description', 'RFI Description', 'area'],
      ['consultant', 'Design Consultant (Engineer)'],
      ['consultantSignatory', 'Design Consultant — signatory name'],
      ['clientName', 'Project Management / Client — company'],
      ['clientSignatory', 'Project Management / Client — signatory name']
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

    // Attachments the caller has offered to place UNDER the sheet. Named on the dialog
    // before anything is generated, and the note says plainly which will be merged and
    // which cannot be — an .xlsx cannot become pages in a browser, and finding that out
    // only after downloading is worse than being told up front.
    var atts = (opts.attachments || []).filter(Boolean);
    var nAtt = atts.length;
    var nMergeable = atts.filter(function (a) { return isPdf(a.name, a.type); }).length;
    var attNote = '';
    if (nAtt) {
      attNote = nMergeable === nAtt
        ? (nAtt === 1 ? 'The attached document will be placed under this sheet.'
                      : 'All ' + nAtt + ' attached documents will be placed under this sheet.')
        : (nMergeable
            ? nMergeable + ' of ' + nAtt + ' documents merge under the sheet; the rest download separately (only PDFs can be merged).'
            : 'The attached document is not a PDF, so it downloads separately rather than under the sheet.');
    }
    // ⚠️ Caller-supplied warnings, rendered as trusted HTML because the callers are
    // this app's own modules composing an emphasised sentence — never user content.
    // They show even when there is nothing attached at all, which is exactly the case
    // the RFA register needs: "these drawings have no file to send".
    var notes = (opts.notes || []).filter(Boolean);
    if (notes.length) attNote += (attNote ? ' ' : '') + notes.join(' ');
    var nAttShown = nAtt || notes.length;   // the note row must appear for notes alone

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
        (nAttShown ? '<span class="ts-attnote" id="ts-attnote">' + attNote + '</span>' : '') +
        '<button class="pd-btn" id="ts-print">Print</button>' +
        '<button class="pd-btn pd-btn-primary" id="ts-pdf">' +
          (nAtt ? 'Download PDF + document' : 'Download PDF') + '</button>' +
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

    var pdfBtn = m.el.querySelector('#ts-pdf');
    pdfBtn.onclick = async function () {
      var orig = pdfBtn.textContent;
      pdfBtn.disabled = true; pdfBtn.textContent = 'Generating…';
      try {
        var pkg = await buildPackage(kind, data, atts, packageName(kind, data));
        saveBlob(pkg.file.name, pkg.file.blob);
        // Non-PDF attachments are saved alongside, each as itself. Named in the toast so
        // nobody has to guess whether the document made it out.
        pkg.separate.forEach(function (s) { saveBlob(s.name, s.blob); });
        var msg = pkg.merged
          ? 'Top sheet downloaded with ' + pkg.merged + ' document' + (pkg.merged > 1 ? 's' : '') + ' merged under it'
          : 'Top sheet downloaded';
        if (pkg.separate.length) msg += ' · ' + pkg.separate.length + ' sent as a separate file';
        // A document that was supposed to be under the sheet and is not MUST be said out
        // loud — a top sheet with a missing attachment looks complete.
        if (pkg.skipped.length) {
          UI.toast('Could not read: ' + pkg.skipped.join(', ') + ' — the sheet downloaded without it.', 'warn');
        } else {
          UI.toast(msg, 'ok');
        }
      } catch (e) {
        UI.toast('PDF error: ' + ((e && e.message) || e), 'error');
      } finally {
        pdfBtn.disabled = false; pdfBtn.textContent = orig;
      }
    };

    return m;
  }

  // ==========================================================================
  // PDF OUTPUT — a real file, so the sheet can be merged and emailed
  // --------------------------------------------------------------------------
  // Printing (window.print) is still here and is still the best route to paper. But
  // "generate and email the top sheet with the document under it" needs a FILE, and the
  // browser's print dialog does not give you one — it writes wherever the user chooses
  // and tells the page nothing. So there are two outputs now, deliberately:
  //   Print          → paper / the browser's own Save-as-PDF, pixel-exact, no library
  //   Download / Email → a Blob built here, which can be merged and attached
  //
  // Rasterised via html2canvas, the same engine the Planners Dashboard's Minutes-of-
  // Meeting export uses (`momDownloadPDF`), and its two hard-won rules are reproduced
  // below because they are not guessable. The sheet is a form someone signs, so losing
  // selectable text costs nothing; the geometry is what matters and topsheet.css already
  // states it in millimetres.
  // ==========================================================================

  function needLib(name, ok) {
    if (ok) return;
    throw new Error('The ' + name + ' library did not load — check the connection and reload.');
  }

  // Build a standalone .ts-doc for capture.
  // ⚠️ NOT the preview node. `.ts-prev .ts-doc` carries `transform: scale(.62)` so the A4
  // sheet fits beside the form, and html2canvas honours transforms — capturing the preview
  // yields a sheet rendered at 62% inside a full-size page. A fresh node with no `.ts-prev`
  // ancestor gets the unscaled rule.
  function captureHolder(kind, data) {
    var holder = document.createElement('div');
    // ⚠️⚠️ THE HOLDER IS PARKED OFF-SCREEN; THE CAPTURED NODE STAYS IN NORMAL FLOW INSIDE
    // IT. Do NOT put position:fixed/absolute on the .ts-doc itself. html2pdf clones the
    // source into its own container and measures it there, and an out-of-flow element
    // contributes NOTHING to that container's height — html2canvas then gets the right
    // width and a height of ZERO and renders an empty page. An explicit height does not
    // rescue it, because the clone is still out of flow. This is documented at length in
    // planning-app's issues-lessons module, which produced a completely blank PDF this way.
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:210mm;z-index:-1;';
    holder.innerHTML = render(kind, data);
    document.body.appendChild(holder);
    return holder;
  }

  var A4_H_MM = 297;
  var PX_PER_MM = 96 / 25.4;          // CSS px per mm, the ratio the browser laid the sheet out with

  // The top sheet alone, as a PDF Blob.
  async function toPdfBlob(kind, data) {
    needLib('PDF', typeof window.html2pdf === 'function');
    var holder = captureHolder(kind, data);
    try {
      var node = holder.firstElementChild;

      // ⚠️ HOW MANY PAGES THIS SHEET ACTUALLY NEEDS, measured off the laid-out element.
      // html2pdf decides pagination from the rasterised canvas height converted to mm,
      // and that conversion rounds: a sheet measuring 296.999mm — comfortably inside A4 —
      // still came out as TWO pages, the second one blank. On a merged package that blank
      // sheet lands between the top sheet and the document being approved, which on a
      // controlled form reads as a missing page. The element's own height is the ground
      // truth, so it is what decides the page count; html2pdf's extra pages are trimmed
      // below. The 1mm tolerance is the rounding slack, not a fudge for real overflow —
      // a sheet that genuinely runs long still gets its second page.
      var mmH = node.getBoundingClientRect().height / PX_PER_MM;
      var expect = Math.max(1, Math.ceil((mmH - 1) / A4_H_MM));

      var pdf = await window.html2pdf().set({
        // ⚠️ margin 0. topsheet.css already lays the sheet out as a full 210x297mm page
        // with its own internal padding; adding a PDF margin on top shrinks the form and
        // pushes it off centre, which on a controlled document reads as the wrong revision.
        margin: 0,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
      }).from(node).toPdf().get('pdf');

      var nPages = pdf.internal.getNumberOfPages();
      while (nPages > expect) { pdf.deletePage(nPages); nPages--; }
      return pdf.output('blob');
    } finally {
      // ⚠️ In `finally`: a throw mid-render would otherwise leave the off-screen node in
      // the document and every later export would stack another one.
      if (holder.parentNode) holder.parentNode.removeChild(holder);
    }
  }

  function isPdf(name, type) {
    return /pdf/i.test(String(type || '')) || /\.pdf$/i.test(String(name || ''));
  }

  // Concatenate PDFs, top sheet first.
  // ⚠️ ONLY PDFs CAN BE MERGED. An .xlsx or .docx attachment is not a page stream and
  // there is nothing in the browser that can turn one into pages; a converter would mean
  // a server-side service. So a non-PDF attachment RIDES ALONG as its own file and the
  // caller is told which is which, rather than being silently dropped or silently
  // converted into something lossy. Chosen explicitly with the user.
  async function mergePdfs(blobs) {
    if (blobs.length === 1) return blobs[0];
    needLib('PDF merge', !!(window.PDFLib && window.PDFLib.PDFDocument));
    var out = await window.PDFLib.PDFDocument.create();
    for (var i = 0; i < blobs.length; i++) {
      var buf = await blobs[i].arrayBuffer();
      // ignoreEncryption: consultants' drawing PDFs are very often print-protected. Those
      // open fine and copy fine; refusing them would block the common case.
      var src = await window.PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
      var pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(function (p) { out.addPage(p); });
    }
    return new Blob([await out.save()], { type: 'application/pdf' });
  }

  // Build the full package for a sheet.
  //   attachments: [{ name, type, get: async () => Blob }]
  // Returns { file:{name,blob}, separate:[{name,blob}], merged:n, skipped:[names] }
  // ⚠️ A failed attachment fetch does NOT fail the whole package — the top sheet is the
  // thing being generated and is useful on its own. The failure is reported back so the
  // caller can say so, rather than producing a merged file that quietly lacks a document.
  async function buildPackage(kind, data, attachments, baseName) {
    var sheet = await toPdfBlob(kind, data);
    var parts = [sheet], separate = [], skipped = [];
    for (var i = 0; i < (attachments || []).length; i++) {
      var a = attachments[i];
      var blob = null;
      try { blob = await a.get(); } catch (e) { blob = null; }
      if (!blob) { skipped.push(a.name || 'attachment'); continue; }
      if (isPdf(a.name, blob.type || a.type)) parts.push(blob);
      else separate.push({ name: a.name || 'attachment', blob: blob });
    }
    var merged = await mergePdfs(parts);
    return {
      file: { name: (baseName || (kind + ' top sheet')) + '.pdf', blob: merged },
      separate: separate, merged: parts.length - 1, skipped: skipped
    };
  }

  function saveBlob(name, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    // Revoked late: Firefox cancels an in-flight download if the URL dies immediately.
    setTimeout(function () { URL.revokeObjectURL(url); }, 20000);
  }

  // A filename someone can find in a mail client six months later: the form, the id,
  // the project. Never just "topsheet.pdf".
  function packageName(kind, data) {
    var id = data[kind.toLowerCase() + 'Id'] || data.masId || data.rfaId || data.rfiId || '';
    return [kind, id, data.projectCode || data.projectName || '']
      .filter(Boolean).join(' ').replace(/[\\/:*?"<>|]+/g, '-').trim();
  }

  // ==========================================================================
  // EMAIL — hand the generated package to the send-mail Edge Function
  // --------------------------------------------------------------------------
  // ⚠️ NOTHING IS SENT WITHOUT THE USER PRESSING SEND IN THE COMPOSE DIALOG.
  // Issuing a top sheet puts a document in front of a client or consultant on
  // Megawide's behalf, so it is never a side effect of generating one.
  // ⚠️ The message leaves as the signed-in user, and the function decides that
  // from their own profile — the address is NOT sent from here and cannot be
  // overridden. See the security banner in supabase/functions/send-mail.
  // ==========================================================================

  function blobToB64(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      // readAsDataURL gives "data:<mime>;base64,…" — Graph wants only the payload.
      fr.onload = function () { res(String(fr.result).split(',')[1] || ''); };
      fr.onerror = function () { rej(fr.error || new Error('Could not read the file')); };
      fr.readAsDataURL(blob);
    });
  }

  async function sendMail(msg) {
    if (!window.getSB) throw new Error('Not signed in.');
    var res = await window.getSB().functions.invoke('send-mail', { body: msg });
    // ⚠️ A non-2xx from an Edge Function arrives as res.error with the BODY
    // discarded, and the body is where the useful message lives ("consent was
    // never granted", "your profile has no email"). Read it back off the
    // response so the toast says what actually went wrong.
    if (res.error) {
      var detail = '';
      try { detail = (await res.error.context.json()).error || ''; } catch (e) { detail = ''; }
      throw new Error(detail || res.error.message || 'Sending failed');
    }
    if (res.data && res.data.error) throw new Error(res.data.error);
    return res.data;
  }

  // Compose dialog. `pkg` is a buildPackage() result, so what is attached here is
  // exactly the file the Download button would have produced — the sheet, the
  // merged document, and any non-mergeable attachment as its own file.
  function openCompose(kind, data, pkg, defaults) {
    var d = defaults || {};
    var id = data[kind.toLowerCase() + 'Id'] || data.masId || data.rfaId || data.rfiId || '';
    var proj = data.projectName || data.projectCode || '';
    var subject = [FORMS[kind].label, id, '—', proj].filter(Boolean).join(' ');
    var files = [pkg.file].concat(pkg.separate);
    var kb = function (b) { return (b.size / 1024).toFixed(0) + ' KB'; };

    var body = 'Dear Sir/Madam,\n\nPlease find attached ' + FORMS[kind].label +
      (id ? ' ' + id : '') + ' for ' + (proj || 'the project') +
      ', for your review and approval.\n\n' +
      'The top sheet is the first page of the attached document.\n\n' +
      'Thank you.\n\n' + ((data.submittedBy || d.from || '') || '');

    var m = UI.modal(
      '<div class="pd-modal-header"><h2 style="margin:0;">Email ' + esc(FORMS[kind].label) +
        (id ? ' ' + esc(id) : '') + '</h2>' +
        '<button class="pd-btn" id="tm-x" title="Close">&times;</button></div>' +
      '<div class="ts-mail">' +
        '<label class="ts-fld"><span>To — separate several with a comma</span>' +
          '<input class="pd-input" id="tm-to" type="text" value="' + esc(d.default_to_email || '') + '" ' +
          'placeholder="consultant@example.com" /></label>' +
        '<label class="ts-fld"><span>Cc</span><input class="pd-input" id="tm-cc" type="text" value="" /></label>' +
        '<label class="ts-fld"><span>Subject</span>' +
          '<input class="pd-input" id="tm-subj" type="text" value="' + esc(subject) + '" /></label>' +
        '<label class="ts-fld"><span>Message</span>' +
          '<textarea class="pd-input" id="tm-body" rows="8">' + esc(body) + '</textarea></label>' +
        '<div class="ts-mail-att"><strong>Attached</strong>' +
          files.map(function (f) {
            return '<div>' + esc(f.name) + ' <span class="ts-mut">' + kb(f.blob) + '</span></div>';
          }).join('') +
          (pkg.merged ? '<div class="ts-mut">The submitted document is merged under the top sheet.</div>' : '') +
          (pkg.separate.length ? '<div class="ts-mut">' + pkg.separate.length +
            ' file(s) could not be merged into the sheet and are attached separately.</div>' : '') +
        '</div>' +
        '<p class="ts-mut" id="tm-note">This will be sent from your own Megawide mailbox and kept in your Sent Items.</p>' +
      '</div>' +
      '<div class="pd-modal-actions">' +
        '<button class="pd-btn" id="tm-cancel">Cancel</button>' +
        '<button class="pd-btn pd-btn-primary" id="tm-send">Send</button>' +
      '</div>', { noBackdropClose: true });

    m.el.querySelector('#tm-x').onclick = m.close;
    m.el.querySelector('#tm-cancel').onclick = m.close;

    var sendBtn = m.el.querySelector('#tm-send');
    sendBtn.onclick = async function () {
      var to = m.el.querySelector('#tm-to').value.trim();
      if (!to) { UI.toast('Enter at least one recipient.', 'error'); return; }
      var orig = sendBtn.textContent;
      sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
      try {
        var attachments = [];
        for (var i = 0; i < files.length; i++) {
          attachments.push({
            name: files[i].name,
            contentType: files[i].blob.type || 'application/octet-stream',
            contentBytes: await blobToB64(files[i].blob)
          });
        }
        var out = await sendMail({
          to: to, cc: m.el.querySelector('#tm-cc').value.trim(),
          subject: m.el.querySelector('#tm-subj').value.trim(),
          body: m.el.querySelector('#tm-body').value,
          attachments: attachments
        });
        UI.toast('Sent from ' + ((out && out.from) || 'your mailbox') + ' to ' + to, 'ok');
        m.close();
      } catch (e) {
        // Left OPEN on failure: the composed message is the user's work and
        // closing the dialog would throw it away along with the error.
        UI.toast((e && e.message) || 'Sending failed', 'error');
      } finally {
        sendBtn.disabled = false; sendBtn.textContent = orig;
      }
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
    // The PDF surface is public because the register modules build packages without
    // opening the dialog (bulk issue, and the email path).
    toPdfBlob: toPdfBlob, mergePdfs: mergePdfs, buildPackage: buildPackage,
    packageName: packageName, saveBlob: saveBlob, isPdf: isPdf,
    sendMail: sendMail, openCompose: openCompose, blobToB64: blobToB64,
    _internals: { FIELDS: FIELDS, RFA_TYPES: RFA_TYPES, REVIEW_STATUS: REVIEW_STATUS, fmtDate: fmtDate }
  };
})();
