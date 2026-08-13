# Module: value-engineering

> **Claude / developer: read this first.**
> 1. Read `../../docs/MODULE_GUIDE.md` (NOT auto-loaded).
> 2. This module is the **Value Engineering List**. DB table `value_engineering`,
>    migration `../../migrations/0014-value-engineering.sql` — **USER MUST RUN IT**.
> 3. Chrome (topbar / tabs / tools / filter bar) is copied **verbatim** from
>    method-register — do not re-invent it.
> 4. Update this file as you build.

## Built 2026-08-13 — Summary + Registry

⚠️ **NO SOURCE WORKBOOK.** Every other register in this app was transcribed from a
real PMO workbook whose own formulas were the spec. The owner confirmed there is
no existing VE tracker, so this schema and every vocabulary in it were
**designed**, not read off anything. Treat them as a first cut to be corrected
against real practice. Two design consequences follow deliberately:

- The Summary carries a **method note**, not a reconciliation note — there is
  nothing to reconcile against. It states how each figure is built so the first
  person holding their own spreadsheet can see where a difference comes from.
- The importer maps **by header name with synonyms**, not by column index (see
  below).

### ⚠️ The whole point: a claim and a fact are different numbers

    potential saving = baseline_cost - proposed_cost    a CLAIM
    realised saving  = baseline_cost - actual_cost      a FACT

A VE register that reports one total always overstates itself, because every
proposal ever raised contributes its claim — including the rejected ones. So:

- Neither saving is **stored**. Both are derived (`savingOf` / `realisedOf`), so
  a corrected cost can never leave a stale saving behind it.
- `stats()` reports **pipeline** (open items' claims), **approved** (Approved +
  Implemented claims) and **realised** (measured against actual cost) as three
  separate figures. **The module never sums them together anywhere** — the
  harness asserts this.
- Rejected value is reported on its own line and contributes to nothing else.
- ⚠️ **Realised is compared only against the claims of rows that actually carry
  an actual cost** (`realisedOf`). Dividing realised by the full approved total
  when half the implemented rows have no actual cost yet reports *missing data*
  as a shortfall. The panel names how many rows are excluded and why.
- **Schedule impact is the honest counterweight.** A VE item that saves ₱2M and
  costs three weeks is not a saving until someone has seen both, so
  `schedule_impact_days` is summed over approved items and shown as a KPI
  (negative saves time).

### ⚠️ REAL BUG found by the harness, not by reading — punctuated synonyms never matched

`mapHeaders` normalises each sheet header through `normHdr` (lowercase, strip
punctuation) and then compared it against **raw** synonym literals. Any synonym
written with punctuation — `'schedule impact (days)'` — could therefore **never**
match: the header arrived as `schedule impact days` while the literal still
carried its brackets. It failed **silently**, dropping the column into
`unmapped` as though the sheet had not carried it at all. The table is now
normalised through the same function once at load (`SYN_N`), so it is safe to
extend with whatever a real heading looks like. **The Initiatives importer had
the identical bug and is fixed the same way.**

### Importer notes
- ⚠️ **Header-mapped, and it SHOWS the mapping before writing anything.** Every
  sibling importer reads by column index and says so, because each knows its one
  workbook. With no workbook, index-reading would be a guess dressed up as a
  rule. The dialog lists field ← column and names every ignored column; nothing
  is written until the user confirms.
- Header row = the first of the top 30 mapping **a title AND at least one cost**
  column. Requiring both is what stops a decorative banner row
  (`VALUE ENGINEERING LIST`) being read as headers.
- ⚠️ **Cells read as FORMATTED TEXT (`cell.w`).** SheetJS returns the cell showing
  `06-Aug-26` as `2026-08-05T15:59:17Z`, so local getters land a day out east of
  Greenwich — the trap all three sibling registers document.
- ⚠️ **`parseMoney` handles accounting negatives.** `(1,200)` is −1200. Stripping
  only the currency symbol turns it into +1200 — the wrong sign on a cost.
- ⚠️ **`realDate()` rejects anything outside 2015–2100**, catching Excel's zero
  date the same way the siblings do.
- A row counts when it has a title **or** a cost pair — requiring the title alone
  silently dropped a fully costed row in material-submittal.
- Stops at a `PREPARED AND CHECKED BY:` sign-off block, which otherwise imports
  signatories as proposals.

### Approval authority
⚠️ A VE decision is a **money** decision, so migration 0014 attaches
`engineering_guard_decision()` and adds `Endorsed` / `Implemented` to
`engineering_decision_statuses()`. `Approved` and `Rejected` were already in that
list, so they are gated by inheritance.
⚠️ **0014 replaces a shared function** — the 0002 list is reproduced verbatim
inside it. Dropping one of those six names would silently un-gate approval on
drawing-register or material-submittal. The save path translates the resulting
`42501` into a sentence rather than printing a raw Postgres error.

### Dashboard section (2026-08-13)
`EngData.veStats(pid)` + a section in `dashboard.html`. ⚠️ **The status
vocabulary is duplicated into `engdata.js`** (`VE_STATUSES` / `VE_OPEN` /
`VE_WON`) because the shell cannot import a module's constants — change it in
both places or the tiles under-count. `VE_OPEN` / `VE_WON` / `Rejected` must stay
a **partition**; a status in none of them is counted in the total but in no tile,
the exact failure `DR_BUCKET` documents. `EngData.selfTest(pid)` now checks this
module too and warns from the console.
⚠️ Pipeline / Approved / Realised are three separate tiles and the dashboard
never sums them either — a row of peso tiles with no unit invites exactly the
addition the module refuses to do, so each carries an explicit sub-caption.

### Verification
- **137/137 automated checks** (shared harness with Initiatives) against the
  **shipped** `module.js`, running its own exported internals — no
  reimplementation. Covers: both savings including the null and zero cases; the
  bucket partition (`open + won + rejected` accounts for every row exactly once);
  pipeline / approved / realised computed independently and never summed;
  rejected value isolated (removing the rejected row moves no other total);
  accounting-negative and peso-separator money parsing; three date formats plus
  the Excel-zero guard; status synonym normalisation; header mapping including
  the punctuation bug above and first-match-wins; a full sheet parse with a
  banner row, a blank row, a titleless-but-costed row and a sign-off block; and
  `headCells()` emitting exactly one `<th>` per entry with one extra for writers.
- `node --check` clean; CSS braces and comments balanced.
- ⚠️ **NOT browser-verified and NOT verified signed-in.** The migration has not
  been run, and nobody has imported a real VE spreadsheet against the live DB.
  Layout at 375 / 768 / 1280 and dark-mode contrast are unmeasured here.

### Not built (deliberate)
File attachments, per-item revision history, drag-reorder, bulk actions, inline
cell editing, live collaboration and offline writes — all present in one or more
sibling registers, none asked for. `remarks`, `risk_notes`, `origin` and
`target_date` exist in the table and the form but drive no roll-up yet.

## Status
- [x] Read the module guide; chrome copied, not re-invented
- [x] CRUD (add / edit / delete / clear), project-scoped, `created_by` stamped
- [x] `Fmt.esc()` on all user text injected into HTML
- [x] List read keyset-paginated past 1000 rows
- [x] Import (header-mapped, mapping shown) + export
- [x] Audit trigger + approval guard in the migration
- [x] `enabled: true` in `assets/js/config.js`; assets `?v=20260813a`
- [ ] **Migration run on the live DB**
- [ ] Live click-through against a real login
- [ ] Responsive + dark-mode measured at 375 / 768 / 1280
- [ ] Verified as `viewer` and as `user` that the DB refuses what the UI hides
