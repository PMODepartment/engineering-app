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

## Modules

- `modules/drawing-register/` — live
- `modules/material-submittal/` — live
- `modules/method-register/` — placeholder only (`enabled: true`, no table/CRUD
  yet); see `modules/method-register/CLAUDE.md`

See `docs/MODULE_GUIDE.md` before adding or building out a module.
