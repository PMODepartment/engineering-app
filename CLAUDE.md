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

## Sending mail (the `send-mail` Edge Function)

Top sheets (MAS / RFA / RFI) can be issued by email from the app. The app is a **static
GitHub Pages site**, so it can hold no secret — a mail credential shipped to the browser
is a published credential. Sending therefore happens in an Edge Function, deliberately
**the same shape as `sync-projects`** (same CORS block, same JWT-decode-then-look-up-the-
profile authorisation, same "report what we actually hold" key guard).

Transport is **Microsoft Graph, client-credentials (app-only)** — chosen with the user
over Resend/SMTP because it sends as the real person, keeps a copy in their Sent Items
(which is what makes an issued RFA traceable), and needs no new domain or DNS record.

    supabase functions deploy send-mail --project-ref zkxzaijznutmiueeurbb
    supabase secrets set MS_TENANT_ID=… MS_CLIENT_ID=… MS_CLIENT_SECRET=… \
      ENG_SERVICE_KEY=<sb_secret_…> --project-ref zkxzaijznutmiueeurbb

- ⚠️ **`ENG_SERVICE_KEY` must be the new `sb_secret_…` key**, same trap as `sync-projects`:
  the auto-injected legacy `SUPABASE_SERVICE_ROLE_KEY` silently degrades to `anon`, and the
  profile lookup would come back empty — which reads as *"you are not authorised"* rather
  than *"the function is misconfigured"*. The function guards and refuses.
- ⚠️⚠️ **APPLICATION `Mail.Send` GRANTS SEND-AS-ANY-MAILBOX IN THE TENANT.** Left
  unrestricted, this function's credential could send mail as anyone at Megawide. Two
  things contain it, and **both are required**:
  1. **Exchange must scope the app registration** to a mail-enabled security group —
     `New-ApplicationAccessPolicy -AppId <client id> -PolicyScopeGroupId
     eng-app-senders@megawide.com.ph -AccessRight RestrictAccess`. **IT does this once; the
     app cannot self-provision it.** Until that policy exists, treat the function as
     over-privileged.
  2. **The sender is taken from the verified caller's own profile, never from the request
     body.** A caller chooses recipients; they cannot choose whose mailbox the mail leaves
     from. Do not add a `from` parameter — that one line is the whole guarantee.
- **Planner and above only.** Issuing a top sheet to a client or consultant is an outward,
  on-the-record act, so it takes the same roles that may write the registers the sheet is
  generated from — not merely a signed-in reader.
- **Two send paths, because Graph caps a `sendMail` request at 4MB.** Under ~3MB of
  attachments goes inline in one round trip; over that it creates a draft, uploads each
  attachment through an upload session, then sends. ⚠️ **Any failure after the draft exists
  deletes the draft** — a half-built message left in someone's Drafts is one they may later
  send by hand believing it complete.
- `{"dry_run": true}` proves configuration and authorisation **without putting mail in front
  of a client**, and returns before a token is even acquired, so it is safe as a smoke test.
- ⚠️ **Nothing is sent without the user pressing Send in the compose dialog.** Generating a
  sheet never mails it.

## Modules

- `modules/drawing-register/` — live. ⚠️ **FIVE fixed top levels; levels 2..N are
  generic and named per project** (`drawing_level_defs`, migrations `0017` + `0018`),
  with two incompatible progress bases — 0-or-100 tracking units for CD/SD/FCD/TWD,
  partial sheet credit for ISD. Read `modules/drawing-register/CLAUDE.md` before
  touching its tree or its percentages.
  ⚠️ **A SCHEME IS NOT A LEVEL.** SLN101 has `Schematic Design 1/2 (Scheme 1)` and
  `(Scheme 2)`; a scheme is a **lens ABOVE level 1** — `drawing_scheme_defs`,
  migration `0019` — never a sixth top level and never in the importer's level
  path key. The Technical Officer adds and renames them from **+ Level →
  Schemes…**. Read that module's `CLAUDE.md` before changing this.
  ⚠️ **`Temporary Works Drawings` is a TOP LEVEL, not a child of For Construction.**
  0017 folded it under FCD; **0018 undid that by explicit instruction** (2026-08-20).
  Combined Services and As-Built remain folded. The importer's `foldTopLevel()` and
  0018 must agree, or a re-import reshapes the register the other way.
  ⚠️ **planning-app has a TWIN `drawing_register` table and a twin module** (the
  pre-cutover original). Engineering App is authoritative; planning-app's Design
  Development roll-up still reads its own local copy, so the two disagree until the
  bridge lands. Do not "fix" that by copying rows between projects.
- `modules/material-submittal/` — live
- `modules/request-for-approval/` — live (Summary + Registry, migration `0020`);
  see `modules/request-for-approval/CLAUDE.md`.
  ⚠️ **An RFA is CONNECTED TO THE DRAWINGS it seeks approval for** — `rfa_drawings`, a real
  many-to-many with FKs, answering both "what is this RFA asking for?" and "which RFA is
  A-1204 waiting on?". The generated top sheet carries **each linked drawing's own file**
  from the drawing register's bucket, at **the revision that RFA transmitted**. Read that
  module's `CLAUDE.md` before touching the link or the approval write-back.
  ⚠️ **RFI has no register, deliberately** — it is a question sheet, not a transmittal.
- `modules/method-register/` — live (Summary + Registry, migration `0013`);
  see `modules/method-register/CLAUDE.md`
- `modules/value-engineering/` — live (Summary + Registry, migration `0014`);
  see `modules/value-engineering/CLAUDE.md`
- `modules/initiatives/` — live (Overview + Registry, migration `0015`).
  ⚠️ **ORG-WIDE** — read `modules/initiatives/CLAUDE.md` before touching it; most of
  the project-scoping rules below are deliberately inverted there.
- `modules/portfolio/` — live (Overview + Programme + ISD status, **no migration**);
  see `modules/portfolio/CLAUDE.md`.
  ⚠️ **ORG-WIDE, and the second one** — so "the only org-wide module" is no longer
  true anywhere you read it. It owns no table: it reads `drawing_register` with **no
  project predicate** and lets RLS scope it, and its maths lives in
  `EngData.portfolio()` so there is one definition of "approved", not a second.
  ⚠️ **TWO COUNTING BASES, NEVER ADDED.** ISD is counted in **sheets** and matches the
  register exactly; design levels are counted in **drawings** here while the register
  counts them in **tracking units**. There is deliberately no blended "overall %", and
  the caveat is written into the Excel export as well as the page.
  ⚠️ **GROUP HEAD IS THE ORGANISING DIMENSION**, ordered by `group_heads.sort_order` —
  never alphabetically. Same for `projects.html`, where "Group by: Group Head" is now
  the default (the grouping already existed; the dropdown option did not).

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
   `config.js` (**Initiatives** and **Portfolio**) is meaningful with no project chosen,
   so it is never gated — gating it would make it **unreachable from a cold
   start**, since the only way to clear the gate is to choose a project it does
   not need. Such a module must correspondingly **never redirect to
   `projects.html`** from its own `init()`, and its table's RLS cannot use a bare
   `can_access_project(project_id)` — that is FALSE for a NULL project and would
   hide the entire table. See `modules/initiatives/CLAUDE.md` and
   `migrations/0015-initiatives.sql`.
