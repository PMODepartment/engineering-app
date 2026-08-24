# Module: portfolio

## Cross-project rollup: high-level Gantt + ISD status, grouped by group head (2026-08-25) — fmlozano
User: *"Develop Portfolio Dashboard including High Level Gantt Chart & ISD Status. I think we can
utilize the dashboard in the per project view in the Planning App."* Then, mid-build: *"Update the
front page as well to consider the group head categorization of the projects."*

Patterned on planning-app's `portfolio-overview`, which is the same idea for the planning side.
**No migration** — this module owns no table.

## ⚠️⚠️ THE SECOND ORG-WIDE MODULE (after Initiatives)
Org-wide inverts most of the project-scoping rules in the root `CLAUDE.md`, and all three halves
must agree or the shell and the module contradict each other:
1. **`orgWide: true` in `config.js`**, so nav does not gate it. Gating it would make it
   **unreachable from a cold start** — the only way to clear the gate is to choose a project, which
   this module does not need.
2. **It must NEVER redirect to `projects.html` from `init()`.** It is meaningful with nothing
   selected; that is the entire point.
3. It reads `drawing_register` with **no project predicate** and lets RLS scope it. A `user`
   assigned to one project gets a one-project portfolio, and **no code here decides that**.

Unlike Initiatives it owns **no table**, so it needs no migration and none of the
`can_access_project(NULL)` care that `0015` documents.

## The maths lives in `EngData.portfolio()`, not in the module
`assets/js/engdata.js` is the shell-owned cross-module read model and already carries the
drawing-status vocabulary shared with the register, so the aggregation belongs there — one
definition of "approved", not a second one inside a dashboard.

- ⚠️ **It uses `fetchAllOrgWide` on a project-scoped table, and that is its intended use.**
  `fetchAll` hardcodes `.eq('project_id', pid)`, which is exactly wrong for a portfolio.
- ⚠️ **Computed in the client from raw rows, NOT by a SQL RPC — deliberately.** An RPC was the
  obvious move (planning-app has `portfolio_resource_summary` for resources) and was **rejected**:
  the register's roll-up rules are intricate (a sheet is a drawing whose parent is a drawing; a
  single-sheet row's *status* is its approval; sentinel dates must be refused) and every one would
  have to be re-expressed in SQL. That is a **second definition** of numbers the register already
  defines, and this repo's history says what that costs — `rollup()` vs `syncParent()` disagreeing
  about "approved" produced a row that stored 1/2 and displayed 0/2.
- ⚠️ **A single-sheet row's STATUS is its approval.** Trusting `approved_sheets` alone under-reports
  every row whose importer set a status but never filled the counter — the register measured 11 such
  rows on BAU101 alone. Verified explicitly.
- ⚠️ **Level nodes are structure, not work, and sheet rows are never counted beside their parent.**
  Both are regressions with history: "has a parent_id" stopped meaning "is a sheet" at migration
  0017, and the dashboard tile read zero because of it.
- Sentinel dates (outside 2015–2100) are refused from min/max **and** from the overdue test, so a
  `2000-01-06` import artefact cannot report something as decades late.
- Reads above `PORTFOLIO_WARN_ROWS` (40,000) **say so in a toast** rather than being silently
  truncated — the same courtesy planning-app's cross-project S-Curve pays above 20,000 activities.

## ⚠️ TWO COUNTING BASES, NEVER ADDED TOGETHER
- **ISD is counted in SHEETS** with partial credit, which is **identical** to the register's own
  basis — so an ISD percentage here equals the one inside the project. That is exactly why ISD gets
  its own screen.
- **Design levels are counted in DRAWINGS** here, while the register's Overview counts
  Concept/SD/FCD/TWD in **tracking units** (`is_tracking_unit` — a Technical Officer's designation,
  each worth the same, 0 or 100). Reproducing that needs the project's whole level tree and its
  nested-unit refusal rule, which is the register's job, not a portfolio's.
- **There is deliberately no blended "overall %".** It would describe neither basis. Every figure
  states which basis it is, the Overview carries an open `<details>` note explaining the difference,
  and **the caveat is written into the Excel export too** — a spreadsheet outlives the page that
  explained it. Do not "harmonise" these.

## The high-level Gantt
- ⚠️ **Geometry is PERCENT, not pixels** — the same decision the register's Overview Gantt made, and
  what makes it responsive with no resize observer, no zoom control and no scroll sync. **Do not give
  `.pf-g-track` a fixed width.** (The register's *Registry* Gantt uses px only because its lanes must
  align with grid rows scrolling beside it; nothing aligns with these.) A harness assertion fails the
  build if any `left`/`width` in the Gantt is expressed in px.
- ⚠️ **ONE SHARED TIMELINE ACROSS EVERY GROUP HEAD.** min/max come from the whole list before any
  grouping, so a bar under one group head is directly comparable with a bar under another. Per-group
  scales would make two bars of identical length mean different durations.
- A **late actual approval extends the bar** rather than being clipped, or a project that overran
  would draw as though it finished on time.
- A project with no dates still gets a lane **and says why** ("No planned or actual approval dates
  yet" / "No drawings yet"). A blank track reads as a rendering failure; a dateless register is a
  real, actionable state.
- The tick unit (month / quarter / year) is chosen from the span so the ruler never degenerates into
  unreadable repetition, and **today is always on the ruler** (the range is widened if need be, or
  the "now" line would have nowhere to sit).

## Group head is the organising dimension, not a column
The user's instruction. A group head owns a set of projects and is accountable for them, so *"how is
Ronquillo Group's engineering doing?"* is the question a portfolio exists to answer — a flat list of
20 projects answers nobody. Group heads are **read-only** here (authored in the Planners Dashboard,
mirrored in by `0009`/`0011`).
- ⚠️ **Order is `group_heads.sort_order`, NOT alphabetical.** `db.js` already fetches them ordered by
  it, and that order is kept as `ghRank`. Re-sorting alphabetically would quietly discard an
  arrangement someone made upstream and make the two apps disagree about the order of the same list.
  A harness check reverses `sort_order` and asserts the sections follow it.
- The **unassigned bucket is always last and always labelled** — an unassigned project must stay
  visible, not vanish. A group head this app has not synced yet sorts *after* the known ones rather
  than jumping to the front on an `undefined`.
- ⚠️ **A group-head heading carries its own subtotals, re-derived by `totals()`** — the same function
  the KPI row uses. A heading that only names the group leaves the reader adding percentages up by
  eye, and they cannot: a percentage is not additive.
- **Sorting happens inside each group, never across the whole list** — the sections are the structure
  of the page, and a flat sort would destroy them (the rule the register's Registry follows).
- Tolerant: if `group_heads` cannot be read, every project falls into the unassigned bucket rather
  than the page failing to render.
- **The export carries group head as a real column**, plus a subtotal row per group — a spreadsheet
  gets pivoted, and a heading that exists only as formatting cannot be.

## ISD status
- Every figure is in **sheets**, and the screen says so, because this is the one level that agrees
  with the register exactly.
- ⚠️ **The bar has two lengths meaning two things:** the outer width is how big this project's ISD
  scope is relative to the largest **in view across all group heads**, and the inner fill is that
  project's own progress. Collapsing them into one bar would make a finished 40-sheet project look
  like a finished 900-sheet one; scaling per group would do the same within a group.
- Sorted **least complete first** — this is a chase list.
- Projects with no ISD level are excluded and the empty state explains that ISD is one of the five
  fixed top levels.

## Also changed: `projects.html` (the front page)
⚠️ **"Group by: Group Head" was a default-missing case, not a new feature.** `groupKeyOf()` has
always fallen through to `ghIdOf(p)` for any value that is not `'status'` or `'none'`, and
`ghLabel()` / `countFor()` were already written for it — **but the option was never in the
`<select>`, so the grouping existed with no way to reach it.** It now leads the list and is the
default, because a group head is how this portfolio is actually organised and because status is
nearly always `active` (grouping by it produced a single heading over the whole list, saying
nothing). This matches the Planners Dashboard, which owns these records.
- New **group-head filter** ("All group heads (N)"), built from the **projects** rather than from the
  `group_heads` table: a group head with no projects would offer a filter that can only ever return
  nothing, and the per-option counts are what make the list worth reading.
- The filter is applied **before** the search and compares through `ghIdOf()`, so the "no group head"
  bucket is selectable like any other.
- `groupProjects()` now honours `sort_order` when grouping by group head (see above); every other
  mode still reads alphabetically, because no upstream intent exists there to honour.

## Verification
**61 checks for the portfolio** (`pf.html`) and **24 for the front page** (`proj.html`), both in a
real browser, both driving the **shipped** functions — the module source and `projects.html`'s own
inline script are `eval`'d, never reimplemented. `EngData._portfolio.aggregate()` swaps only the
network so the maths stays under test.
- **Aggregation:** levels excluded; sheets not double-counted beside their parent; a single-sheet
  row's status is its approval; ISD partial sheet credit; design/ISD split; sentinel dates excluded
  from min/max *and* overdue; `Approved w/ comments` counts as approved.
- **Bases:** design % and ISD % are separate figures and the basis note is present.
- **Group head:** section per group head with the unassigned bucket last; **reversing `sort_order`
  reverses the sections** (so the order is provably not alphabetical); an unsynced group head sorts
  after the known ones and falls back to its id; group headers carry that group's own subtotals; the
  header spans exactly the table width; header and body column counts agree.
- **Gantt:** bands by group head; **no pixel geometry anywhere**; every left/width inside 0–100 with
  no bar overflowing its track; today drawn; dateless and empty projects explain themselves; a late
  actual approval extends the bar.
- **Front page:** the default is group head; the option exists and leads; the filter counts only
  group heads in use, carries per-option counts, offers the unassigned bucket, refuses an empty group
  head, narrows correctly, and composes with the search.
- Hostile project and group-head names are escaped in both.

⚠️ **A harness bug worth remembering:** `proj.html` contained a literal `</script>` inside its own
`<script>` block (in `html.indexOf('</script>')`). The HTML parser closed the script there and parsed
the rest of the harness **as markup** — which produced two `SyntaxError`s *and executed the hostile
`<img onerror>` fixture for real*, so the escaping test never ran while appearing to. Split the token
(`'</scr' + 'ipt>'`).

⚠️ **Not verified signed-in** — no live login here, so no real cross-project read has happened and
the RLS scoping is reasoned rather than observed. **No screenshot**: this environment's compositor is
stalled (a long-standing limit noted throughout these files), so UI claims are measured geometry and
asserted content.
- Assets `module.css/js?v=20260824a`, `engdata.js?v=20260824a`.
