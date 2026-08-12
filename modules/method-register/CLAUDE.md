# Module: method-register

> **Claude / developer: read this first.**
> 1. Read `../../docs/MODULE_GUIDE.md` (NOT auto-loaded).
> 2. This module is **Method Register**. DB table `method_register`, migration
>    `../../migrations/0013-method-register.sql` — **USER MUST RUN IT**.
> 3. Chrome (topbar/tabs/tools/filter bar) is copied **verbatim** from
>    material-submittal — do not re-invent it.
> 4. Update this file as you build.

## Built 2026-08-12 — Summary + Registry, from the SLN101 tracker

Built against **“MCC. ENG. MET. MRE. SLN101 Method Registry Tracker. 2026 07 15.xlsx”**
(Strevi Residences, Salinas Bacoor). Two screens, matching the workbook's two
working tabs: **Summary** (its SUMMARY sheet) and **Registry** (its
`Method Registry 01` sheet).

### The workbook's formulas ARE the spec
Read off its own cells, not guessed. Per trade (TW = SUMMARY row 6):

    TOTAL MS (G)        = 'Method Registry 01'!N<trade> = SUM of N over the block
    APP / AWC / DIS     = COUNTIFS(code "*TW*", Status <x>, N=1)
    TOTAL SUBMITTED (I) = APP + AWC + DIS
    PROGRESS (J)        = I / G          BALANCE (K) = G − I
    % APP (Y)           = APP / G
    HIRAC/QCC/MAS/ISD   = SUMIFS(N, <attachment> = "Balance", code "*TW*")
    ENGG (AA) / OPS(AB) = COUNTIFS(code "*TW*", Ball-In "engg"/"ops", N=1)

Registry-side: `A = IF(N<>"", $A$trade & B, "")` composes the code;
`O (Latest Revision) = COUNTIF(V>0)+COUNTIF(X>0)+COUNTIF(Z>0)+COUNTIF(AB>0)`,
i.e. how many rev-1..4 planned dates exist; `AI = IF(AF="APPROVED",1,0)`.

### ⚠️ `counts` (the workbook's N=1) gates EVERY metric
The sample holds **323 method-statement rows of which only 103 count**. N is the
flag for "part of the target"; the rest are named-but-not-yet-programmed. A
register that ignored it would over-report by 3x. Stored as `counts boolean`,
surfaced in the Registry as a dimmed row + “not counted”, and as a **Counted
only** filter. The Add/Edit form explains it rather than showing a bare checkbox.

### TWO DEFECTS in the workbook — reproduced, proven, then fixed
Same treatment material-submittal gives its own: **fix, and show the difference**
in a reconciliation note rather than silently correcting.
1. ⚠️ **BALL IN COURT loses most of the register.** SUMMARY counts Ball-In
   `engg` and `ops`, but the sheet's own vocabulary is **Open / Ops / Closed / -**.
   Nobody ever types "engg", so **ENGG reads 0 for every trade**, and the **79**
   counted items sitting at "Open" are attributed to **neither** column — the
   block accounts for 19 of 103. `tradeStats()` reports Engg / Ops / Closed /
   **Unassigned** so the four always sum to the total.
2. ⚠️ **The TOTAL row averages ratios.** `J18 = AVERAGE(J6:J17)` and
   `Y18 = AVERAGE(Y6:Y17)` — an unweighted mean over 12 trades, five with a zero
   target — while every other total on that row is a real SUM. The workbook
   prints **3.49%** progress where the aggregate 5 ÷ 103 is **4.85%**.
   `totals()` aggregates; **`legacyTotals()` exists ONLY to render the
   reconciliation note — never report from it.**

### Shape
A **4-level tree**, like drawing-register's: trade › group › sub-group ›
method statement. The three upper levels are **structural rows** (`node_kind`),
not lookup tables, so a level carries its own code and ordering and every
existing grid behaviour works on them. The importer reads the workbook's indent
staircase in **columns J/K/L/M** (title in J = trade, K = group, L = sub-group,
M = the method statement) — by column index, never by fuzzy header matching.

### Importer notes
- Sheet chosen by **how many method statements it yields**, after locating a
  header row containing “Method Statement Title”.
- ⚠️ **Cells read as FORMATTED TEXT (`raw:false` / `cell.w`).** SheetJS returns
  the cell displaying `06-Aug-26` as `2026-08-05T15:59:17Z`, so local getters
  land a day out east of Greenwich — the trap both sibling registers document.
- ⚠️ **`realDate()` rejects anything outside 2015–2100.** The workbook's own
  roll-ups guard with `DATE(1900,1,0)`, Excel's zero date, which is not a date —
  same class as drawing-register's `2000-01-06` sentinel.
- `'balance'` in the HIRAC/QCC/MAS/ISD columns means **outstanding**, so it is
  stored inverted as `*_done = false`. A blank is also treated as outstanding.
- Ball-In and Status are normalised (`engg|eng|engineering → Engg`,
  `approved w/comments → Approved w/ Comments`, `-` → null).

### Verification
- **100/100 automated checks against the real workbook**, loading the **shipped**
  `module.js` and running its own `parseGrid` + `tradeStats` + `totals` (no
  reimplementation): every per-trade TOTAL MS / APP / AWC / DIS / SUBMITTED /
  BALANCE / HIRAC-balance / OPS matches SUMMARY exactly for all 12 trades, plus
  the two grand totals (103 / 5). Decisively, **`legacyTotals()` reproduces the
  workbook's own AVERAGE to six decimals (0.034933)** — which is what proves
  defect 2 is real and not a misreading — and ball-in sums 0+19+5+79 = 103.
- **Browser-verified** (headless Edge against the real `module.css`): Summary
  renders all 12 trades + TOTAL and the reconciliation note; Registry renders the
  4-level tree with 323 items under 119 level rows; **header, every item row and
  every group colspan are all 18 columns**; both frozen columns are really
  `position:sticky`; no page h-scroll.
- ⚠️ **Not verified signed-in**, and **the migration has not been run**. Nobody
  has imported the workbook against the live DB.

### Not built (deliberate)
Drag-reorder, bulk actions, inline cell editing, saved views, per-item file
upload, live collaboration and offline writes — all present in the sibling
registers, none asked for here. The workbook's columns C–I, P, Q, R (the 7-part
code scaffold, Description, Responsible, No. of Sheets) are **entirely empty in
the sample**, so no UI was built around them; `remarks` exists in the table for
when they are used.

## Status
- [x] Read the module guide; chrome copied, not re-invented
- [x] CRUD (add / edit / delete / clear), project-scoped, `created_by` stamped
- [x] `Fmt.esc()` on all user text injected into HTML
- [x] List read keyset-paginated past 1000 rows
- [x] Import + export
- [x] `enabled: true` in `assets/js/config.js`
- [ ] **Migration run on the live DB**
- [ ] Live click-through against a real login
