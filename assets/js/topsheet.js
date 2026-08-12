// ============================================================================
// Top sheets (TopSheet) — PMO controlled forms, rendered for print/PDF
// ----------------------------------------------------------------------------
//   F-GEN013 Rev 0   Material Submittal        (MAS)
//   F-GEN011 Rev 0   Request for Approval      (RFA)
//   F-GEN010 Rev 0   Request for Information   (RFI)
//
// Each renderer reproduces its workbook's own 9-column A–I grid: every merged
// range below is transcribed from the template's merge map, and every border
// from the template's own cell borders. The three forms are DIFFERENT documents
// with different fields — MAS covers a material submission, RFA an approval
// request for documents, RFI a question to the design consultant — so they get
// three renderers rather than one parameterised layout.
//
// Usage:
//   TopSheet.open({ kind:'MAS', project:{id,name}, defaults:{...}, record:{...} })
//
// `record` prefills the form (the Material Submittal Log passes a row for MAS);
// every field stays editable before printing, because the paper form is what
// the client signs and the log rarely carries the reviewer's exact wording.
//
// Printing is the browser's own "Save as PDF" — no PDF library. The layout is
// already A4 in topsheet.css, so the print dialog produces the exact sheet, and
// nothing has to be kept in sync with a second rendering engine.
// ============================================================================

window.TopSheet = (function () {
  'use strict';

  var esc = function (s) { return Fmt.esc(s == null ? '' : String(s)); };

  var FORMS = {
    MAS: { no: 'F-GEN013 Rev 0', title: 'MATERIAL SUBMITTAL (MAS)',    label: 'Material Submittal' },
    RFA: { no: 'F-GEN011 Rev 0', title: 'REQUEST FOR APPROVAL (RFA)',  label: 'Request for Approval' },
    RFI: { no: 'F-GEN010 Rev 0', title: 'REQUEST FOR INFORMATION (RFI)', label: 'Request for Information' }
  };

  var COPIES = '1 - Owner       2 - Consultant       3 - Megawide     4 - Others _____________';

  // 9 equal columns. The templates set only column A explicitly (9.1 vs Excel's
  // 8.43 default), a 1.08x difference that is not worth a special case.
  function colgroup() {
    var c = '';
    for (var i = 0; i < 9; i++) c += '<col style="width:11.11%">';
    return '<colgroup>' + c + '</colgroup>';
  }

  function td(opts) {
    var o = opts || {};
    var attrs = '';
    if (o.cs) attrs += ' colspan="' + o.cs + '"';
    if (o.rs) attrs += ' rowspan="' + o.rs + '"';
    if (o.h) attrs += ' style="height:' + o.h + '"';
    return '<td class="' + (o.cls || '') + '"' + attrs + '>' + (o.v == null ? '' : o.v) + '</td>';
  }
  // A filled value: bold so it is distinguishable from the blank form's rules.
  function val(v) { var s = esc(v); return s ? '<span class="ts-val">' + s + '</span>' : ''; }
  function pre(v) { var s = esc(v); return s ? '<div class="ts-pre ts-val">' + s + '</div>' : ''; }

  function docOpen(kind) {
    return '<div class="ts-doc" id="ts-doc"><table class="ts-t">' + colgroup() + '<tbody>';
  }
  function docClose(kind) {
    return '</tbody></table>' +
      '<div class="ts-formno">' + esc(FORMS[kind].no) + '</div></div>';
  }
  // Banner row spanning all 9 columns (the templates' shaded section headers).
  function band(text, cls) {
    return '<tr>' + td({ cs: 9, cls: 'ts-band bt br bb bl ' + (cls || ''), v: esc(text) }) + '</tr>';
  }

  // ==========================================================================
  // MAS — F-GEN013. Grid transcribed from the workbook (rows 1–40).
  // ==========================================================================
  function renderMAS(d) {
    var h = docOpen('MAS');
    // R1 A1:I1 banner
    h += '<tr>' + td({ cs: 9, cls: 'ts-band ts-band-c bt br bl', v: esc(FORMS.MAS.title), h: '9mm' }) + '</tr>';
    // R2 A2 | B2 | C2:F2 | G2 | H2:I2
    h += '<tr>' +
      td({ cls: 'ts-b ts-11 bt bb bl', v: 'PROJECT NAME:' }) +
      td({ cls: 'bt br bb' }) +
      td({ cs: 4, cls: 'ts-10 bt bb bl', v: val(d.projectName) }) +
      td({ cls: 'ts-b ts-11 bt br bb bl', v: 'Date:' }) +
      td({ cs: 2, cls: 'ts-10 ts-c bt br bb', v: val(d.date) }) + '</tr>';
    // R3 A3 | B3 | C3:I3
    h += '<tr>' +
      td({ cls: 'ts-b ts-11 bt bb bl', v: 'CLIENT:' }) +
      td({ cls: 'bt br bb' }) +
      td({ cs: 7, cls: 'ts-10 bt br bb bl', v: val(d.client) }) + '</tr>';
    // R4 A4:I4 spacer band
    h += '<tr>' + td({ cs: 9, cls: 'ts-band bt br bb bl', h: '2mm' }) + '</tr>';
    // R5 A5 | B5 | C5 | D5:F5 | G5:H5 | I5
    h += '<tr>' +
      td({ cls: 'ts-11 bt bl', v: 'MAS ID.:' }) +
      td({ cls: 'ts-11 bt' }) +
      td({ cls: 'ts-11 bt br' }) +
      td({ cs: 3, cls: 'ts-10 bt br bb bl', v: val(d.masId) }) +
      td({ cs: 2, cls: 'ts-11 bt br bb bl', v: 'Revision No.' }) +
      td({ cls: 'ts-10 ts-c bt br bb', v: val(d.revision) }) + '</tr>';
    // R6 A6:C6 | D6:F6 | G6:H7 (rowspan 2) | I6
    h += '<tr>' +
      td({ cs: 3, cls: 'ts-11 br bl', v: 'MAS Category:' }) +
      td({ cs: 3, cls: 'ts-10 bt br bb bl', v: val(d.category) }) +
      td({ cs: 2, rs: 2, cls: 'ts-11 br bb bl', v: 'Attachment included?' }) +
      td({ cls: 'ts-11 br', v: val(d.attachments) }) + '</tr>';
    // R7 A7:C7 | D7:F7 | I7
    h += '<tr>' +
      td({ cs: 3, cls: 'ts-11 br bb bl', v: 'MAS Sub-category' }) +
      td({ cs: 3, cls: 'ts-10 br bb', v: val(d.subCategory) }) +
      td({ cls: 'ts-11 br bb' }) + '</tr>';
    // R8 A8:I8 band
    h += band('Material Submittal Description');
    // R9 headers A9:C9 | D9:E9 | F9:G9 | H9:I9
    h += '<tr>' +
      td({ cs: 3, cls: 'ts-10 ts-c ts-b bt br bb bl', v: 'Product Name', h: '8mm' }) +
      td({ cs: 2, cls: 'ts-10 ts-c ts-b bt br bb bl', v: 'Manufacturer / Supplier' }) +
      td({ cs: 2, cls: 'ts-10 ts-c ts-b bt br bb bl', v: 'Specification / BOQ Ref.' }) +
      td({ cs: 2, cls: 'ts-10 ts-c ts-b bt br bb', v: 'Location / Use' }) + '</tr>';
    // R10 data row (template row height 80.2pt ≈ 28mm)
    h += '<tr>' +
      td({ cs: 3, cls: 'ts-10 bt br bb bl', v: pre(d.productName), h: '28mm' }) +
      td({ cs: 2, cls: 'ts-10 bt br bb bl', v: pre(d.manufacturer) }) +
      td({ cs: 2, cls: 'ts-10 bt br bb bl', v: pre(d.specRef) }) +
      td({ cs: 2, cls: 'ts-10 bt br bb', v: pre(d.location) }) + '</tr>';
    // R11 band
    h += band('MEGAWIDE CONSTRUCTION CORPORATION');
    // R12 A12:E12 | F12:I12
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 bt br bl', v: 'Submitted by:' }) +
      td({ cs: 4, cls: 'ts-10 ts-c bt br bl', v: 'Responded by Client' }) + '</tr>';
    // R13:16 signature space
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 ts-c br bb bl', v: val(d.submittedBy), h: '20mm' }) +
      td({ cs: 4, cls: 'ts-10 ts-c br bb bl' }) + '</tr>';
    // R17 captions
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 ts-c bt br bb bl', v: 'Name / Signature / Date' }) +
      td({ cs: 4, cls: 'ts-10 ts-c bt br bb bl', v: 'Name / Signature / Date' }) + '</tr>';
    // R18 band
    h += band("PROJECT MANAGEMENT / CONSULTANT'S REVIEW AND APPROVAL");
    // R19 A19:E19 | F19:I19
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 bt br bl', v: 'For and on behalf of Client / Owner' }) +
      td({ cs: 4, cls: 'ts-10 ts-c ts-b bt br bl', v: 'Submittal Review Status' }) + '</tr>';
    // R20:27 comments | review status (left blank — signed by hand)
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 br bb bl', v: 'Comments:', h: '26mm' }) +
      td({ cs: 4, cls: 'ts-10 br bb' }) + '</tr>';
    // R28 caption
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 ts-c bt br bl', v: 'Name / Signature / Date' }) +
      td({ cs: 4, cls: 'ts-10 br' }) + '</tr>';
    // R29 band
    h += band("CLIENT / OWNERS' REVIEW AND APPROVAL");
    // R30
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 bt br bl', v: 'For and on behalf of Client / Owner' }) +
      td({ cs: 4, cls: 'ts-10 ts-c ts-b br bl', v: 'Submittal Review Status' }) + '</tr>';
    // R31:38
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 br bb bl', v: 'Comments:', h: '26mm' }) +
      td({ cs: 4, cls: 'ts-10 br bb' }) + '</tr>';
    // R39
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-10 ts-c bt br bb bl', v: 'Name / Signature / Date' }) +
      td({ cs: 4, cls: 'ts-10 br bb' }) + '</tr>';
    // R40 copies
    h += '<tr>' +
      td({ cls: 'ts-9 bt bb bl', v: 'Copies:' }) +
      td({ cs: 8, cls: 'ts-9 bt br bb', v: COPIES }) + '</tr>';
    return h + docClose('MAS');
  }

  // ==========================================================================
  // RFA — F-GEN011. Grid transcribed from the workbook (rows 1–45).
  // ==========================================================================
  function renderRFA(d) {
    var h = docOpen('RFA');
    h += '<tr>' + td({ cs: 9, cls: 'ts-band ts-band-c bt br bl', v: esc(FORMS.RFA.title), h: '9mm' }) + '</tr>';
    // R2 A2:B2 | C2:I2
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-b ts-11 bt br bb bl', v: 'PROJECT NAME:' }) +
      td({ cs: 7, cls: 'ts-11 bt br bb bl', v: val(d.projectName) }) + '</tr>';
    // R3 A3:B3 | C3:I3
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-b ts-11 bt br bb bl', v: 'CLIENT:' }) +
      td({ cs: 7, cls: 'ts-11 bt br bb bl', v: val(d.client) }) + '</tr>';
    // R4:5 A4 (rs2) | B4:E4 , B5:E5 | F4:G5 (rs2) | H4:I5 (rs2)
    h += '<tr>' +
      td({ rs: 2, cls: 'ts-11 br bb bl', v: 'TO:' }) +
      td({ cs: 4, cls: 'ts-11 br', v: val(d.to) }) +
      td({ cs: 2, rs: 2, cls: 'ts-11 br bb bl', v: 'RFA Date:' }) +
      td({ cs: 2, rs: 2, cls: 'ts-11 ts-c br bb bl', v: val(d.date) }) + '</tr>';
    h += '<tr>' + td({ cs: 4, cls: 'ts-11 br bb bl', v: val(d.toCompany) }) + '</tr>';
    // R6:7 A6 (rs2) | B6:E7 (rs2) | F6:G7 (rs2) | H6:I7 (rs2)
    h += '<tr>' +
      td({ rs: 2, cls: 'ts-11 bt bl', v: 'FROM:' }) +
      td({ cs: 4, rs: 2, cls: 'ts-11 bt br bb bl', v: val(d.from), h: '12mm' }) +
      td({ cs: 2, rs: 2, cls: 'ts-11 bt br bb', v: 'Date Required:' }) +
      td({ cs: 2, rs: 2, cls: 'ts-11 ts-c bt br bb bl', v: val(d.dateRequired) }) + '</tr>';
    h += '<tr></tr>';
    // R8 shaded separator
    h += '<tr>' + td({ cs: 9, cls: 'ts-band bt br bb bl', h: '2mm' }) + '</tr>';
    // R9 A9 'RFA ID:' | F9 'Attachments included?' | I9
    h += '<tr>' +
      td({ cs: 3, cls: 'ts-11 bl', v: 'RFA ID:&nbsp;&nbsp;' + val(d.rfaId) }) +
      td({ cs: 2, cls: 'ts-11' }) +
      td({ cs: 3, cls: 'ts-11', v: 'Attachments included?' }) +
      td({ cls: 'ts-11 br', v: val(d.attachments) }) + '</tr>';
    // R10 A10 'RFA Category:' | C10:E10 | I10
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-11 bl', v: 'RFA Category:' }) +
      td({ cs: 3, cls: 'ts-11', v: val(d.category) }) +
      td({ cs: 3, cls: 'ts-11' }) +
      td({ cls: 'ts-11 br' }) + '</tr>';
    // R11 A11 'RFA Sub-category:' | C11:I11
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-11 bl', v: 'RFA Sub-category:' }) +
      td({ cs: 7, cls: 'ts-11 br bb', v: val(d.subCategory) }) + '</tr>';
    // R12 band
    h += band('RFA DESCRIPTION');
    // R13 the template's own warning note
    h += '<tr>' + td({ cs: 9, cls: 'ts-8 br bl',
      v: 'Note: This form should not be used for Material Submittal. A Material Submittal form is available separately.' }) + '</tr>';
    // R14:17 description body
    h += '<tr>' + td({ cs: 9, cls: 'ts-11 br bl', v: pre(d.description), h: '22mm' }) + '</tr>';
    // R18 document table header: A18:C18 | D18 | E18:H18 | I18
    h += '<tr>' +
      td({ cs: 3, cls: 'ts-10 ts-c ts-b bt br bb bl', v: 'Document No.' }) +
      td({ cls: 'ts-10 ts-c ts-b bt br bb bl', v: 'Rev.' }) +
      td({ cs: 4, cls: 'ts-10 ts-c ts-b bt br bb bl', v: 'Description' }) +
      td({ cls: 'ts-10 ts-c ts-b bt br bb bl', v: 'Copies' }) + '</tr>';
    // R19:23 five document rows
    var docs = d.documents && d.documents.length ? d.documents : [];
    for (var i = 0; i < 5; i++) {
      var r = docs[i] || {};
      h += '<tr>' +
        td({ cs: 3, cls: 'ts-10 bt br bb bl', v: val(r.no), h: '6mm' }) +
        td({ cls: 'ts-10 ts-c bt br bb bl', v: val(r.rev) }) +
        td({ cs: 4, cls: 'ts-10 bt br bb bl', v: val(r.description) }) +
        td({ cls: 'ts-10 ts-c bt br bb bl', v: val(r.copies) }) + '</tr>';
    }
    // R24 band
    h += band('MEGAWIDE CONSTRUCTION CORPORATION');
    // R25:27 signature space
    h += '<tr>' + td({ cs: 9, cls: 'ts-11 br bl', h: '16mm' }) + '</tr>';
    // R28:29 A28:B29 | C28:E28 / C29:E29 | F28:G29 | H28:I29
    h += '<tr>' +
      td({ cs: 2, rs: 2, cls: 'ts-11 bb bl', v: 'Prepared and submitted by:' }) +
      td({ cs: 3, cls: 'ts-11 bb', v: val(d.preparedBy) }) +
      td({ cs: 2, rs: 2, cls: 'ts-11 bb', v: 'Date Returned by Client:' }) +
      td({ cs: 2, rs: 2, cls: 'ts-11 ts-c br bb' }) + '</tr>';
    h += '<tr>' + td({ cs: 3, cls: 'ts-11 bb' }) + '</tr>';
    // R30 band
    h += band("CONSULTANT'S APPROVAL");
    // R31:36 A31:E34 comments | F31:I32 status header + blank option rows
    h += '<tr>' +
      td({ cs: 5, rs: 2, cls: 'ts-11 bt br bl', v: 'Comments:', h: '24mm' }) +
      td({ cs: 4, cls: 'ts-11 ts-c ts-b bt br', v: 'SUBMITTAL REVIEW STATUS' }) + '</tr>';
    h += '<tr>' + td({ cs: 4, cls: 'ts-11 br', h: '16mm' }) + '</tr>';
    // R35:36 A35 'For and on behalf of…' / A36 'Name / Sign / Date'
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-11 br bl', v: 'For and on behalf of [Client / Owner]' }) +
      td({ cs: 4, cls: 'ts-11 br' }) + '</tr>';
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-11 br bl', v: 'Name / Sign / Date' }) +
      td({ cs: 4, cls: 'ts-11 br' }) + '</tr>';
    // R37 band
    h += band("CLIENT / OWNER'S APPROVAL");
    h += '<tr>' +
      td({ cs: 5, rs: 2, cls: 'ts-11 bt br bl', v: 'Comments:', h: '24mm' }) +
      td({ cs: 4, cls: 'ts-11 ts-c ts-b bt br', v: 'SUBMITTAL REVIEW STATUS' }) + '</tr>';
    h += '<tr>' + td({ cs: 4, cls: 'ts-11 br', h: '16mm' }) + '</tr>';
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-11 br bl', v: 'For and on behalf of [Client / Owner]' }) +
      td({ cs: 4, cls: 'ts-11 br' }) + '</tr>';
    h += '<tr>' +
      td({ cs: 5, cls: 'ts-11 bb br bl', v: 'Name / Sign / Date' }) +
      td({ cs: 4, cls: 'ts-11 bb br' }) + '</tr>';
    // R45 copies
    h += '<tr>' +
      td({ cls: 'ts-9 bt bb bl', v: 'Copies:' }) +
      td({ cs: 8, cls: 'ts-9 bt br bb', v: COPIES }) + '</tr>';
    return h + docClose('RFA');
  }

  // ==========================================================================
  // RFI — F-GEN010. Grid transcribed from the workbook (rows 1–44).
  // ==========================================================================
  function renderRFI(d) {
    var h = docOpen('RFI');
    h += '<tr>' + td({ cs: 9, cls: 'ts-band ts-band-c bt br bl', v: esc(FORMS.RFI.title), h: '11mm' }) + '</tr>';
    // R3:4 A3:B4 | C3:I4
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-b ts-11 bt br bb bl', v: 'PROJECT NAME:' }) +
      td({ cs: 7, cls: 'ts-11 bt br bb bl', v: val(d.projectName) }) + '</tr>';
    // R5:6 A5:B6 | C5:I6
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-b ts-11 bt br bb bl', v: 'CLIENT:' }) +
      td({ cs: 7, cls: 'ts-11 bt br bb bl', v: val(d.client) }) + '</tr>';
    // R7:8 A7 (rs2) | B7:E7 'Name & Position' / B8:E8 'Company' | F7:G8 | H7:I8
    h += '<tr>' +
      td({ rs: 2, cls: 'ts-11 bt br bb bl', v: 'TO:' }) +
      td({ cs: 4, cls: 'ts-11 br', v: d.to ? val(d.to) : 'Name &amp; Position' }) +
      td({ cs: 2, rs: 2, cls: 'ts-11 bt br bb bl', v: 'RFI Date:' }) +
      td({ cs: 2, rs: 2, cls: 'ts-11 ts-c bt br bb bl', v: val(d.date) }) + '</tr>';
    h += '<tr>' + td({ cs: 4, cls: 'ts-11 br bb bl', v: d.toCompany ? val(d.toCompany) : 'Company' }) + '</tr>';
    // R9:10 A9 (rs2) | B9:E10 | F9:G10 | H9:I10
    h += '<tr>' +
      td({ rs: 2, cls: 'ts-11 bt bl', v: 'FROM:' }) +
      td({ cs: 4, rs: 2, cls: 'ts-11 bt br bb bl', v: d.from ? val(d.from) : 'Name &amp; Position', h: '12mm' }) +
      td({ cs: 2, rs: 2, cls: 'ts-11 bt br bb', v: 'Date Required:' }) +
      td({ cs: 2, rs: 2, cls: 'ts-11 ts-c bt br bb bl', v: val(d.dateRequired) }) + '</tr>';
    h += '<tr></tr>';
    // R11 shaded separator
    h += '<tr>' + td({ cs: 9, cls: 'ts-band bt br bb bl', h: '2mm' }) + '</tr>';
    // R12 RFI ID | Attachments included? | I12
    h += '<tr>' +
      td({ cs: 3, cls: 'ts-11 bl', v: 'RFI ID:&nbsp;&nbsp;' + val(d.rfiId) }) +
      td({ cs: 2, cls: 'ts-11' }) +
      td({ cs: 3, cls: 'ts-11', v: 'Attachments included?' }) +
      td({ cls: 'ts-11 br', v: val(d.attachments) }) + '</tr>';
    // R13 RFI Category | C13:E13
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-11 bl', v: 'RFI Category:' }) +
      td({ cs: 3, cls: 'ts-11', v: val(d.category) }) +
      td({ cs: 3, cls: 'ts-11' }) +
      td({ cls: 'ts-11 br' }) + '</tr>';
    // R14 RFI Sub-category | C14:E14
    h += '<tr>' +
      td({ cs: 2, cls: 'ts-11 bl', v: 'RFI Sub-category:' }) +
      td({ cs: 3, cls: 'ts-11', v: val(d.subCategory) }) +
      td({ cs: 3, cls: 'ts-11' }) +
      td({ cls: 'ts-11 br' }) + '</tr>';
    // R15 band
    h += band('RFI DESCRIPTION');
    // R16:20 description body (A16:I20)
    h += '<tr>' + td({ cs: 9, cls: 'ts-11 bt br bl', v: pre(d.description), h: '30mm' }) + '</tr>';
    // R21 A21:I21
    h += '<tr>' + td({ cs: 9, cls: 'ts-11 br bl', v: 'For and on behalf of MEGAWIDE CONSTRUCTION CORPORATION' }) + '</tr>';
    // R22:23 Name | Sign | Date
    h += '<tr>' +
      td({ cls: 'ts-11 bb bl', v: 'Name:' }) +
      td({ cs: 3, cls: 'ts-11 bb', v: val(d.from) }) +
      td({ cls: 'ts-11 bb', v: 'Sign:' }) +
      td({ cs: 2, cls: 'ts-11 bb' }) +
      td({ cls: 'ts-11 bb', v: 'Date:' }) +
      td({ cls: 'ts-11 br' }) + '</tr>';
    // R24 band
    h += band("DESIGN CONSULTANT'S RESPONSE");
    // R25:29 response body
    h += '<tr>' + td({ cs: 9, cls: 'ts-11 bt br bl', h: '30mm' }) + '</tr>';
    // R30 For and on behalf of [Engineer]
    h += '<tr>' +
      td({ cs: 8, cls: 'ts-11 bl', v: 'For and on behalf of ' + (d.consultant ? val(d.consultant) : '[Engineer]') }) +
      td({ cls: 'ts-11 br' }) + '</tr>';
    // R31:32
    h += '<tr>' +
      td({ cls: 'ts-11 bb bl', v: 'Name:' }) +
      td({ cs: 3, cls: 'ts-11 bb' }) +
      td({ cls: 'ts-11 bb', v: 'Sign:' }) +
      td({ cs: 2, cls: 'ts-11 bb' }) +
      td({ cls: 'ts-11 bb', v: 'Date:' }) +
      td({ cls: 'ts-11 br' }) + '</tr>';
    // R33 band
    h += band("PROJECT MANAGEMENT / CLIENT'S APPROVAL");
    // R34:39 approval body
    h += '<tr>' + td({ cs: 9, cls: 'ts-11 bt br bl', h: '32mm' }) + '</tr>';
    // R40
    h += '<tr>' +
      td({ cs: 8, cls: 'ts-11 bl', v: 'For and on behalf of [Project Management / Client]' }) +
      td({ cls: 'ts-11 br' }) + '</tr>';
    // R41:42
    h += '<tr>' +
      td({ cls: 'ts-11 bb bl', v: 'Name:' }) +
      td({ cs: 3, cls: 'ts-11 bb' }) +
      td({ cls: 'ts-11 bb', v: 'Sign:' }) +
      td({ cs: 2, cls: 'ts-11 bb' }) +
      td({ cls: 'ts-11 bb', v: 'Date:' }) +
      td({ cls: 'ts-11 br bb' }) + '</tr>';
    // R43 the template's own 48-hour note
    h += '<tr>' + td({ cs: 9, cls: 'ts-9 bt br bb bl',
      v: 'Note: In case that a change in the Contract Amount or Contract Time is required, notify Project Manager within 48 hours from your receipt of the above response and prior to your proceeding with affected work.' }) + '</tr>';
    // R44 copies
    h += '<tr>' +
      td({ cls: 'ts-9 bt bb bl', v: 'Copies:' }) +
      td({ cs: 8, cls: 'ts-9 bt br bb', v: COPIES }) + '</tr>';
    return h + docClose('RFI');
  }

  var RENDER = { MAS: renderMAS, RFA: renderRFA, RFI: renderRFI };

  function render(kind, data) { return RENDER[kind](data || {}); }

  // ==========================================================================
  // Field definitions for the fill-in dialog. Each form asks only for what its
  // own template prints — this is why they are not one shared field list.
  // ==========================================================================
  var FIELDS = {
    MAS: [
      ['masId', 'MAS ID'], ['revision', 'Revision No.'], ['date', 'Date', 'date'],
      ['category', 'MAS Category'], ['subCategory', 'MAS Sub-category'],
      ['attachments', 'Attachment included?'],
      ['productName', 'Product Name', 'area'], ['manufacturer', 'Manufacturer / Supplier', 'area'],
      ['specRef', 'Specification / BOQ Ref.', 'area'], ['location', 'Location / Use', 'area'],
      ['submittedBy', 'Submitted by']
    ],
    RFA: [
      ['rfaId', 'RFA ID'], ['date', 'RFA Date', 'date'], ['dateRequired', 'Date Required', 'date'],
      ['to', 'TO (Name & Position)'], ['toCompany', 'TO (Company)'], ['from', 'FROM (Name & Position)'],
      ['category', 'RFA Category'], ['subCategory', 'RFA Sub-category'],
      ['attachments', 'Attachments included?'],
      ['description', 'RFA Description', 'area'], ['preparedBy', 'Prepared and submitted by']
    ],
    RFI: [
      ['rfiId', 'RFI ID'], ['date', 'RFI Date', 'date'], ['dateRequired', 'Date Required', 'date'],
      ['to', 'TO (Name & Position)'], ['toCompany', 'TO (Company)'], ['from', 'FROM (Name & Position)'],
      ['category', 'RFI Category'], ['subCategory', 'RFI Sub-category'],
      ['attachments', 'Attachments included?'],
      ['description', 'RFI Description', 'area'], ['consultant', 'Design Consultant (Engineer)']
    ]
  };

  // ==========================================================================
  // Dialog: edit the fields, watch the sheet update, then print.
  // ==========================================================================
  function open(opts) {
    opts = opts || {};
    var kind = opts.kind || 'MAS';
    var data = Object.assign({}, opts.data || {});
    data.projectName = data.projectName || (opts.project && (opts.project.name || opts.project.id)) || '';
    data.client = data.client || (opts.defaults && opts.defaults.client_name) || '';

    var fields = FIELDS[kind];
    var form = fields.map(function (f) {
      var key = f[0], label = f[1], type = f[2] || 'text';
      var v = data[key] == null ? '' : data[key];
      var input = type === 'area'
        ? '<textarea class="pd-input ts-f" data-k="' + key + '" rows="2">' + esc(v) + '</textarea>'
        : '<input class="pd-input ts-f" data-k="' + key + '" type="' + (type === 'date' ? 'date' : 'text') +
          '" value="' + esc(v) + '" />';
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
      el.addEventListener('input', function () { data[el.dataset.k] = el.value; repaint(); });
    });
    m.el.querySelector('#ts-x').onclick = m.close;
    m.el.querySelector('#ts-cancel').onclick = m.close;
    m.el.querySelector('#ts-print').onclick = function () {
      // The print CSS hides everything except .ts-doc, gated on this class so the
      // rule can never affect an ordinary Ctrl+P of the page behind the modal.
      document.body.classList.add('ts-printing');
      var done = function () { document.body.classList.remove('ts-printing'); };
      window.addEventListener('afterprint', done, { once: true });
      setTimeout(function () { window.print(); }, 60);
      // Safari/older Chrome do not always fire afterprint — clear it regardless.
      setTimeout(done, 4000);
    };
    return m;
  }

  // ---- per-project defaults (migration 0012) -------------------------------
  // Read-only helper: the generator prefills Client from here. Absent table or
  // row is not an error — the field simply starts blank and the user types it.
  async function loadDefaults(projectId) {
    if (!projectId || !window.__sb) return {};
    try {
      var res = await window.__sb.from('topsheet_defaults')
        .select('*').eq('project_id', projectId).maybeSingle();
      return (res && res.data) || {};
    } catch (e) { return {}; }
  }

  return {
    open: open,
    render: render,
    loadDefaults: loadDefaults,
    FORMS: FORMS,
    _internals: { FIELDS: FIELDS, renderMAS: renderMAS, renderRFA: renderRFA, renderRFI: renderRFI }
  };
})();
