# Megawide Engineering App

Internal engineering document and workflow management for Megawide Construction
Corporation. Sibling application to the **Planners Dashboard**, built on the same
stack, the same design system and the same role model — but on its own Supabase
project.

Initial modules: **Drawing Register** and **Material Submittal Log**.

---

## 1. Architecture

Deliberately identical to the Planners Dashboard, so the two apps stay
maintainable by the same people with no new tooling to learn.

| Concern | Choice |
|---|---|
| Frontend | Plain HTML/CSS/JS. **No build step, no bundler, no npm.** |
| Only runtime dependency | `@supabase/supabase-js@2` from CDN (UMD) |
| Backend | Supabase (Postgres + Auth + Storage + PostgREST), called directly from the browser |
| Authorization | **Postgres Row-Level Security.** There is no API server to enforce rules in. |
| Routing | Multi-page. Plain `<a href>` between static HTML files; no SPA router. |
| State | `sessionStorage['pd_project']` for project context; `window.__profile` for the signed-in user; `localStorage` for UI preferences |
| Hosting | Static (GitHub Pages) |

### Layout

```
index.html            login              projects.html    project selector (entry point)
register.html         request access     dashboard.html   Engineering Dashboard
pending.html          awaiting approval  notifications.html  audit trail / activity
forgot-password.html  reset             admin.html       users, roles, projects

assets/css/dashboard.css    the Planners Dashboard design system, unchanged
assets/css/engineering.css  additions only (KPI grid, status bars, activity feed)
assets/js/config.js         Supabase credentials + the module registry
assets/js/auth.js           AppAuth — session + profile gate      (shared, unchanged)
assets/js/db.js             PDb + Fmt — projects, users, formatters (shared, unchanged)
assets/js/ui.js             UI — toast, modal, user bar, project picker (shared, unchanged)
assets/js/icons.js          inline SVG icon registry
assets/js/theme.js          dark mode (html.pd-dark token remap)
assets/js/collab.js         PDCollab — realtime presence / live rows
assets/js/offline.js        PDSync — offline outbox + read cache
assets/js/perm.js           Perm — role → engineering capability map   [NEW]
assets/js/nav.js            Nav — config-driven, role-filtered sidebar [NEW]
assets/js/engdata.js        EngData — cross-module read model for the dashboard [NEW]

modules/drawing-register/    migrated from the Planners Dashboard
modules/material-submittal/  migrated from the Planners Dashboard

migrations/0001-engineering-core.sql            platform + both module tables
migrations/0002-engineering-audit-and-approval.sql  audit trail + approval authority
migrations/0003-legacy-ownership.sql            legacy attribution + planner edit rights
migrations/0004-harden-audit-grants.sql         audit table append-only at the grant level
migrations/0005-fix-privilege-escalation-and-guard.sql  SECURITY: self-promotion + approval guard
migrations/0006-guards-exempt-trusted-sessions.sql      keeps SQL editor / service_role working
migrations/0007-audit-privilege-changes.sql     audit role/status/project changes
migrations/0008-fix-audit-array-append.sql      fixes a 0007 bug that broke Administration
migrations/0009-projects-read-only.sql          projects sourced from the Planners Dashboard
migrations/migrate-data.mjs                     data + file copy from the Planning App
```

### What was reused vs. newly built

**Reused unchanged** (byte-identical to the Planners Dashboard, deliberately —
divergence here would double the maintenance cost): `dashboard.css`, `auth.js`,
`db.js`, `ui.js`, `theme.js`, `collab.js`, `offline.js`, `calendar.js`, both
module folders, and the Megawide logo/icon assets.

**Newly built**: `perm.js`, `nav.js`, `engdata.js`, `engineering.css`,
`dashboard.html`, `notifications.html`, and the nine SQL migrations.

**Changed from the Planning App**: the sidebar is now rendered from one
config-driven function (`Nav.render`) instead of being copy-pasted into every
page — adding a module no longer means editing every HTML file.

---

## 2. Setup

### 2.1 Supabase

The Engineering App runs on its **own** Supabase project
(`zkxzaijznutmiueeurbb`), separate from the Planners Dashboard
(`bgupuqnkqhixpuctyder`).

> ⚠️ **Consequence you must plan for:** separate projects mean separate
> `auth.users` tables. Passwords are not portable between Supabase projects, so
> **Planning App accounts do not work here.** Every user registers once and is
> approved by an Engineering App admin. See [docs/MIGRATION.md](docs/MIGRATION.md).

1. The project's **publishable** key is already set in `assets/js/config.js`.
   (Settings → API → API Keys → publishable. This key is safe to expose; RLS is
   what protects the data. **Never** put the `service_role` key here.)

2. Run the migrations in the Supabase SQL editor, **in this order**:

   | # | File | Why |
   |---|---|---|
   | 1 | `migrations/0001-engineering-core.sql` | users/projects/workspaces, RLS helpers + policies, both module tables, storage buckets, realtime |
   | 2 | `migrations/0003-legacy-ownership.sql` | legacy attribution + widens edit rights to planners — **required before importing data** |
   | 3 | `node migrations/migrate-data.mjs` | copies records and files from the Planning App |
   | 4 | `migrations/0002-engineering-audit-and-approval.sql` | audit trail + approval authority |
   | 5 | `migrations/0004-harden-audit-grants.sql` | makes the audit table append-only at the privilege level too |
   | 6 | `migrations/0005-fix-privilege-escalation-and-guard.sql` | **security fix** — closes self-promotion to super_admin; repairs the approval guard |
   | 7 | `migrations/0006-guards-exempt-trusted-sessions.sql` | **required with 0005** — lets the SQL editor / service_role administer again |
   | 8 | `migrations/0007-audit-privilege-changes.sql` | records role/status/project changes in the audit trail |
   | 9 | `migrations/0008-fix-audit-array-append.sql` | **required with 0007** — 0007 alone blocks every privilege change |
   | 10 | `migrations/0009-projects-read-only.sql` | projects/workspaces become read-only — the Planners Dashboard owns them |

   > ⚠️ **0002 ideally goes after the data import.** It installs an audit trigger;
   > with it live, the import logs every one of the ~1,500 imported drawings as a
   > change made by "(deleted user)", burying the real history from day one. The
   > import is the starting state, not an edit anyone made.
   >
   > **0002 has already been applied to this project**, so disable the two audit
   > triggers around the import instead — exact commands in
   > [docs/MIGRATION.md §4.4](docs/MIGRATION.md).

3. Register through the app, then promote yourself in the SQL editor:
   ```sql
   update users set role = 'super_admin', status = 'approved'
   where email = 'you@megawide.com.ph';
   ```

### 2.2 Running locally

No build step. Any static server:

```bash
python -m http.server 8777
```

Then open `http://localhost:8777/`. Do not open via `file://` — the Supabase
client and the service worker both need a real origin.

### 2.3 Deployment

Push to `main`; GitHub Pages serves the repo root. There is nothing to compile.

> ⚠️ **Cache-busting is manual.** Every shared asset is referenced with a `?v=`
> query string. If you change a file under `assets/`, bump its `?v=` in every
> HTML file that references it, or returning users keep the cached copy. This has
> been misdiagnosed as a code bug more than once in the Planning App.

---

## 3. Roles and permissions

The **existing** Planners Dashboard roles are reused unchanged — no new role
system. See [docs/PERMISSIONS.md](docs/PERMISSIONS.md) for the full matrix and
where each rule is enforced.

| | super_admin | admin | planner | user | viewer |
|---|---|---|---|---|---|
| View register / log | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create / edit / upload | ✓ | ✓ | ✓ | ✓ | — |
| **Review / approve / reject** | ✓ | ✓ | ✓ | — | — |
| Delete / archive | ✓ | ✓ | ✓ | own rows | — |
| Export / download | ✓ | ✓ | ✓ | ✓ | ✓ |
| Administration | ✓ | ✓ | — | — | — |

Access is additionally scoped by project: admins see all projects, everyone else
only those listed in their `users.projects` array.

> ⚠️ `assets/js/perm.js` decides what to **show**. It is not security. Every rule
> above has a matching Postgres guard (an RLS policy, or the
> `engineering_guard_decision` trigger for approvals). Never rely on a hidden
> button.

### The two deliberate extensions

The Planning App had neither of these; both are required by the engineering brief.

1. **Audit trail** — `engineering_audit` records user, timestamp, action, record,
   previous value and new value for every change to both module tables, including
   a full row snapshot on delete (so an accidental deletion is recoverable). The
   Planning App's only traceability was `created_by`/`updated_at`, which cannot
   answer "who approved this, and what was it before?". Surfaced at
   `notifications.html`.

2. **Approval authority** — the Planning App's RLS gives every non-viewer
   identical write rights, so any `user` could mark a drawing Approved. A trigger
   now restricts *transitions into* a decision status (Approved, Approved w/
   comments, Rejected, Resubmit) to `planner` and above. Editing other fields on
   an already-approved record is unaffected.

---

## 4. Data integrity and revision history

- **Revisions are preserved, never overwritten.** The Drawing Register keeps its
  full submission history in the `submissions` jsonb array (one entry per
  revision, with its own dates, outcome and file). The Material Submittal Log
  models a resubmission as a **separate row** sharing a `submittal_no` with a
  higher `revision_no`. These two models genuinely differ — do not "unify" them.
- Two SQL views flatten that history for reporting: `drawing_revisions` and
  `material_submittal_revisions` (the latter also flags `is_latest`).
- **Why revision history is protected by recoverability rather than a write
  block:** both modules legitimately rewrite `submissions` wholesale during Excel
  re-import, so a shrink-guard would break imports. Instead every change to that
  column is captured in `engineering_audit` with the full before/after JSON.

---

## 5. Files

Uploads go to **private** Supabase Storage buckets named after the module key
(`drawing-register`, `material-submittal`). The database column stores the object
**path**, never a URL; access is always a freshly signed 60-second URL. A stored
URL would expire and break.

---

## 6. Adding a future module

RFI Management, Technical Submittals, Design Review, Document Transmittal, Method
Statements, Inspection Requests, NCR Management — none of these require shell
changes. Add one entry to `APP_CONFIG.MODULES` and a folder under `modules/`; the
navigation, launcher and permission filter all follow. See
[docs/MODULE_GUIDE.md](docs/MODULE_GUIDE.md).

---

## 7. Known limitations

- **Accounts are not shared with the Planners Dashboard.** A direct consequence
  of using a separate Supabase project. Users register once here.
- **Projects and workspaces are read-only here** (`0009`). The Planners Dashboard
  is the single place they are created and maintained; this app sources them via
  `migrate-data.mjs --only=workspaces,projects`. Nothing propagates
  automatically, so **that sync has to be run** — on a schedule, or whenever a
  project is added. Until it runs, a new project is invisible here.
  The sync is one-way and **overwrites** local edits; it never deletes, so a
  project removed in the Planners Dashboard lingers here until removed by hand.
- **`0005`/`0006` fix a privilege-escalation hole inherited from the Planners
  Dashboard.** The `users_admin_update` policy allowed any approved user to set
  their own `role` to `super_admin`, because it had no `WITH CHECK` and no column
  restriction. Found by testing as a demoted account, not by reading the code.
  **The Planners Dashboard still has this hole** — Section 1 of `0005` plus `0006`
  apply there unchanged. Fixing it there is not yet done.
- **A user who registers but never confirms their email is invisible to admins.**
  This project requires email confirmation, so the profile row is not created
  until their first successful sign-in (`auth.js`'s `ensureProfile` self-heal).
  Until then there is nothing in Administration to approve. The registration
  screen says so; the workaround, if you want it, is to turn off "Confirm email"
  in Supabase — see [docs/MIGRATION.md §4.5](docs/MIGRATION.md).
- **Historical records show their original author but are unowned until that
  person registers.** Migrated rows carry `legacy_created_by`; run
  `migrate-data.mjs --relink-users` after each batch of approvals. Query
  `legacy_ownership_pending` to see what is outstanding.
- **The audit trail starts at cutover.** Changes made in the Planning App before
  the migration were never recorded — that app has no audit table — so they
  cannot be backfilled.
- **`schedule_activity_id` / `schedule_wbs` / `lead_days`** exist on both module
  tables but are inert: they referenced the Project Schedule module, which is not
  part of this app. Kept so the schema matches the source and the columns
  round-trip through migration; harmless.
- **Dashboard statistics are computed client-side**, which means every drawing
  row for the selected project is fetched (paginated past the 1,000-row cap).
  Fine at BAU101's ~540 rows; if a register reaches tens of thousands, move the
  aggregation into a Postgres view or RPC.
- **The status vocabularies are duplicated** between each module's `module.js` and
  `assets/js/engdata.js`, because there is no module system to import them
  through. If a module's status list changes, update `engdata.js` too —
  `EngData.selfTest(pid)` in the browser console reports any status in the data
  that the dashboard does not recognise.
- **Not yet verified against a live signed-in session.** The dashboard's
  aggregation logic has 26 automated tests and the UI was measured in-browser
  against stubbed data in both themes, but no one has clicked through with real
  credentials — the publishable key is still a placeholder.
