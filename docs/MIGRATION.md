# Migration — Planners Dashboard → Engineering App

How the Drawing Register and Material Submittal Log move out of the Planners
Dashboard, what is preserved, and what unavoidably changes.

---

## 1. The decision that shapes everything

The Engineering App runs on a **new, separate Supabase project**:

| | Planners Dashboard | Engineering App |
|---|---|---|
| Supabase project | `bgupuqnkqhixpuctyder` | `zkxzaijznutmiueeurbb` |
| Repository | `PMODepartment/planning-app` | `PMODepartment/engineering-app` |

Two Supabase projects cannot share an `auth.users` table, a session, or a foreign
key. Everything below follows from that.

### What this costs

| | Effect |
|---|---|
| **Logins** | ❌ Not shared. Password hashes are not portable between projects, so a Planning App account does not work here. Every user registers once in the Engineering App and is approved by an Engineering App admin. |
| **Records** | ✓ Preserved, by an explicit copy — ids, timestamps and revision history included. |
| **Uploaded files** | ✓ Preserved, downloaded from the old bucket and re-uploaded to the new one. |
| **Row ownership** | ⚠️ Rewritten. See §3. |
| **Audit history** | n/a — the Planning App has no audit table, so there is nothing to carry over. The Engineering App's trail starts at cutover. |

> If shared logins later become a requirement, the only real fix is to point
> `assets/js/config.js` back at `bgupuqnkqhixpuctyder`. Everything else in this
> app works unchanged against that project — the schema in `0001` is that
> project's schema.

---

## 2. What is copied

In dependency order (`migrate-data.mjs` enforces it):

| Source table | Destination | Note |
|---|---|---|
| `workspaces` | `workspaces` | Workspace → Program → Group tree. Ids preserved. |
| `projects` | `projects` | Ids preserved — this is what lets project context carry across from the Planning App. |
| `users` | **`legacy_users`** | Attribution only, **not** real accounts. See §3. |
| `drawing_register` | `drawing_register` | All 46 columns incl. the `submissions` revision array, the `parent_id` sheet tree and `node_kind`. |
| `material_submittal` | `material_submittal` | All 41 columns incl. `revision_no`. |
| bucket `drawing-register` | same | Object paths preserved, so `file_url` keeps resolving. |
| bucket `material-submittal` | same | Same. |

Everything is an **upsert keyed on `id`**, so the script is idempotent — run it
again to pick up late edits before cutover without creating duplicates.

**Not copied:** every other Planning App module (`progress_photos`,
`risk_register`, `project_schedule`, `cash_flow`, …). Those stay in the Planners
Dashboard, which continues to run untouched.

---

## 3. Ownership — the one genuinely tricky part

`users.id` references `auth.users(id)`, and `drawing_register.created_by`
references `users(id)`. The original authors have no auth account in the new
project, so **their rows cannot be inserted as-is — the foreign key rejects
them.**

The resolution, implemented in `0003-legacy-ownership.sql`:

1. Original profiles are copied into **`legacy_users`** — same ids, names, emails
   and roles, but **no foreign key** to `auth.users`. Attribution only.
2. Each migrated row lands with `created_by = null` and
   `legacy_created_by = <original uuid>`. So "originally created by Juan Dela
   Cruz" is still answerable; use `engineering_author(created_by, legacy_created_by)`.
3. When Juan registers here and is approved, run:
   ```bash
   node migrations/migrate-data.mjs --relink-users
   ```
   It matches on email, rewrites his rows' `created_by` to his new auth uuid, and
   records `legacy_users.relinked_to`. Safe to re-run after every batch of
   approvals; it only touches rows still unowned, and only for users whose account
   is already **approved** — a pending registration cannot pick up edit rights early.
4. Track what is outstanding:
   ```sql
   select * from legacy_ownership_pending;
   ```

### The knock-on effect: planners can now edit any record

The inherited RLS policy was `created_by = auth.uid() or is_admin()`. With
migrated rows unowned, that would have made **every historical record
admin-only-editable** — locking out the planners who actually maintain these
registers.

`0003` therefore widens update/delete to `created_by = auth.uid() or
is_planner()`. This is a deliberate authorization change, and the right rule for
a controlled-document register: the register belongs to the engineering team, not
to whoever first typed the row. `viewer` still writes nothing; a plain `user`
still edits only their own rows. Nobody loses access — `is_planner()` already
includes admin and super_admin.

---

## 4. Procedure

### 4.1 Before you start

- [ ] Publishable key set in `assets/js/config.js`
- [ ] Note the current source row counts, to compare afterwards:
  ```sql
  select 'drawings' t, count(*) from drawing_register
  union all select 'submittals', count(*) from material_submittal
  union all select 'projects', count(*) from projects;
  ```
- [ ] Have both **service_role** keys to hand (Settings → API). These bypass RLS,
      which the copy requires. **Never commit them.**

### 4.2 Schema

Run in the Engineering App's SQL editor:

1. `migrations/0001-engineering-core.sql`
2. `migrations/0003-legacy-ownership.sql`

Hold `0002` until after the import — see §4.4.

### 4.3 Copy the data

```bash
export SRC_URL=https://bgupuqnkqhixpuctyder.supabase.co
export SRC_SERVICE_KEY=…
export DST_URL=https://zkxzaijznutmiueeurbb.supabase.co
export DST_SERVICE_KEY=…

node migrations/migrate-data.mjs --dry-run    # report only, writes nothing
node migrations/migrate-data.mjs              # do it
```

The dry run prints source counts and what would be re-attributed. The real run
ends with a source → destination count comparison per table; any `⚠️ MISMATCH`
must be understood before continuing.

Useful flags: `--only=projects,drawing_register`, `--skip-files`.

### 4.4 The audit trail and the import

```
migrations/0002-engineering-audit-and-approval.sql
migrations/0004-harden-audit-grants.sql
```

> ### ⚠️ If `0002` is ALREADY applied (it is, as of 2026-08-11)
>
> The audit triggers are live, so the bulk import **will** be recorded — roughly
> one audit row per imported record, all attributed to "(deleted user)", because
> `migrate-data.mjs` runs as `service_role` where `auth.uid()` is NULL. On a
> ~1,500-drawing register that buries the real change history from day one.
>
> **Disable the two triggers for the duration of the import.** Run this in the SQL
> editor immediately before `migrate-data.mjs`:
>
> ```sql
> alter table drawing_register   disable trigger audit_drawing_register;
> alter table material_submittal disable trigger audit_material_submittal;
> ```
>
> …run the import, then turn them straight back on:
>
> ```sql
> alter table drawing_register   enable trigger audit_drawing_register;
> alter table material_submittal enable trigger audit_material_submittal;
> ```
>
> Confirm they are back before anyone uses the app — a silently disabled audit
> trigger is worse than none, because the trail looks healthy while recording
> nothing:
>
> ```sql
> select tgrelid::regclass as table_name, tgname, tgenabled  -- 'O' = enabled, 'D' = disabled
> from pg_trigger
> where tgname in ('audit_drawing_register','audit_material_submittal');
> ```
>
> Then check the trail really is empty of import noise:
> `select count(*) from engineering_audit;` → expect **0**.

> ⚠️ **Order matters.** `0002` puts an audit trigger on both module tables, and
> the import runs as `service_role` where `auth.uid()` is NULL. Applying `0002`
> first would insert one audit row per imported record — ~1,500 entries
> attributed to "(deleted user)" — burying real changes under synthetic noise.
>
> If you must re-import after `0002` is applied, disable the triggers for the
> duration (see the header comment in `migrate-data.mjs`).

### 4.5 Accounts

1. Ask each engineering user to open the Engineering App and **Request access**.
2. They must **click the confirmation link** emailed to them, then **sign in once**.
3. In **Administration**, approve each one and set the role to match what they had
   in the Planners Dashboard (`legacy_users.role` records it), then assign their
   projects.
4. After each batch: `node migrations/migrate-data.mjs --relink-users`

> ⚠️ **Step 2 is not optional, and it changes what admins see.** This Supabase
> project has **"Confirm email" enabled** (`mailer_autoconfirm: false`), so
> `signUp()` returns no session. `AppAuth.register()` tries to insert the `users`
> profile row immediately afterwards, but with no session `auth.uid()` is NULL and
> the `users_self_insert` policy (`auth.uid() = id`) rejects it.
>
> **So a person who registers but never confirms does not appear in Administration
> at all** — there is no profile row to list yet. It is created by `auth.js`'s
> `ensureProfile()` self-heal on their first successful sign-in. If an admin says
> "I can't find them to approve them", the answer is almost always that the user
> hasn't clicked the email.
>
> The registration screen states this explicitly, so users aren't left waiting on
> an approval that nobody can give.
>
> **If you would rather skip the email step:** Supabase dashboard →
> Authentication → Providers → Email → turn **Confirm email** off. Registration
> then returns a session, the profile row is created immediately, and the person
> shows up in Administration right away. Defensible for an internal app where
> access still requires explicit admin approval — the confirmation email is
> proving control of the mailbox, and admin approval already gates entry. Your
> call; the registration screen adapts to either setting automatically.

### 4.6 Verify

- [ ] Row counts match the §4.1 baseline
- [ ] Open a drawing with several revisions — full history present
- [ ] Open an attached file — the signed URL resolves
- [ ] A `viewer` sees no Add/Import buttons **and** a direct write is rejected by
      the database (the real test — hidden buttons prove nothing)
- [ ] A `user` cannot set a status to Approved; a `planner` can
- [ ] The Engineering Dashboard's totals match the modules' own counts
- [ ] `notifications.html` shows entries once you make a change
- [ ] The Planners Dashboard still works: open two other modules and confirm login
      and project selection are unaffected

---

## 5. The Planning App side

Both module folders now hold a **redirect stub** at `modules/<key>/index.html`: a
branded interstitial explaining the move, carrying `?project=<id>` across, and
redirecting after 5 seconds (cancellable).

An interstitial rather than a bare HTTP redirect on purpose — the Engineering App
has a separate login, and silently bouncing a user to a sign-in screen reads as
"the app logged me out".

`module.js` and `module.css` are **still on disk** beside each stub, unreferenced.
They are the rollback path: restoring either module is reverting one file. Remove
them only once the Engineering App is validated in production:

```bash
git rm modules/drawing-register/module.js modules/drawing-register/module.css \
       modules/material-submittal/module.js modules/material-submittal/module.css
```

### One shared-file change was needed

`sw.js` in **both** apps. Both are served from `pmodepartment.github.io`, and
Cache Storage is per-**origin**, not per service-worker scope. The original
`activate` handler deleted every cache key that was not its own — so each app's
service worker would wipe the other app's offline cache on every activation.
Purging is now scoped to each app's own prefix (`pd-shell-` / `eng-shell-`).
Backward compatible: each still purges its own old versions.

---

## 6. Rollback

| Scenario | Action |
|---|---|
| Engineering App unusable | Revert the two Planning App stub files. The original modules work immediately — their code is still on disk and the Planning App's Supabase project was never modified. |
| Bad data import | Re-run `migrate-data.mjs` (idempotent upsert). To start clean: `truncate drawing_register, material_submittal;` then re-run. |
| Wrong ownership relink | `legacy_users.relinked_to` records every mapping, so it can be reversed by hand. |

The Planning App's database was **only read** during migration. Nothing in
`bgupuqnkqhixpuctyder` was altered, so that app is always a safe fallback.
