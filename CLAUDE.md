# Engineering App

Megawide's Engineering App — sibling to the Planners Dashboard, own Supabase
project (see `assets/js/config.js`). Config-driven shell: modules are
registered once in `assets/js/config.js` and the sidebar/dashboard pick them
up automatically (`docs/MODULE_GUIDE.md`).

## Workflow

- **Commit and push after every change**, without waiting to be asked each
  time. Use a normal `git add` of the touched files (never `-A`/`.`), a
  commit message describing the change, then `git push origin main`.

## Project sync (Planners Dashboard → here)

Projects and group heads are owned by the Planners Dashboard and read-only here
(`migrations/0009-projects-read-only.sql`). They arrive via the **`sync-projects`
Edge Function** — Admin → Projects → **"Sync now"**, and a schedule set in the
Supabase dashboard (Edge Functions → Schedules). One code path for both.

- ⚠️ **The boundary is `TABLES` in that function: `group_heads` + `projects`, and
  nothing else, hardcoded.** `migrations/migrate-data.mjs` can also copy
  `drawing_register` / `material_submittal` — correct for the one-off cutover,
  **catastrophic now**: it would overwrite this app's live register with a stale
  Planners snapshot. Do not make the table list an input.
- **It prunes, the old GitHub Action never did.** A project deleted upstream used
  to live here forever — NCIT sat here as `active` long after being archived and
  hard-deleted in Planners, and no number of syncs cleared it. Pruning is a
  **separate, explicit second click**, and only removes projects holding no
  drawings or submittals; anything holding engineering work is reported and left.
- ⚠️ **`ENG_SERVICE_KEY` must be the new `sb_secret_…` key.** This project is on
  the new API-key format, so the auto-injected legacy `SUPABASE_SERVICE_ROLE_KEY`
  silently degrades to `anon` — the function guards for this and refuses rather
  than failing obscurely later. (planning-app's `sync-wpm` lost time to exactly
  this; the two functions are deliberately the same shape.)
- `.github/workflows/sync-projects.yml` is **kept as a manual fallback** with its
  nightly cron **removed**, so the two mechanisms cannot both run.

### The nightly run (Integrations → Cron, job `sync-projects-nightly`)

`0 22 * * *` = 06:00 Manila, matching the old Action. Body is `{}` — **never add
`"prune": true`**: pruning deletes projects and is a human decision made from the
button, where the list is shown first.

Three traps, all hit during setup:

- ⚠️ **The dashboard's "Supabase Edge Function" job type hardcodes
  `timeout_milliseconds := 1000`, and the sync takes 873–2188 ms.** It timed out
  intermittently — not consistently — which is the worst version of this. The job
  is therefore a **SQL Snippet** calling `net.http_post` directly with
  `timeout_milliseconds := 30000`. There is no timeout field on the Edge Function
  type; switching type is the only way to change it.
- ⚠️ **A cron run reporting `succeeded` / `1 row` proves nothing.** `net.http_post`
  is asynchronous: it queues the request and returns immediately (~4 ms). The real
  verdict is in `net._http_response` — check `status_code` and `content`, not
  `cron.job_run_details`. Note a pg_net timeout does **not** mean the function
  didn't run; the request was already sent, so rows may be written while the log
  insists it failed.
- The service key is read from **Vault** (`eng_service_key`) rather than pasted
  inline, which is what the Edge Function job type does — that leaves the key in
  plaintext in `cron.job.command`, readable by anyone with DB access.

Verify a run with:

    select id, status_code, error_msg, created, content::text
      from net._http_response order by created desc limit 3;

A healthy row: `status_code 200`, `"caller":"scheduled"`, and `dropped_columns`
listing exactly the five `schedule_*` names — anything else there means the
Planners schema changed and the projection needs looking at.

## Modules

- `modules/drawing-register/` — live. ⚠️ **Four FIXED top levels; levels 2..N are
  generic and named per project** (`drawing_level_defs`, migration `0017`), with two
  incompatible progress bases — 0-or-100 tracking units for CD/SD/FCD, partial sheet
  credit for ISD. Read `modules/drawing-register/CLAUDE.md` before touching its tree
  or its percentages.
  ⚠️ **planning-app has a TWIN `drawing_register` table and a twin module** (the
  pre-cutover original). Engineering App is authoritative; planning-app's Design
  Development roll-up still reads its own local copy, so the two disagree until the
  bridge lands. Do not "fix" that by copying rows between projects.
- `modules/material-submittal/` — live
- `modules/method-register/` — live (Summary + Registry, migration `0013`);
  see `modules/method-register/CLAUDE.md`
- `modules/value-engineering/` — live (Summary + Registry, migration `0014`);
  see `modules/value-engineering/CLAUDE.md`
- `modules/initiatives/` — live (Overview + Registry, migration `0015`).
  ⚠️ **The only ORG-WIDE module** — read `modules/initiatives/CLAUDE.md` before
  touching it; most of the project-scoping rules below are deliberately inverted
  there.

See `docs/MODULE_GUIDE.md` before adding or building out a module.

## Project-first is now enforced everywhere

A project is "current" only because the user chose it. Three rules, and they have
to stay in agreement or the shell and the modules contradict each other:

1. **`projects.html` CLEARS the selection on load** — it *is* the selection step,
   so arriving there means "not chosen yet". Clears `pd_project`,
   `pd_project_name`, `pd_group_head`. ⚠️ **Except when the URL carries
   `?project=`** — that is the Planners Dashboard hand-off `config.js` adopts,
   an explicit choice made on the way in, and clearing it would discard it.
2. **`dashboard.html` and both modules redirect to `projects.html`** when nothing
   valid is stored. ⚠️ **Never fall back to `projects[0]`** — that was a real bug:
   a `<select>` with no explicit value reports its FIRST OPTION, so a missing or
   stale id silently became "whichever project sorts first" and its register was
   shown as though the user had picked it.
   ⚠️ `location.replace()` does **not** halt the running script — the caller must
   bail as well (drawing-register's `loadProjects()` returns a boolean for this).
3. **`nav.js` gates the project-scoped items** (Dashboard + every project-scoped
   module) when nothing is selected: inert, `href` → `projects.html`, tooltip
   "Select a project first". Otherwise they would be links that bounce straight
   back, which reads as broken. Projects / Notifications / Administration are not
   project-scoped and are never gated.
   ⚠️ **Gating is per-module, not blanket.** A module carrying `orgWide: true` in
   `config.js` (today only **Initiatives**) is meaningful with no project chosen,
   so it is never gated — gating it would make it **unreachable from a cold
   start**, since the only way to clear the gate is to choose a project it does
   not need. Such a module must correspondingly **never redirect to
   `projects.html`** from its own `init()`, and its table's RLS cannot use a bare
   `can_access_project(project_id)` — that is FALSE for a NULL project and would
   hide the entire table. See `modules/initiatives/CLAUDE.md` and
   `migrations/0015-initiatives.sql`.
