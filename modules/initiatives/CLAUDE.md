# Module: initiatives

> **Claude / developer: read this first.**
> 1. Read `../../docs/MODULE_GUIDE.md` (NOT auto-loaded).
> 2. This module is **Initiatives**. DB table `initiatives`, migration
>    `../../migrations/0015-initiatives.sql` — **USER MUST RUN IT**.
> 3. ⚠️ **This is the only ORG-WIDE module in the app.** Almost every rule the
>    guide states about project scoping is deliberately different here. Read the
>    next section before changing anything.
> 4. Chrome (topbar / tabs / tools / filter bar) is copied **verbatim** from
>    method-register — do not re-invent it.

## Built 2026-08-13 — Overview + Registry, org-wide

⚠️ **NO SOURCE WORKBOOK.** Designed, not transcribed (owner confirmed there is no
existing tracker). Vocabularies are a first cut. Hence a **method note** on the
Overview rather than a reconciliation note.

## ⚠️ Org-wide: every project-scoping rule, inverted on purpose

An initiative is a department-level programme — a new standard, a tool, a
training push. It **may** carry a project link and usually does not. So
`initiatives.project_id` is **nullable**, and four things follow that are the
opposite of what every sibling module does:

1. ⚠️ **RLS is NOT the standard 4-policy pattern.** `can_access_project(pid)`
   returns **FALSE for a NULL pid**, so the obvious policy would hide every
   unattached initiative from everyone including admins — i.e. the whole table.
   Every clause is `project_id is null or can_access_project(project_id)`, and
   read additionally requires `is_approved()`. Net effect: org-wide rows are
   visible to every approved user, and attaching a project can only ever
   **narrow** visibility, never widen it. The same guard is repeated in the
   INSERT and UPDATE `with check` clauses — without it a user could park an
   initiative on a project they cannot see.
2. ⚠️ **`nav.js` must NOT gate this module.** It gates project-scoped items
   behind a project selection because those pages bounce straight back to
   `projects.html`. This one is meaningful with nothing selected, and gating it
   would make it **unreachable from a cold start** — the only way to clear the
   gate is to pick a project it does not need. Hence the new **`orgWide: true`**
   flag in `assets/js/config.js`, which `nav.js` reads.
3. ⚠️ **`init()` NEVER redirects to `projects.html`,** and never reads or writes
   `pd_project` at all. There is no notion of "the current project" on this page.
4. ⚠️ **`load()` has no `.eq('project_id', …)`.** RLS already limits the rows to
   what the signed-in user may see (org-wide, plus anything pinned to a project
   they can access); Overview and Registry both render the full result unfiltered
   by project, so the two tabs can never disagree about scope.

### ⚠️ There is deliberately NO project selector or filter (removed 2026-08-13)
The first build carried a topbar dropdown — All projects / Not project-linked /
a project — reasoning it would matter once initiatives started getting pinned to
projects. The owner asked why it was there on a module pitched as "org-wide";
removed rather than re-justified. At this app's actual scale a filter nobody had
used yet was pure interface cost, and it read as contradicting the org-wide
framing even though it never touched `pd_project` (item 3 above predates the
selector and stayed true throughout — it was never page CONTEXT, only ever an
optional narrowing control, which is exactly why removing it changed nothing
structural).
- Overview and Registry now always show **every initiative the signed-in user
  can see** — org-wide rows plus any pinned to an accessible project. No `list`
  vs `rows` distinction remains in `module.js`; `renderOverview`/`renderRegistry`
  read `rows` directly.
- The **Registry's "Project" column** still shows the link per row (or
  "org-wide"), and the **Add/Edit form** still lets a write optionally pin one —
  neither of those was the removed control.
- **`clearAll()` redesigned**: it no longer scopes to "whatever the filter
  selects" (there is no filter). It always means every initiative the user can
  see, says so plainly, and requires typing `ALL` — a named scope like a project
  id would now suggest a narrower, safer deletion than what actually happens.
- **`exportExcel()`** always exports everything visible; the filename dropped its
  scope suffix.
- If Registry-level narrowing is needed later, filter by department or category
  first — both already exist as filters — before reintroducing a project-scoped
  control.

The audit trigger needed no change: `engineering_audit.project_id` is nullable
and its read policy already handles `project_id is null`.

### ⚠️ Two numbers are deliberately NOT aggregated the obvious way

- **`progress_pct` is averaged over IN PROGRESS rows only.** It is human-entered
  judgement — there is no task breakdown beneath an initiative to roll up from —
  so averaging it across ideas and cancelled work reports a portfolio of
  intentions as "34% done". A `Planned` row sitting at 80% must not lift the
  mean; the harness asserts exactly that.
- **`benefit_value` is summed only for `benefit_type = 'Cost'`.** A peso figure
  attached to a *Safety* initiative is a category error. The total excludes it,
  the Registry prints "—" rather than the number, the export leaves the cell
  blank, and the form's hint changes as the benefit type changes. Printing the
  value anyway would invite someone to `SUM()` a column the module refuses to.

**Overdue = past target and still open.** A completed or cancelled initiative is
never overdue however late it closed — `completed_date` records that.

### ⚠️ `todayISO()` uses LOCAL getters, and that is correct
The importers' rule ("never local getters") is about values **SheetJS returns as
UTC instants**. This reads the wall clock: `toISOString()` would put Manila a day
behind for its first eight hours and under-report overdue items.

### Destructive actions are scoped differently, on purpose
- ⚠️ **"Clear" is not the siblings' "clear this project's rows".** The table is
  org-wide with no view-narrowing filter, so "Clear" always means every
  initiative the signed-in user can see. It says so plainly, requires `ALL`
  typed back, and deletes **by the ids actually loaded** rather than by a filter
  expression.
- ⚠️ **Import is ADD-ONLY.** There is deliberately no "replace everything"
  checkbox: a replace here would delete other departments' initiatives. The
  siblings can offer it safely only because their delete is scoped to one
  project. The dialog says so.

### Importer notes
- ⚠️ **Header-mapped and SHOWS the mapping first**, same reasoning as the Value
  Engineering importer — with no known layout, index-reading is a guess dressed
  up as a rule.
- ⚠️ **REAL BUG, found by the harness rather than by reading: punctuated synonyms
  never matched.** Headers are normalised through `normHdr` but the synonym
  literals were compared raw, so `'progress %'` could never match a column
  arriving as `progress`. It failed **silently**, reporting the column as
  ignored. The table is now normalised through the same function once at load
  (`SYN_N`). **The Value Engineering importer had the identical bug.**
- ⚠️ **An unrecognised project code becomes NULL (org-wide), not an error.** RLS
  would reject the whole batch for one bad cell; instead each unknown code is
  collected and **named in the import dialog** before anything is written.
- `parsePct` reads `45%`, `45` and `0.45` as the same thing — a bare decimal
  in (0,1] is a fraction, anything else a percentage. `1%` stays 1.
- Header row = the first of the top 30 mapping a **title plus at least one other
  recognised field**; requiring two stops a banner row being read as headers.
- Cells read as **formatted text** (`cell.w`); `realDate()` rejects outside
  2015–2100; stops at a sign-off block.

### Dashboard section (2026-08-13) — the org-wide problem, again
`EngData.initiativeStats(pid)` + a section in `dashboard.html`.

- ⚠️ **`fetchAll()` in `engdata.js` hardcodes `.eq('project_id', pid)`** — right
  for every project-scoped table, **wrong here**, where it would drop every
  company-wide row, i.e. most of the table. There is a separate
  **`fetchAllOrgWide()`** with no project predicate that lets RLS decide. Do not
  collapse the two.
- ⚠️ **"The numbers for this project" is not a well-formed question here.** The
  section reports what *applies*: initiatives pinned to this project **plus**
  company-wide ones, excluding only those pinned to a *different* project.
  Reporting the pinned ones alone would leave the section permanently empty on
  most projects; reporting the union without saying so would read as though this
  project owned company work. So the split is shown in the section caption
  (`N on this project · M company-wide`) and in a tile.
- The dashboard repeats the module's two aggregation rules — **Cost-type only**
  for benefit value, **In Progress only** for the progress mean — and the harness
  asserts the two screens produce **identical** numbers over the same rows. If
  they diverge, the module is the authority.

### Verification
- **134/134 automated checks** (shared harness with Value Engineering) against
  the **shipped** `module.js`, running its own exported internals. Covers: the
  in-progress-only progress mean (including that a `Planned` row at 80% does not
  move it, and that an active row with no figure is excluded from the
  denominator); Cost-only benefit summation with a ₱999,999 Safety row proven
  excluded; every overdue boundary (past/future/today/no-date/completed/
  cancelled); progress clamping and the Completed→100 implication; `matches()`
  with no project predicate to apply; percent parsing across five notations;
  status synonym normalisation; header mapping including the punctuation bug and
  the `Target Date` / `KPI Target` collision; a full sheet parse proving an
  unknown project code lands as `null` and is reported; and `headCells()`
  emitting exactly one `<th>` per entry.
- **Migration `0015-initiatives.sql` has been run on the live DB (owner
  confirmed 2026-08-13).**
- `node --check` clean; CSS braces and comments balanced.
- ⚠️ **NOT browser-verified against real CRUD, and the org-wide RLS has not been
  exercised against two real accounts** — that is the one check that matters
  most for this module: confirm a user with no access to project X cannot see an
  initiative pinned to X, and that everyone sees the unpinned ones. Layout at
  375 / 768 / 1280 and dark-mode contrast are unmeasured.

### Not built (deliberate)
No approval guard — an initiative has no review authority; `Completed` is the
owner's statement of fact, not a decision granted by a planner, and none of this
module's statuses appear in `engineering_decision_statuses()` anyway. Also not
built: file attachments, milestones/tasks beneath an initiative (which is what
would make `progress_pct` derivable), KPI history over time, live collaboration,
offline writes.

## Status
- [x] Read the module guide; chrome copied, not re-invented
- [x] CRUD (add / edit / delete / clear-all), `created_by` stamped
- [x] `Fmt.esc()` on all user text injected into HTML
- [x] List read keyset-paginated past 1000 rows
- [x] Import (add-only, header-mapped, mapping shown) + export
- [x] Audit trigger in the migration
- [x] `orgWide: true` in `assets/js/config.js`; `nav.js` honours it
- [x] `enabled: true`; assets `?v=20260813d`
- [x] **Migration run on the live DB** (owner confirmed 2026-08-13)
- [x] No project selector/filter on the page (removed 2026-08-13)
- [ ] **Org-wide RLS verified with two accounts** (see above)
- [ ] Live click-through of CRUD against a real login (signed-in load confirmed
      working; add/edit/import/delete not yet exercised live)
- [ ] Responsive + dark-mode measured at 375 / 768 / 1280
