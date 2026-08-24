# Module: material-submittal

## Top sheets now produce a real PDF, with the submitted document merged under it (2026-08-24) — fmlozano
User: *"Auto Generate and Email Top Sheet MAS & RFA & RFI through App… The RFA and MAS will have a
document attached to it and the topsheet will be placed on top of the document for signature and
approval."* This pass does the **generate + merge** half. Email is separate (Microsoft Graph).

### Why a second output instead of reusing Print
`window.print()` is still here and is still the best route to paper, but **it cannot give the page a
file** — it writes wherever the user chooses and tells the app nothing. Merging a document underneath
the sheet, and later attaching it to mail, both need a Blob. So there are two buttons now:
**Print** (paper, pixel-exact, no library) and **Download PDF** (a Blob this code owns).
- Rasterised with **html2pdf** (html2canvas + jsPDF), the same engine planning-app's Minutes-of-
  Meeting export uses — which is what the user asked to pattern this on. The sheet is a form someone
  signs, so losing selectable text costs nothing; the geometry is what matters and topsheet.css
  already states it in millimetres.
- **pdf-lib** does the page-level merge. Both load beside `topsheet.js` in this module's `index.html`.
- ⚠️ **The capture node is a FRESH `.ts-doc`, never the preview.** `.ts-prev .ts-doc` carries
  `transform: scale(.62)` so the A4 sheet fits beside the form, and html2canvas honours transforms —
  capturing the preview gives you a sheet rendered at 62% inside a full-size page.
- ⚠️ **The holder is parked off-screen; the captured node stays IN NORMAL FLOW inside it.** Putting
  `position:fixed` on the captured element produces a **completely blank PDF** — html2pdf clones the
  node into its own container and measures it there, and an out-of-flow element contributes nothing to
  that container's height, so html2canvas gets a height of zero. Documented at length in
  planning-app's issues-lessons module, which lost real time to exactly this.

### ⚠️ REAL BUG FOUND: the MAS sheet did not fit on A4 — and never had
Measured while checking page counts: the MAS sheet rendered **304.69mm tall against A4's 297mm**, so
it overflowed by 7.69mm onto a near-blank second page. **This was true of the Print path all along**;
it only became visible once the PDF made the page count checkable. RFA and RFI both measure exactly
297mm and were never affected, so this is a **MAS-only overflow** and the fix belongs in `renderMAS`,
not in `.ts-doc`'s shared padding.
- The 8mm came out of the **product-detail free-text box (62mm → 54mm)** — the one block on the form
  that is deliberately empty space, rather than any labelled row or signature band. Re-measured after:
  **210.00 × 297.00mm, zero overflow, no clipped cells, every label and entered value still present.**

### ⚠️ AND a second, separate cause of the blank page: html2pdf's rounding
Even at 296.999mm the export still came out as **two pages**. html2pdf paginates from the rasterised
canvas height converted to mm, and that conversion rounds up. So the page count is now decided by the
**laid-out element's own height** — the ground truth — and html2pdf's surplus pages are deleted off
the jsPDF instance (`.toPdf().get('pdf')` → `deletePage`).
- ⚠️ The 1mm tolerance is rounding slack, **not** a fudge for real overflow: a sheet that genuinely
  runs long still gets its second page. Do not widen it.
- Why this matters more than it sounds: on a merged package that blank sheet lands **between the top
  sheet and the document being approved**, which on a controlled form reads as a missing page.

### Merging, and what cannot be merged
`TopSheet.buildPackage(kind, data, attachments, baseName)` returns
`{file:{name,blob}, separate:[], merged:n, skipped:[]}`.
- ⚠️ **Only PDFs can be merged.** An .xlsx or .docx is not a page stream and nothing in the browser
  can make it one. A non-PDF attachment therefore **rides along as its own file** and the dialog says
  so *before* anything is generated — chosen explicitly with the user over blocking generation or
  standing up a conversion service.
- ⚠️ **A failed attachment fetch does not fail the package.** The sheet is still produced and the
  failure is reported by name in a warning toast, because a top sheet whose document silently didn't
  make it **looks complete**.
- `ignoreEncryption: true` on load — consultants' drawing PDFs are very often print-protected, and
  those copy fine; refusing them would block the common case.
- The MAS sheet gets the row's own attachment (`file_url`, fetched through a 120s signed URL, since
  the bucket is private). **RFA/RFI get none** — they are opened blank from the toolbar with no record
  behind them, so there is nothing to put underneath. That changes when the RFA register lands.
- Filenames are `MAS MAS-0042 SLN101.pdf` — form, id, project — so they are findable in a mail client
  six months later.

### Verification
**16 checks in a real browser** (`ts.html`, `topsheet.js` `eval`'d and driven directly): the output
carries the `%PDF` magic, is **exactly one A4 page** at 595.28×841.89pt, and is >40KB (a blank capture
came out at ~1–2KB, so this pins the out-of-flow regression); a 3-page attachment merges to **4 pages
total**; an .xlsx does **not** become pages while a PDF beside it still merges; an attachment whose
fetch throws lands in `skipped[]` and the sheet is still produced alone; no off-screen holder is left
in the document; and RFA and RFI both export with real content.
- ⚠️ **Not verified signed-in**, and **no screenshot** — this environment's compositor is stalled
  (a long-standing limit noted throughout these files), so the sheet is verified by measured geometry
  and asserted content, not by looking at it.
- Assets `topsheet.js/css?v=20260824a`, `module.js?v=20260824a`.

## Dedicated UI pass — shared type scale, heading drift fixed (2026-08-06) — fmlozano
Part of the two-register UI pass; the Drawing Register's CLAUDE.md carries the full findings. This
module came out of it well — **all 7 pills already passed WCAG AA** (5.52–7.37:1 light,
5.90–7.65:1 dark, re-measured live), and its soft-tint treatment was adopted **as the standard** for
the Drawing Register, whose solid-fill pills were failing 5 of 7.
- **Type scale**: the two modules had grown nine near-identical sizes between them. Both now share
  one six-step scale (`--ms-fs-micro/sm/base/lg/xl/kpi` = 11/12/13/15/20/32), with the same values as
  the Drawing Register so a heading here is the same size as a heading there. ⚠️ The **9.5px chart
  label** — well under a readable floor — is now 11px.
- ⚠️ **Real drift found by measuring, not reading:** the Backlog card emits a bare `<h3>` inside
  `.pd-card ms-tablecard`, which matched **neither** `.ms-card h3` nor `.ms-empty h3` and so rendered
  at the browser default **16.4px** while every other heading in the module was 15px. Card headings
  are one size now.
- Removed the never-emitted `.ms-warn`.
- Verified with a gitignored `_ui_test.html` measuring the real stylesheet in sized iframes at 1440
  in both themes. ⚠️ It carries a **sanity gate** — the first run of the sibling harness reported
  16px/1.00:1 across the board, which is an unloaded stylesheet, not a finding. Assets
  `module.css/js?v=20260806a`.


## Need-by removed — planned vs actual approval only (2026-08-05) — fmlozano
Mirrors the Drawing Register (see its CLAUDE.md for the full reasoning). The Project Schedule already
connects to this log through the **Design Development POC roll-up**, so the per-document link to an
Execution Phase activity was a second, redundant connection.

Removed the Registry (log) column, the Backlog column, the Add/Edit "Schedule link" section, the
activity picker, and every derivation behind them (`needByCell`, `requiredApprovalOf`, `needByOf`,
`leadOf`, `docFloatOf`, `minusDays`, `isExecutionAct`, `linkIsBackwards`, `schedPickerHTML`,
`wireSchedPicker`, `schedMatches`, `loadSchedule`, `ensureSchedule`, the schedule caches,
`LEAD_DEFAULT`, `SCHED_PICK_MAX`) plus their CSS.
- **`agingDays()` / `backlogUrgency()` / the Backlog "late" KPI now use `plan_approval_date`.**
- ⚠️ **`SPAN = HEAD.length`** already drove every group-row and empty-state colspan, so dropping the
  header entry re-aligned the whole table by itself — the reason this module needed no colspan edits.
- ⚠️ DB columns left in place (0 linked submittals on any live project); dropping them would be
  destructive for no gain.
- ⚠️ **Follow-up cleanup (2026-08-05c) — a dead tolerant-retry left a REAL runtime bug.** The save
  path kept its "strip the schedule-link columns and retry" block plus
  `if (schedWarn) UI.toast(…)`. Removing the retry left **`schedWarn` undefined while the `if` still
  referenced it**, so every modal save would have thrown a `ReferenceError` *after* the row was
  written — the save lands, the UI reports failure. **`node --check` passes on this** (it is a
  runtime, not a syntax, error); it was caught by grepping for the symbol after the edit, not by the
  parser. Both are now gone, along with the stale "Project Schedule link" comment block.
- Verified: `node --check`, CSS braces/comments balanced, 0 leftover references, no orphan `async`,
  and the 116-check suite (40 sheets + 35 cols + 14 collapse + 27 DD) green against the shipped
  source. Deployed build confirmed free of every removed symbol. Assets `module.js?v=20260805c`
  (css `?v=20260805b`).

## Need-by scoped to Execution Phase (2026-08-05) — fmlozano
Mirrors the Drawing Register change (see its CLAUDE.md for the full rationale). A material submittal
is a **prerequisite for construction**, so the activity it points at should sit under **Execution
Phase**; Design Development is the opposite relationship and is now rolled up FROM this log
automatically by the Project Schedule, with no link needed.
- `loadSchedule()` locates the Execution Phase branch before dropping the WBS Summary rows;
  `isExecutionAct()` / `linkIsBackwards()` judge each link.
- A submittal linked to a non-Execution activity shows an amber **"✕ Not execution"** chip instead of
  the date — the date such a link computes is real-looking and meaningless ("approve this 45 days
  before the activity that produces it starts").
- The picker still offers every activity (**warn but allow**) with non-Execution rows tagged.
- ⚠️ Boundary-safe prefix match (`4.` does not match `40.1`), and **silent when it cannot tell** — a
  schedule with no Execution Phase node flags nothing rather than warning on every row.
- Verified as part of the 36/36 shipped-function harness described in the Drawing Register entry.
  ⚠️ Not verified signed-in. Assets `module.css/js?v=20260805a`.

> **Claude / developer: read this first.**
> 1. Read `../../MODULE_CONTRACT.md` and `../../CONTRIBUTING.md` (NOT auto-loaded).
> 2. This module is **Material Submittal Log**. DB table `material_submittal`.
> 3. Chrome (topbar/tabs/tools/filter bar) is copied from **drawing-register** — do not re-invent it.
> 4. Update this file as you build.

## UI review carry-over: loading skeleton + icon row actions (2026-08-04) — fmlozano
Drawing Register got a 4-item UI pass; **only two of the four applied here** — this module already
had the other two, which is worth knowing before "porting" them again:
- **Already had it:** the search box is **already debounced** (160ms, `ms-f-search`) and the
  **ghost clear-filters button already exists** (`#ms-f-clear` / `.ms-clearfilt`). Drawing Register
  was in fact copied *from* this module's pattern, not the reverse.
- **Loading skeleton** — the bare `<span class="ms-spin"></span>Loading…` card is now
  `skeletonHTML()`: spinner + 9 shimmer rows (`.ms-sk*`, same markup/classes as `.dr-sk*`).
- **Text glyphs → inline SVG:** the row actions were `&#9998;` (✎) and `&times;` (×) on plain
  `.pd-btn`s; now `ico('pencil')` / `ico('trash')` on `.ms-iconbtn` / `.ms-iconbtn-del`. ⚠️ Uses
  `Icons.svg` inline rather than `data-ico` — this module *does* call `Icons.hydrate(host)` after
  `renderLog`, but embedding the SVG removes the dependency on that call surviving future edits.
  The Doc column's `data-ico="eye"` is left as-is (it's hydrated and working).
- **`icons.js` gained `pencil`** (it had none) → `icons.js?v=20260724a → 20260804a` across all 17
  HTML files.
- **Verified in-browser** (gitignored `_ui_test.html` on the real `module.css` + `icons.js`, deleted
  after): skeleton 9 rows / 11px bars / 13×13 spinner / 330px card; both row buttons emit a 15×15
  SVG in a 29×25 box, so the pair still fits `.ms-actcol`'s 76px; no console errors. ⚠️ The harness's
  261px page overflow is a **harness artifact** — `.ms-table` is `min-width:1500px` and the harness
  omitted the scroll wrapper `renderLog` actually uses (confirmed by reading back the computed
  `min-width`). Screenshots impossible here (stalled compositor). **Not verified signed-in.**
- Assets `module.css?v=20260804a` / `module.js?v=20260804a`.

## Brought to parity with drawing-register: Backlog Doc+bulk (#8), Registry sort (#3), drillable Overview (#7) (2026-08-04) — fmlozano
The previous entry noted #3/#7 weren't ported here; they are now, along with #8, so both registers
behave the same way.
- **#8 Backlog Doc column + bulk actions.** Eye → `viewFile`; checkbox column + "select all shown" +
  the log's own bulk bar (same ids, so `bulkStatus`/`bulkDelete` are reused — both already end in the
  **view-aware `render()`**, not `renderLog()`, so they work from the Backlog unchanged).
  ⚠️ Select-all iterates **`shown`**, not `list`, so it can't act on rows behind the 200-row page cap.
  ⚠️ The Doc button and checkboxes `stopPropagation()` — the row click opens the editor.
  ⚠️ `bulkDelete`/`bulkStatus` and the "N selected" count are all **unfiltered** here (unlike
  drawing-register's, which scope by `visibleIds`), so this module is already self-consistent — the bar
  reports exactly what the action will touch. Left as-is deliberately; **selection is now cleared in
  `switchTab`** so it can't span two different lists.
- **#3 Sortable Registry columns.** All 17 data columns via `logSort`/`LOG_SORTABLE`/`logTh`, cycling
  asc → desc → natural. ⚠️ **Sorting is applied inside each trade-section group** (`logSortList(g)`) —
  the section grouping is how this register and its source workbook are structured. Blanks sort last in
  both directions. A red "Sorted by X ▲ ×" chip restores the natural order (this module has no
  drag-reorder, so the chip is purely an undo). Doc / checkbox / actions stay non-sortable.
- **#7 Drillable Overview.** Donut legend rows and the status table → Registry by status; the S-curve's
  discipline rows → Registry by discipline; aging segments + legend and the unlinked-items count →
  Backlog by bucket; Total submittals → Registry; Overdue → Backlog with the overdue-only filter.
  ⚠️ **"Approved" and "Pending approval" are deliberately NOT drillable** — `kpis()` aggregates each
  over several statuses, so no single filter value reproduces them and the destination count wouldn't
  match the card. Zero-count legend/table rows aren't links either (nothing to show).
  New **`agingBucketOf()`** is the single source of truth for both the chart and the drill filter.
  New Backlog-only **`bkAging`** filter with a removable chip — including on the empty state, or a
  drill that matches nothing would be a dead end with no visible cause.
  ⚠️ `drillTo`'s select-setter **adds a missing option**, since a `<select>` silently ignores an
  unmatched value and the filter would apply while the control still read "All statuses".
- **Group carets are now SVG chevrons** (`ico('chevronDown')` + `.ms-caret-col` rotation) instead of the
  `&#9656;`/`&#9662;` text glyphs — finishing the icon pass for this module.
- **Verified: 68/68 in a Node harness** over the real extracted source — sort semantics (case,
  blanks-last both ways, no caller mutation, 3-click cycle, unknown-column guard), **every
  `LOG_SORTABLE` key actually handled by `logSortVal` and every one actually rendered in `HEAD`** (a
  mismatch would silently sort by nothing), all aging boundaries (60/30/0), select-all scoped to
  `shown`, propagation stops, 9-column head/body agreement, and state reset on tab/project change.
  **In-browser** against the real chrome + `module.css`: sorted header red with red indicator,
  `user-select:none`, **both frozen columns still `position:sticky`** now that headers are buttons,
  caret rotates when collapsed, drill targets have `cursor:pointer` + `role=button` while zero-count
  rows have neither, Doc 14×14 in a 47px column, 0 page h-scroll, no console errors.
  ⚠️ **Not verified signed-in**; screenshots impossible here.
- Assets `module.css?v=20260804c` / `module.js?v=20260804c`.

## Pagination FIXED + viewport fit + a real date bug (2026-08-04) — fmlozano
- **`load()` is now keyset-paginated** — closes the truncation bug flagged below (that section is kept
  for the history but is **no longer outstanding**). ⚠️ Paginates by **`id`**, not `sort_order`:
  `sort_order` is nullable and non-unique, so it cannot drive a keyset cursor. The in-memory
  `sort_order` → `seq_no` → `material` sort that restores display order is unchanged.
  Verified by simulating the loop: 2,300 rows load in 3 round-trips with no duplicates, exactly 1,000
  terminates (no infinite loop), and an empty table terminates.
- **⚠️ REAL BUG FIXED — `minusDays()` was one day early in Manila.** It built a **local** date
  (`new Date(iso+'T00:00:00')` + `setDate`) and read it back with **`isoUTC()`**, so east of Greenwich
  every result was off by a day: `minusDays('2026-03-31', 0)` returned `2026-03-30`, and subtracting
  zero days must be the identity. Since `requiredApprovalOf()` = `minusDays(needBy, lead)`, **every
  schedule-linked required-approval date was a day early**, feeding the Need-by column, the float chip,
  `agingDays()` and the Backlog urgency sort. Now pure `Date.UTC` arithmetic. This is exactly the
  local-vs-UTC trap this module's own importer notes warn about — it had just been reintroduced in the
  schedule-link helper. **Drawing Register had the identical bug and is fixed the same way.**
- **Registry fills the viewport** (`body.ms-fit`, set by `render()` on the log view only) instead of
  `max-height:calc(100vh - 250px)`, which hardcoded a chrome height that the wrapping topbar invalidated.
  ⚠️ Gated `@media (min-width:701px)` so the phone breakpoint keeps page scrolling. **Measured via
  per-width iframes: clamped to the viewport with 0 page scroll at 768 and 1280 (card ends 16/22px
  inside), correctly NOT clamped at 375 (page scrolls normally); `.ms-fz1` stays `position:sticky` at
  all three widths.** The Backlog also uses `.ms-tablecard` and is deliberately untouched by the fit
  block.
- Sortable-column and drill-through work (Drawing Register's UI review #3/#7) was **not** ported here —
  this module's Registry groups by trade section with its own KPI/donut/S-curve set, so it wants its own
  pass rather than a mechanical copy.
- Assets `module.css?v=20260804b` / `module.js?v=20260804b`.

## ⚠️ Known latent bug — `load()` is NOT paginated (FIXED 2026-08-04, see above)
`load()` does a single `.select('*').order('sort_order')` with no keyset loop, and **Supabase caps a
select at 1000 rows** — so a project with >1000 submittals silently loads a truncated log (every KPI,
donut, S-curve and total then under-reports with no error). This is the exact class of bug the
2026-07-21 audit fixed in `project_schedule`, `drawing_register` and `progress_photos`; this table
was missed. Not hit yet in practice (the largest real workbook is 143 rows), so it's latent, not
active. Fix = copy drawing-register's keyset loop (`order id.asc`, `.gt('id', last)`, `limit 1000`),
then re-apply the in-memory `sort_order`/`seq_no`/`material` sort it already does.

## Searchable schedule-activity picker (2026-08-03) — fmlozano
Replaced the Activity (need-by) `<input list>` + `<datalist>` with a real searchable dropdown.
- ⚠️ **A datalist physically cannot search by name.** Browsers filter datalist options by the option's
  **`value`**, which must be the `activity_id` we store — the activity name lived only in the display
  text, so typing it matched nothing. This is why it had to be rebuilt rather than tweaked.
- `schedPickerHTML()` renders a search box + hidden `#ms-f-sact` (the stored id) + a selection chip
  (`ID — Name`, with a clear ×). `wireSchedPicker()` handles input/focus/Enter(first match)/Esc/
  outside-click. `schedMatches()` = whitespace-separated **AND** matching over `activity_id + " " +
  activity_name`, lowercased; capped at `SCHED_PICK_MAX` (60) rows/query because schedules reach 40k
  activities, with a "keep typing to narrow" hint when the cap is hit.
- **Lazy-load handling:** the schedule loads after the register, so a form opened early showed a stale
  "not in this project's schedule" warning forever. A capped poller (60 × 500ms, cleared by a wrapped
  `m.close`) refreshes the chip + derived date once `schedPid === pid`.
- Verified `schedMatches()` in a Node harness (by-ID, by-name, multi-term AND, case-insensitivity,
  no-match, cap) + `node --check` + CSS brace-balance. **Not browser-verified.**
- Assets `module.css?v=20260803h` / `module.js?v=20260803i`.

## Chart.js adoption (2026-08-03) — fmlozano
Ported from Drawing Register:
- **Chart.js 4.4.1 + chartjs-plugin-datalabels (CDN)** replaces the hand-rolled SVG period chart,
  reverting the `preserveAspectRatio="none"` change that was distorting the chart's contents. Native
  `interaction:{mode:'index'}` tooltips now match the Procurement dashboard's behaviour, because that
  app was using Chart.js all along. `periodChartSVG`/`wirePeriodHover` deleted. `.ms-pc-wrap` keeps an
  explicit height (Chart.js `maintainAspectRatio:false` needs a sized parent).
- **`#`/`%` is one switching button** (`.ms-segswitch`).
- Assets `module.css?v=20260803g` / `module.js?v=20260803h` + 2 CDN script tags. Verified
  `node --check`, CSS brace-balance, 0 stale refs. **Not browser-verified.**
- Per-revision file uploads were **not** ported here — this module's model is deliberately one
  document per submittal (see the 2026-07-20 entry below); a revision-by-revision file set is a
  drawing-register concept.

## Period chart overhaul: PowerBI hover, actual bars, %/# toggle (2026-08-03) — fmlozano
Ported the same fixes made to Drawing Register:
- **Real bug fixed:** `preserveAspectRatio="none"` added — without it the chart's fixed-aspect viewBox
  was letterboxed inside its wider card instead of filling it (browser default `xMidYMid meet`).
- **PowerBI-style hover** (`wirePeriodHover`) replacing the plain `<title>` tooltip.
- **Actual-this-period bars** grouped beside the existing Planned bars.
- **Data labels** above bars when ≤20 periods.
- **`periodValueMode` (# / %) toggle**, `periodScaled()` rescaling to % of `rows.length`.
- **Legend centered.**
- **KPI accent softened** to neutral by default (`.ms-kpi.good/.warn/.bad::before` now carry the
  color; plain cards don't).
- No `align-items` fix needed here — `.ms-grid2` already had `align-items:start`.
- Assets `module.css?v=20260803f` / `module.js?v=20260803g`. Verified `node --check` + CSS
  brace-balance. **Not browser-verified.**

## KPI card polish + chart readability pass (2026-08-03) — fmlozano
Ported the same design pass applied to Drawing Register after the user's live-review feedback:
- **KPI cards:** `.ms-kpis` minmax floor raised 150→170px, gap 12→18px, card padding 12/14→20/22px,
  value font 24→32px, `box-shadow` + hover lift, thicker 4px accent bar.
- **Aging bar:** proportional bar now built only from `AGING_DATED` items (excludes "No due date"),
  with the undated count reported as a separate line instead of dominating the bar.
- **Period chart:** taller (220→280px), rounded bars, gradient area fill under Cumulative Planned,
  point markers, dashed gridlines, planned line recolored `currentColor`→`var(--pd-ink)`.
- Assets `module.css?v=20260803e` / `module.js?v=20260803f`. Verified `node --check`. **Not
  browser-verified** — visual-design pass, mirrored from Drawing Register's user-reviewed changes.

## Live UI review fixes: Backlog scroll containment, sentinel-date guard, KPI sections (2026-08-03) — fmlozano
Applied the same fixes made to Drawing Register after a live review (Bauhinia's Backlog had a very
long scroll with 1,010 open items):
- **Backlog scroll containment + paging** — `.ms-bk-scroll` (`max-height:min(62vh,640px)`) plus a
  200-row page (`BK_PAGE`/`bkShowAll`, "show all"/"collapse" toggle), same pattern as Drawing Register.
- **Sentinel-date guard** in `periodKeyOf()`/`agingDays()` — discards any `plan_approval_date`/
  `date_approved` outside 2015–2100 (the bug was confirmed on Drawing Register's live data; applied
  here pre-emptively since this module reads the same class of legacy-import date fields).
- **`kpiSection()`** — "Log Overview" / "Backlog Overview" eyebrow labels above each KPI row.
- Assets `module.css?v=20260803d` / `module.js?v=20260803e`. Verified `node --check`. **Not
  browser-verified against this module's own live data** (the sentinel-date bug was only directly
  observed on Drawing Register).

## Overview: Aging bar + Period chart (2026-08-03) — fmlozano
User asked for the same Aging-bar + Period-chart treatment given to Drawing Register. This module's
Overview already had a cumulative-only "S-curve" card from its original 2026-07-20 build — the new
Period chart is **additional**, not a replacement (bar+cumulative-line view of per-period volume,
vs the existing pure cumulative-trend curve).
- **`agingBuckets()`/`agingBarSVG()`** — stacked bar over ALL open (`!isApproved`) submittals project-
  wide (unfiltered), bucketed by the `agingDays()` helper added for the Backlog Aging column.
- **`periodBuckets()`/`periodChartSVG()`** — bar+line chart grouped by `plan_approval_date`/
  `date_approved`, Monthly/Quarterly toggle (`periodMode`, `.ms-seg` buttons).
- Both inserted into `renderDashboard()` after the existing status/S-curve `ms-grid2` row. New CSS:
  `.ms-seg`/`.ms-seg-btn`.
- Assets `module.css?v=20260803c` / `module.js?v=20260803d`. Verified `node --check`. **Not
  browser-verified** (auth wall).

## Pattern the WPM Backlog look further: Aging column + sortable headers (2026-08-03) — fmlozano
Follow-up after the tabs below: user pointed at the live WPM (Procurement) project view and asked to
match its Backlog table more closely. This module's Overview already had a status donut from its
original build (`donutSVG`/`statusColor`), so only the Backlog table needed work.
- **`agingDays(r)`**: `today − requiredApprovalOf(r)` (falls back to `plan_approval_date` when
  unlinked) — positive = N days overdue, negative = N days to go, same convention as WPM's Aging(d).
  Added as a 7th Backlog column.
- **Sortable Backlog headers** (`bkSort`/`BK_COLS`/`bkSortVal`/`bkSetSort`): click a header to sort by
  it, click again to flip direction. Default unchanged (most urgent first, via `backlogUrgency`).
- Assets `module.css?v=20260803b` / `module.js?v=20260803c`. Verified `node --check`. **Not
  browser-verified** (auth wall).

## Overview / Backlog / Registry tabs — procurement-style project view (2026-08-03) — fmlozano
Restructured the topbar from Dashboard/Log into three tabs matching the Procurement (WPM)
project-view pattern: **Overview | Backlog | Registry**.
- **Overview** = the existing Dashboard (`renderDashboard`), unchanged. **Registry** = the existing
  Material Submittal Log (`renderLog`), unchanged — "the current page folded into the Registry tab."
- **Backlog** (new): `backlogRows()` = submittals not `isApproved`; sorted by `backlogUrgency()`
  (the existing schedule-link `docFloatOf()` when linked, else `isOverdue()`/status). KPIs (open
  items / overdue / late vs need-by / rejected) + a table (Code/Item/Section/Discipline/Status
  pill/Need-by chip); row click opens the existing `openForm(r)` modal. Reuses `kpi`/`statusMeta`/
  `needByCell` — no new visual language. `ensureSchedule()`'s post-load re-render now also fires on
  `view==='backlog'` (previously only `'log'`), so the Need-by column is live-populated there too.
  Internal `view` values are unchanged (`'dashboard'`/`'log'`/new `'backlog'`) — only the tab labels
  changed, so nothing else that reads `view` needed touching.
- No DB/migration change. Assets `module.css/js?v=20260803a`. Verified `node --check` + confirmed
  all called helpers exist. **Not browser-verified** (auth wall).

## Live collaboration + offline editing (Phase 1 & 2) (2026-07-26) — fmlozano
Wired the shared **PDCollab** (Realtime) + **PDSync** (offline outbox) layers. This module is
**modal-edit** (no inline cells), so cursors are **row-level**.
- **Phase 1 (presence + live rows + row cursor):** `joinCollab()` on load / project switch
  (`key = material_submittal:<pid>`). Topbar avatars (`#ms-presence`). `openForm(r)` broadcasts
  "editing this submittal"; every close path (×/Cancel/Save) clears it. `paintRemote()` (called at the
  end of `render()`) flags the `tr[data-id]` row (its `.ms-fz2` item cell) of whoever has it open.
  `applyRemoteChange` patches `rows` from postgres_changes (INSERT/UPDATE/DELETE) + re-renders.
- **Phase 2 (offline):** **`bulkStatus`** is offline-capable — it queues one `PDSync.write` update per
  selected id (field-level LWW, syncs on reconnect) and refreshes the cache. **Read-offline:** `load()`
  caches rows (`ms:<pid>`) and renders from cache on an offline fetch; modal save + bulkStatus refresh it.
  ⚠️ **Scope:** the **modal Add/Edit stays online-only** (it does file upload + a tolerant schema-strip
  retry that the outbox can't replicate), as do **delete / import / clear**. Offline covers **bulk status
  + read**. Follow-up could route no-file modal updates through PDSync.
- **Migration `../../migrations/2026-07-26-realtime-collab-material-submittal.sql` (USER MUST RUN)** —
  adds `material_submittal` to `supabase_realtime` + `replica identity full`. Presence/cursors/offline
  work without it; only the live-value stream needs it.
- Verified: `node --check`. NOT browser-verified (needs 2 sessions + an offline cycle). Assets: new
  `offline.js?v=20260726d` + `collab.js?v=20260726c`; `module.js?v=20260726a`.

## Project Schedule link — Need-by column + auto-derived plan approval (2026-07-25)
Same feature as the drawing-register's, applied here (a submittal is a prerequisite for construction:
the linked activity's **start** is the need-by date; (start − `lead_days`) is the required approval
date — procurement + delivery lead, so `LEAD_DEFAULT` = **45** vs drawings' 30).
- **Migration `../../migrations/2026-07-25-schedule-document-links.sql` (USER MUST RUN)** — adds
  `schedule_activity_id` (→ `project_schedule.activity_id`, survives re-import), `schedule_wbs`,
  `lead_days` on `material_submittal`.
- **Schedule cache** (`ensureSchedule`/`loadSchedule`) keyset-loads leaf activities lazily after the
  log loads, then re-renders. **New "Need-by" column** (`needByCell`) in the log table with the
  required-approval date + a float chip (green/amber/red) vs the actual-or-plan approval date; the
  column count is driven by the `HEAD` array, so group rows + empty-state colspans update automatically.
- **Add/Edit form — "Schedule link" section:** activity datalist (`schedOptions`), lead days, a
  read-only required-approval preview, and a "set as Plan approval" checkbox. Saved via a **tolerant
  write** (strips the fields + warns if the migration isn't run).
- Verified: `node --check` passes. Not yet browser-verified (auth wall). Assets `?v=20260725a`.

## Built 2026-07-20 — Dashboard + Material Submittal Log (from the PMO workbook)
Built against **“EPC. PMO. Material Submittal List Dashboard. 2025 01 25.xlsx”** (Modan Loft
Ortigas Hills). All 14 sheets were surveyed; `Material submittal log`, `Dashboard`, `Library`
and `Coding Reference` are the ones that define behaviour. Two screens, matching the ask:
**Dashboard** and **Material Submittal Log**.

### The log sheet is not a flat table (importer notes)
- **3-tier merged header** on sheet rows 10/11/12 — row 10 is the main header, row 11 sub-heads
  the 7-part *Material Submittal Number*, row 12 sub-heads *Approver* (Consultant/Client).
  Several headers repeat (**“Floor Levels” appears twice**), so the importer reads **by column
  index** off the located header row, never by fuzzy header matching.
- The body is broken up by **23 single-cell TRADE SECTION rows** (GENERAL REQUIREMENT, SITEWORKS,
  REBAR, …) which own the rows beneath them → `trade_section`.
- **Stop at the sign-off block.** Rows below “PREPARED AND CHECKED BY:” / “REVIEWED BY:” are names
  and job titles; without an explicit stop they import as submittals (“Project Manager” etc.).
- **A row is a submittal when it has substance, not merely an Item.** Sheet row 33 has a full code,
  dates and a status but a blank Item — requiring an Item silently dropped it and put the status
  total one under the workbook’s own COUNTIF. Its item stays `null` and renders “(untitled)”.
- ⚠️ **Dates: never read a spreadsheet Date with LOCAL getters.** SheetJS returns the cell
  displaying `18-Mar-24` as `2024-03-17T15:59:17Z`, so local getters give the 17th or the 18th
  depending on the browser’s timezone. The importer reads cells as **formatted text**
  (`raw:false`) so the normal path is the literal `"18-Mar-24"` string parsed with integer maths;
  `parseDate` is UTC-only elsewhere and rounds a Date to the nearest UTC day. It also duck-types
  (`typeof v.getTime`) rather than `instanceof Date`, which fails across realms.

### Dashboard maths — the workbook’s formulas are the spec
Read off its own cells, not guessed:
- status table = `COUNTIF(Status, …)` → **blank status is not counted** (its total read 107, not 146).
- `PLANNED` curve = `COUNTIFS(PlannedApproval within month, TradeCategory=<code>)`
- `ACTUAL`  curve = `COUNTIFS(ActualApproval  within month, TradeCategory=<code>)`
- i.e. **the S-curve is driven by the APPROVAL date pair, not submission** — despite the workbook
  labelling its own summary rows “Planned/Actual Submission”. Named ranges resolve to
  `U` (plan approval), `V` (actual approval) and `I` (**Trades**, not the Discipline column).

### TWO DEFECTS in the workbook — reproduced, proven, then fixed (owner decision: fix + show both)
1. **`TradeCategory` pointed at the redundant “Trades” column**, blank on **40** submittals — its
   chart silently dropped them.
2. **Its OVERALL row summed EIGHT discipline rows but listed “ST” twice**, double-counting
   Structural.

At the workbook’s own cutoff (Jan-2025) the legacy reproduction lands **exactly** on its printed
`97 / 29`, while the corrected maths gives `128 / 27` — so the old chart *under*-reported planned
by 31 despite the double count (the dropped rows outweighed it). This module groups by
**`discipline`** (always populated) and counts each discipline **once**. `legacyScurve()` exists
**only** to render the reconciliation note on the dashboard — never report from it, and never
group new work by `trade_code`.

### Screens
- **Dashboard** — 6 KPI tiles; the workbook’s Status / No. / Wt % block (reproduces its printed
  percentages to the decimal); an approval donut; a cumulative planned-vs-actual **S-curve** with a
  per-discipline breakdown; and the amber reconciliation note explaining the difference from the Excel.
- **Log** — grouped by trade section (collapsible, per-group approved count), frozen
  Submittal-No + Item columns, status pills, overdue flagging, filters (search / section /
  discipline / status / presentation / overdue-only), bulk status + bulk delete, Add/Edit modal
  with a **live 7-part code preview**, Excel import/export, print, admin-only Clear.

### Migration — USER MUST RUN
`../../migrations/2026-07-20-material-submittal-full.sql` (idempotent). Adds the 7 code parts,
`trade_section`, `discipline`, `trade_code`, `floor_levels`, `location`, `reference_document`,
`brand`, `type_presentation`, `plan_submission_date`, `plan_approval_date`, `approver_consultant`,
`approver_client`, `revision_no`, `mas_id`, `seq_no`, `sort_order` + 3 indexes. Existing starter
columns are **reused** for their natural match (no dead duplicates): `material`=Item,
`specification`, `supplier`=Vendor, `status`, `remarks`, `date_required`=Required Date Baseline,
`date_submitted`=Actual Submission, `date_approved`=Actual Approval, `submittal_no`=composed code.
Until it is run, load/import fail with an explicit “run the migration” message rather than a raw
Postgres error.

### Verification
- **54/54 automated checks against the real workbook**, loading the shipped `module.js` itself (no
  reimplementation): date parsing, status/presentation normalisation, 143 records, 23 sections,
  every date ISO, every status/presentation in vocabulary, and — decisively — the **status table
  matching the workbook’s COUNTIF block exactly** (9/11/2/3/0/14/68, total **107**) and the
  **legacy S-curve reproducing its printed 97 / 29**.
- **Browser-verified** against real imported data: dashboard renders (status weights match the
  sheet’s printed 8.41 %/10.28 %/…/63.55 %), donut, S-curve, 143 rows in 21 populated sections,
  frozen columns actually `position:sticky`, dark mode flips on tokens, frozen cells stay opaque
  in both themes, no page h-scroll, all filters + collapse + selection + bulk bar + modal code
  preview work, no console errors.
- ⚠️ **Environment caveat — do not trust computed styles after a dynamic class change here.** The
  compositor is stalled (screenshots time out): flipping `.active` updates the DOM but
  `getComputedStyle` keeps returning the pre-change value even after forcing layout, which reads as
  “inverted tab colours”. Verified the CSS is correct by measuring a **freshly created** element
  (`.active` = brand red on white text). Measure fresh nodes, or initial paint, only.

## 2026-07-20 (c) — Top bar wasn't uniform (missing shared chrome)
Owner reported the top bar didn't match the suite, specifically the buttons beside the profile icon.
**Same defect as the 2026-07-17 Progress Photos pass:** this module was missing the three shared
topbar rules every uniform module carries, so it inherited `dashboard.css`'s `.pd-topbar { gap:14px }`
with **no `flex-wrap`**, the avatar had **no left divider**, and theme.js's injected toggle kept its
default size instead of matching the 34×34 tool buttons.
- Fixed by copying the block **verbatim** from `drawing-register/module.css` (see the top of
  `module.css`). ⚠️ **Do not drop it when copying this module** — the comment there says what breaks.
- **Verified by computed-style diff against the real drawing-register** (its stylesheet + real topbar
  markup inlined into an iframe, theme toggle injected to match runtime), with a **sanity assertion
  that the reference CSS actually loaded first** — that omission is what invalidated the first
  Progress Photos attempt. Zero differences on every chrome element.
- **Geometry is pixel-identical** to drawing-register: tool cluster right edge **1179px**, theme
  toggle left **1193px**, profile divider left **1247px**. The only residual property diffs were
  selector artifacts (drawing-register has a *labeled* "+ Level" button this module doesn't) and
  `margin-left:auto` resolving differently because left-hand content widths differ — the right edge,
  which is what "beside the profile icon" means, matches exactly.
- No horizontal overflow at 1280/1100/900/700/420px; profile + theme controls visible at every width.

## 2026-07-20 (b) — Document attachments wired up
Uses the existing **private** `material-submittal` bucket (2026-06-18 storage migration) and the
existing `file_url` column — **no new migration**. Follows drawing-register’s pattern.
- **One document per submittal, deliberately.** The log’s own model already carries a single
  *Type of Presentation* per row (brochure / test results / sample board …), and a submittal needing
  two document types is two rows in the workbook. Multi-file would need a new `files jsonb` column.
- `file_url` stores the object **PATH, not a URL**. The bucket is private, so the URL is signed on
  demand (`createSignedUrl`, 60 s) and opened in a new tab — a stored URL would expire and be useless.
  Uploads are namespaced `<project>/<timestamp>_<sanitised name>`; the display strips the timestamp.
- **Order of operations matters** (all verified against failure injection):
  - Upload happens **before** the row write, so a failed upload never leaves a row pointing at a
    missing object — nothing is written and the dialog stays open for a retry.
  - If the row write then fails, the just-uploaded object is **rolled back**, so a DB error can’t
    orphan a file in the bucket.
  - On replace, the superseded object is deleted **only after** the row successfully points at the
    new one.
  - Clicking **×** on an attachment is **deferred to Save** — cancelling the dialog must never
    delete a document.
  - Row delete, bulk delete, Clear all, and import-with-Replace all remove their objects. Bulk paths
    are captured **before** the rows leave `rows`, or they'd be unrecoverable. Object deletion is
    best-effort: a storage hiccup must never block the row delete.
- **Grid gained a “Doc” column** (eye button → signed URL). `icons.js` has no `paperclip` and is a
  shared asset the contract forbids editing, so it reuses `eye` — no global `?v=` bump needed.
- ⚠️ The header array is now the **single source of truth for the column count** (`SPAN`); the group
  rows and empty state span it. The previous hardcoded `COLS + 3` would have silently skewed the
  table the moment a column was added — which is exactly what adding “Doc” did.
- Export gained a **Document** column (filename only — a link would be dead once the signed URL
  expires). Print hides the Doc column.
- **Verified in a browser harness with a storage stub** (real module files, failure injection):
  new-with-file, replace (old object removed), remove-then-save, **cancel-after-× keeps the file**,
  upload failure writes no row, row-write failure rolls the object back, single + bulk delete remove
  their objects, signed URL requested at 60 s and opened, header/body/colspan all 19, no console
  errors. **Note:** a first run reported the rollback failing — that was the *stub* returning a bare
  Promise from `insert()` so `.select()` threw; with a faithful stub it passes. Model the client's
  chaining accurately or you'll chase phantom bugs.

### Notes / follow-ups
- **Overdue reads high (117/143) on this file** — correct, not a bug: the workbook is an 18-month-old
  snapshot, so nearly every unapproved item is past its planned approval date. Live data won’t do this.
- Search deliberately includes `trade_section`/`discipline`: no item text contains “rebar”, so
  without it the most natural query returns nothing.
- Not built: multi-file per submittal (needs a `files jsonb` column), revision history per submittal
  (only a `revision_no` field), and per-project coding vocabularies (the code dropdowns use the
  workbook’s Coding Reference as a fixed list).
- **Storage delete widened to planners (2026-07-20) — migration
  `../../migrations/2026-07-20-material-submittal-storage-delete.sql`, USER MUST RUN.** The
  2026-06-18 rule was `owner = auth.uid() or is_admin()`, so a planner deleting a submittal they
  didn't upload removed the row but orphaned its file. Now `owner = auth.uid() or is_planner()`.
  ⚠️ The **`owner` branch is kept deliberately**: the bucket's INSERT policy is `is_approved()`, so
  any approved user can upload — replacing it with `is_planner()` alone would remove a `user`-role
  uploader's ability to delete their own file, i.e. a narrowing. `is_planner()` already includes
  admin/super_admin, so the old `is_admin()` branch is subsumed. Purely additive: nobody loses access.
  ⚠️ In `supabase-setup.sql` this override **must sit after `is_planner()` is defined** (line ~342),
  not in the storage section (~line 278) — a policy's USING expression is parsed at creation, so
  referencing the function earlier fails on a fresh run.
- **`drawing-register` and `progress-photos` still carry the original owner-or-admin rule** and have
  the same orphaning behaviour. Deliberately left alone (only material-submittal was asked for); the
  migration widens them by adding them to its one array.

## Status
- [x] Read MODULE_CONTRACT.md + CONTRIBUTING.md
- [x] Chrome copied from drawing-register (not re-invented)
- [x] CRUD implemented (add / edit / list / delete / bulk)
- [x] Project-scoped via `pd_project`; `created_by` + `project_id` stamped
- [x] `Fmt.esc()` on all user text injected into HTML
- [x] `enabled: true` set in `assets/js/config.js`
- [x] Document upload / view / replace / remove (private bucket + signed URLs)
- [x] Migration run on the live DB (owner confirmed 2026-07-20)
- [ ] Live click-through against a real login

## Top sheets: MAS / RFA / RFI generated to PDF (2026-08-12) — fmlozano
Three PMO controlled forms are now generated from the app and printed via the browser's own
"Save as PDF". Shared renderer in `../../assets/js/topsheet.js` + `../../assets/css/topsheet.css`;
per-project header defaults in migration `../../migrations/0012-topsheet-defaults.sql` **(USER MUST
RUN)**.
- **They are THREE DIFFERENT DOCUMENTS, not one parameterised form.** F-GEN013 MAS covers a
  material submission, F-GEN011 RFA an approval request for *documents*, F-GEN010 RFI a question to
  the design consultant — the RFA template says in its own body that it must not be used for a
  material submittal. Hence three renderers and three field lists.
- **Only MAS is generated FROM a record** (Registry row → "Form" column), because every MAS field
  maps onto a column of this table: `mas_id`/`codeOf` → MAS ID, `material` → Product Name,
  `brand + supplier` → Manufacturer/Supplier, `specification` → Spec/BOQ Ref, `location +
  floor_levels` → Location/Use, `trade_section` → Category, `discipline` → Sub-category,
  `file_url` → Attachment included?. **RFA/RFI have no register here yet**, so their topbar buttons
  open a blank sheet seeded with project context only.
- **Layout is transcribed from the workbooks, not approximated.** Each form is the template's own
  9-column A–I grid with every merged range reproduced as a colspan/rowspan and every border taken
  from the source cell's own borders. Extracted with openpyxl (`merged_cells.ranges` + per-cell
  `border`/`fill`/`font`). Banner shading is Excel **theme 0, tint −0.25 = `#BFBFBF`**.
- ⚠️ **REAL BUG found by measuring, not reading — CSS specificity flattened every font size.**
  The base rule `.ts-t td` scores (0,1,1); the size classes were written bare (`.ts-band-c`,
  `.ts-11`, …) at (0,1,0) and therefore **lost to it**, rendering all three forms at a flat 9pt —
  the 16pt title measured 12px. Every size/weight rule is now written `.ts-t td.x`. This is
  invisible in the source and only showed up in `getComputedStyle`.
- ⚠️ **`HEAD` grew by one** ("Form" column). It is the single source of truth for `SPAN`, so the
  group rows and empty state followed automatically — but the Form column is deliberately **NOT**
  gated on `canWrite` (printing only reproduces what the row already holds), unlike `.ms-actcol`.
  `.ms-tscol` is added to the module's `@media print` hide-list so it never prints in the log.
- ⚠️ **Print is gated on `body.ts-printing`**, added only while the top-sheet dialog prints, so the
  "hide everything except `.ts-doc`" rule can never affect an ordinary Ctrl+P of the log behind it.
  `afterprint` clears it, with a 4s fallback because Safari/older Chrome do not always fire it.
- ⚠️ **`projects` cannot hold the client name** — 0009/0010 made it read-only because it is synced
  from the Planners Dashboard by an id-keyed upsert that would overwrite any local column. Hence
  `topsheet_defaults` in this app's own schema.
- **Verified in-browser** against the real CSS/JS: all three docs measure exactly **210×297mm**, a
  rowspan/colspan walk confirms **every row totals exactly 9 columns** in all three forms, none
  overflows its page (table height 213/250/222mm), every mapped field renders, and a hostile
  payload (`<img onerror>`, `<script>`, `<b>`) produces **0 injected nodes** with the text preserved.
  ⚠️ Screenshots remain impossible here (stalled compositor) — verified by measurement.
  ⚠️ **Not verified signed-in**, and the migration has **not** been run yet.
- **Email is NOT built** (owner deferred it): sending needs a backend — a Supabase Edge Function
  plus a provider (Resend or Megawide SMTP) — since browser JS cannot speak SMTP.
- Assets `topsheet.js/css?v=20260812c`, `module.js/css?v=20260812c`.

## Top sheets rebuilt from ISSUED documents, not the blank templates (2026-08-12b) — fmlozano
The owner supplied two real, issued sheets — a **TMS201 MAS** and an **SLT101 RFA** — after the
first build. ⚠️ **The blank F-GEN workbooks are NOT the form in use**; MAS and RFA are now
transcribed from the issued documents instead. What actually differed:
- **MAS**: a **Megawide logo** sits above the sheet; there is a **PROJECT CODE** row the blank
  template has no trace of; "Attachment included?" is a **Yes/No checkbox pair stacked vertically**,
  not a free-text cell; and each review block prints the **four review-status options as
  checkboxes** (Approved / Approved with comments / Not Approved - Revise / Rejected).
- **RFA**: the description area is a **3x4 checkbox grid of 12 document types**, not a free-text
  box; the document table's last column is **"Pages"**, not the template's "Copies"; the signature
  band is **"Company" with THREE rows** (Prepared / Checked / Approved), not one plus a client
  return date; and both review bands are titled **"… REVIEW AND APPROVAL"**.
- **Dates print `dd-MMM-yy`** (13-Mar-26 / 31-Jul-26) on both issued forms. `TopSheet.fmtDate` is
  integer maths on the ISO string — never local `Date` getters, which shift the day east of
  Greenwich (the same trap this module's importer notes document).
- **Column geometry is measured, not guessed.** The issued RFA's own vector rule lines put the
  verticals at 0 / 7.5 / 30.6 / 42.1 / 53.75 / 76.7 / 88.3 / 100 % — i.e. **column A = 7.5%,
  columns B–I = 11.5625% each**. The blank template implied 9 equal columns, which is visibly wrong.
- **The print logo had to be extracted from the MAS PDF** → `assets/img/logo-print.png`.
  `logo-white.png` is the white sidebar wordmark and is invisible on paper.
- ⚠️ **REAL BUG, the same specificity trap twice.** `.ts-t td` sets `border: 0` at (0,1,1); the edge
  classes were written bare (`.bt`/`.br`/`.bb`/`.bl`) at (0,1,0) and **lost**, so all three forms
  rendered with **no grid lines whatsoever** — a controlled form with no boxes. Identical to the
  font-size bug fixed hours earlier in the same file. Every such rule is now `.ts-t td.x`.
  **Neither was visible in the source; both took `getComputedStyle`/a render to see.**
- ⚠️ **Review-status boxes are always printed UNTICKED**, and so is the copy that reproduces them.
  The consultant ticks one by hand; the log's `status` is Megawide's own record, not the
  consultant's decision, so pre-ticking it would put a false approval on a controlled form.
- ⚠️ **No form number is printed in the body** — neither issued sheet carries one (it lives in the
  file name). `F-GEN0nn Rev 0` stays on the dialog header only.
- **RFI has no issued sample**, so it still follows its blank template, with only the Yes/No
  attachment boxes carried across for house consistency. **Re-check it against a real RFI.**
- **Verified by rendering** (headless Edge screenshot — the in-app browser still cannot composite):
  all three measure **210x297mm**, a rowspan/colspan walk confirms **every row totals exactly 9
  columns**, none overflows its page, and **49/49, 82/86 and 54/54 cells carry borders**. Compared
  side by side against the two issued PDFs. ⚠️ **Not verified signed-in, and not yet printed on
  paper** — margins/scale at the printer are the owner's check.
- Assets `topsheet.js/css?v=20260812d`, `module.js?v=20260812d`.

## ⚠️ REAL BUG: the module silently auto-selected a project (2026-08-12c) — fmlozano
Owner: *"Why does the Dashboard auto-select the Megaworld Projects DP Tracker? I am in the Projects
tab where I am supposed to select a project first."*
- `init()` read **`pid = selEl.value || (projects[0] && projects[0].id)`**. A `<select>` with options
  and no explicit value reports its **FIRST OPTION**, so whenever `pd_project` was missing, stale, or
  pointed at a project the user can no longer access, the module silently adopted **whichever project
  sorts first** and rendered its log as though the user had chosen it.
- **This contradicted the shell.** `dashboard.html` has always redirected to `projects.html` when
  nothing is selected ("there is nothing meaningful to show until a project is chosen"). The modules
  did the opposite, so the shell and the modules disagreed about whether a project was in context.
- Now: validate the stored id against the accessible list and `location.replace('../../projects.html')`
  when it fails. **`drawing-register` had the identical bug** (`sessionStorage.getItem('pd_project') ||
  projects[0].id`) and is fixed the same way.
- ⚠️ **`location.replace()` does NOT stop the running script.** drawing-register's `loadProjects()`
  returns a boolean and `init()` bails on it — otherwise the rest of init keeps wiring handlers against
  a null `pid` until navigation commits.
- Verified: 5/5 in a Node harness over the corrected logic (nothing stored / empty string / stale id /
  valid id / valid id that sorts last), `node --check` on both modules. **Not verified signed-in.**
