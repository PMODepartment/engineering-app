# Module: request-for-approval

## The RFA register — built so an RFA is connected to the drawings it approves (2026-08-24) — fmlozano
`assets/js/topsheet.js` has rendered the F-GEN011 RFA sheet since 0012, but the RFA was opened
**blank** from the Material Submittal toolbar: there was no record behind it. So an RFA could be
printed and never tracked — nothing knew it had been issued, what it covered, or whether the
consultant had answered — and "auto-generate and email the top sheet" was impossible for RFAs
because there was nothing to generate one *from*. This is that register.

**Migration `../../migrations/0020-request-for-approval.sql` (USER RUNS IT)** — two tables,
`request_for_approval` + `rfa_drawings`.

### ⚠️ RFI is deliberately NOT here
Decided with the owner: an RFA carries a document for approval and needs a log; an RFI is a
question-and-answer sheet and stays an on-demand blank form. **Do not "complete the set"** by
cloning this for RFIs without asking — an empty register nobody fills is worse than none.

### ⚠️ NO SOURCE WORKBOOK, AND THEREFORE NO IMPORTER
The three transcribed registers each had a real PMO workbook whose own formulas were the spec.
There is no RFA tracker to build against, so the schema and vocabulary were **designed**. Two
consequences, both deliberate: there is **no Excel import** (every sibling importer reads a layout
it knows; inventing one here would be guessing at a file nobody has produced — export exists, so
the register can still be handed over in Excel), and the Summary carries a **method note, not a
reconciliation note**, stating how each figure is built.

### The point of the register is the UNANSWERED RFA
An RFA is a question that blocks work, so **`date_required` drives everything** — the Summary, the
default sort, the overdue count. Not the issue date, and not the status alone.
- ⚠️ **`isOpen` and `overdueDays` are each defined ONCE** and every surface reads them (KPI, filter,
  row tint, age buckets, the chase list). The sibling modules record what happens otherwise: a count
  that contradicts the list beside it.
- ⚠️ **A row with no status is a DRAFT, not open.** An RFA nobody marked as submitted has not been
  submitted, and counting it would inflate the one number this register exists to report.
- ⚠️ **A closed RFA is never overdue**, however late it was answered — `overdueDays` returns null
  for anything closed, so no surface can report an answered RFA as late.
- ⚠️ **Age buckets describe the OPEN queue only** and are asserted to total exactly the open count.
- **Median turnaround leads, mean beside it**: one RFA that sat for a year drags a mean somewhere no
  real RFA has been. A negative turnaround is treated as a data-entry error and excluded, not averaged.
- Default order is **worst first**, not by RFA number — this is a chase list, and sorting by number
  buries a 40-day-old blocker.

## ⚠️⚠️ AN RFA IS CONNECTED TO THE DRAWINGS IT SEEKS APPROVAL FOR
Added on the owner's instruction mid-build ("the RFA is connected for approval for each of the
drawing"), and it is the heart of the module rather than a nicety. `rfa_drawings` is a **real
many-to-many table with real foreign keys**, folded into 0020 rather than shipped as a second
migration because 0020 had not been run yet.
- **Both directions matter, and the reverse one is the useful one:**
  forward *"what is RFA-014 asking approval for?"*; reverse *"which RFA is A-1204 waiting on, and
  how late is it?"* The Summary's **"Drawings blocked by an RFA"** card is that reverse view — one
  late RFA can hold up a dozen drawings, which is invisible from the RFA list alone.
- ⚠️ **NOT ids inside the `documents` jsonb.** Ids in jsonb cannot be joined, cannot cascade, and go
  stale silently when a drawing is deleted. `documents` is now explicitly for things that are **not**
  in the register — a method statement, a schedule, a test report — and the register draws that
  distinction on the row, in the form, and in the export.
- ⚠️ **Many-to-many, deliberately.** One RFA transmits several drawings, AND one drawing is carried
  by several RFAs over its life — every resubmission is a new RFA for the same drawing. An `rfa_id`
  column on `drawing_register` would model neither, and that table is also written by the importer,
  which knows nothing about RFAs.
- ⚠️ **`rfa_drawings.revision` stores the revision AS TRANSMITTED.** `drawing_register.revision`
  moves on; what this RFA actually sent does not. Without it, a reissued drawing would make every
  historic RFA appear to have transmitted the latest revision — and the printed sheet would name the
  wrong one.
- ⚠️ **The link has no `project_id`**, so its RLS derives access from the parent RFA via `EXISTS`.
  That is a subquery per row, which is why both indexes exist. A denormalised `project_id` here would
  be a second source of truth for which project a link belongs to.
- ⚠️ **No audit trigger on the link:** `engineering_audit_trg()` records `record_id` from a
  single-column primary key, and this table's key is composite, so it would log a null id. The RFA
  itself is audited and a link change is always part of saving an RFA.
- Links are **diffed on save, not delete-all-then-reinsert** — a rebuild would lose or churn the
  transmitted revision. A link failure does **not** fail the save (the RFA row is already written);
  it is reported instead, or the user would think nothing saved while the row is there.
- The picker matches **AND over whitespace terms across code + title**, capped at 40 with a
  keep-typing hint. ⚠️ A `<datalist>` cannot do this — browsers filter it on the option **value**,
  which here has to be the id. The drawing register hit the same wall with its activity picker.
- ⚠️ **A SHEET IS A DRAWING WHOSE PARENT IS ITSELF A DRAWING** — the rule is copied verbatim from
  `drawing_register.indexSheets()`, not re-derived. That module had to fix exactly this when levels
  gained `parent_id`; if the two ever disagree, this picker offers sheets as though they were drawings.

### The generated RFA carries the drawing FILES too
Also on the owner's instruction. The package is: **top sheet → each linked drawing's own file → the
RFA's own attachment**, matching the order the sheet lists them in.
- ⚠️ **THE TRANSMITTED REVISION'S FILE WINS.** The register keeps a file per submitted revision
  (`submissions[].file_url`) as well as one row-level file that is "the current/approved version".
  For an RFA that transmitted Rev 1, **Rev 1's file is what was sent**; falling straight to the
  row-level file would attach whatever has been uploaded since, which on a signed transmittal is the
  wrong document. Falls back to the row-level file only when that revision has none.
- ⚠️ **The RFA never copies a drawing file.** It reads it from the drawing register's own bucket
  (`drawing-register`), so there is one copy of a drawing in this app and the register stays its
  owner. That is why every fetch takes a bucket rather than assuming one.
- Attachments are named by **drawing code + revision**, not the stored filename — the consultant is
  looking for `A-1204 Rev 1.pdf`, not `scan_003.pdf`.
- ⚠️ **A linked drawing with NO file is named on the dialog before anything is generated.** The RFA
  asks the consultant to approve that drawing, so a package quietly lacking it cannot be approved —
  and it looks complete. `TopSheet.open({notes:[…]})` exists for this.
- Tolerant of `submissions` arriving as a **string**, which a hand-run SQL insert produces.

### Recording the approval back onto the drawings
When the consultant approves an RFA, the drawings it carried are approved. But ⚠️⚠️ **the Drawing
Register OWNS a drawing's approval, and this must not become a second source of truth for it.**
- **It is never automatic.** Nothing is written by saving an RFA or by setting its status. A planner
  presses a button having seen exactly which drawings will be touched. An approval silently
  propagating across modules is how a register ends up disagreeing with itself with nobody having
  decided anything.
- ⚠️ **A sheet-tracked drawing is REFUSED, not resolved.** Where a drawing is tracked per sheet its
  status is *derived* from its sheets; writing a status onto the parent is precisely the bug the
  drawing register documents at length — a drawing marked Approved as one row, then broken into 15
  sheets, kept a stale "Approved" pill over counters reading 0/15. Those drawings are listed and
  skipped with the reason.
- **`Approved w/ comments` lands as `Approved w/ comments`**, never rounded up to a clean approval —
  the drawing register distinguishes them too.
- **Only `status` and `actual_approval` are written.** No counter is touched: `drawing_register`
  derives `approved_sheets` from status for a single-sheet row itself, and guessing from here would
  fight that rule.
- A drawing **already carrying** the approval is skipped rather than rewritten (it would only churn
  `updated_at` and add a meaningless audit row), and a link to a **deleted** drawing is reported as
  missing. Partial failures are **named, not counted** — "3 failed" is unactionable.

### Status vocabulary reuses names that are already gated
`Approved`, `Approved w/ comments`, `Resubmit` and `Rejected` all already appear in
`engineering_decision_statuses()` (0002, extended by 0014), so **0020 does not redefine that
function.** That matters: it is shared, every migration touching it must reproduce the whole list
verbatim, and dropping a name would silently un-gate approval on `drawing_register` or
`material_submittal`. Inventing an RFA-specific synonym would have forced a redefinition for no
benefit. The form also **only offers the gated statuses to a planner**, because the DB guard refuses
them anyway and offering them to everyone produces a save that fails after the form is filled in.

### Chrome is copied, not re-invented
`module.css` takes the type scale, topbar, tabs, tools, filter bar, tables and pill treatment
**verbatim** from `value-engineering/module.css` (which took it from method-register → material-
submittal → drawing-register, after a computed-style diff across the suite). VE-specific rules
(`.ve-qi`, `.ve-pri`, the VE status palette) were **removed rather than carried over** — this
register has no money, quality-impact or priority columns, so they would have been dead CSS nobody
could explain.

### ⚠️ TWO REAL BUGS FOUND IN `renderRFA` (topsheet.js), both pre-existing
Neither was reachable until a register started supplying the document table — nothing populated
`documents` before, so the RFA sheet's document table was always empty.
1. **It read `r.no`, and every producer writes `doc_no`.** So the document table printed **blank**,
   on a controlled transmittal form whose whole purpose is to list what is being sent for approval.
   `r.no` is kept as a fallback.
2. **It rendered exactly 4 rows and silently dropped the rest.** An RFA transmitting eight drawings
   printed four and lost four, with nothing on the sheet saying so. It now prints **every** document,
   padded to four so a blank form still looks like the issued one. More than four grows the sheet
   past A4 and it paginates — correct: a second page beats a document that was never listed.

### Verification
**108 checks in a real browser** (`rfa.html`, module `eval`'d against a stubbed Supabase/UI — the
shipped functions, never reimplemented):
- **Dates:** `daysBetween` across leap and non-leap month boundaries and same-day; `fmtDate` does not
  shift the day (the UTC+8 trap this repo documents three times); the `2000-01-06` sentinel rejected.
- **Open/overdue:** every status bucketed; a blank status is a draft; an approved / rejected /
  cancelled / draft RFA is **never** overdue; no required date means not overdue rather than
  infinitely late; a sentinel date does not report 26 years late.
- **Stats:** age buckets total exactly the open count; status buckets partition the register with no
  double counting; approved includes approved-with-comments; median and mean turnaround; a negative
  turnaround discarded.
- **Filtering/sort:** open-only and overdue-only match their KPIs; the status filter is exact, so
  "Approved" excludes "Approved w/ comments"; default order leads with the most overdue and puts
  every open row before every closed one; search reaches document numbers, descriptions and types.
- **Render:** header and body column counts agree; exactly the overdue rows are tinted; a hostile RFA
  number and title are escaped rather than executed.
- **The drawing link:** forward and reverse lookups; the sheet prints the revision **this RFA
  transmitted (1), not the drawing's current 2**; linked drawings lead and free-typed documents
  follow, and both print; searching a linked drawing code finds the RFA holding it up; the Summary's
  reverse view counts and names exactly the drawings waiting on an **open** RFA and excludes one
  whose RFA is answered; the export separates linked drawings from free documents.
- **The write-back invariants:** only plain, not-yet-approved drawings are targets; a sheet-tracked
  drawing is refused and never appears among the rows that would be written; an already-approved
  drawing is left alone; a link to a deleted drawing is reported as missing, never written.
- **The drawing files:** the transmitted revision's file wins; an unknown revision falls back to the
  row-level file; `submissions` stored as a string is still read; a drawing with no file yields null
  and is **reported**; attachments are named by drawing code + revision and typed so PDFs merge; the
  RFA's own attachment comes last.

**Plus 16 PDF checks** (`ts.html`) re-run green after the `renderRFA` fix — the sheet is still exactly
one A4 page and still merges attachments correctly.
- ⚠️ **NOT verified signed-in.** The migration is not run; the user runs it. No live Supabase, no real
  storage fetch, and **no screenshot** — this environment's compositor is stalled (a long-standing
  limit noted throughout these files), so UI claims are measured geometry and asserted content.
- ⚠️ **The email path is not verified end-to-end** — see the root `CLAUDE.md` on `send-mail`: the
  Azure consent and the Exchange `ApplicationAccessPolicy` are IT actions. Call it with
  `{"dry_run": true}` first.
- Assets `module.css/js?v=20260824a`, `topsheet.js/css?v=20260824a`.
