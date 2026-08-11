# Adding an engineering module

Adapted from the Planners Dashboard's `MODULE_CONTRACT.md` (kept verbatim at
`docs/PLANNING_APP_MODULE_CONTRACT.md` for reference). The rules are the same; the
shell differs in one good way — **navigation is config-driven here**, so adding a
module no longer means editing every HTML file.

Candidates the architecture is ready for: RFI Management, Technical Submittals,
Design Review, Technical Queries, Document Transmittal, Method Statement Register,
Inspection Requests, NCR Management.

---

## 1. The five steps

### 1. Register it

`assets/js/config.js`:

```js
{ key: 'rfi', name: 'RFI Management', path: 'modules/rfi/index.html',
  icon: 'clipboard', enabled: false },
```

`key` is both the folder name and the DB table prefix. Icons come from
`assets/js/icons.js`. Ship with `enabled: false` and flip it when the module works.

This one entry gives you the sidebar link (`nav.js`) and the dashboard launcher
card. **No shell file needs editing.**

### 2. Create the table

A new file `migrations/00NN-<key>.sql`, idempotent:

```sql
create table if not exists rfi (
  id          uuid primary key default gen_random_uuid(),
  project_id  text not null references projects(id),
  created_by  uuid references users(id),
  -- your columns here
  status      text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create index if not exists rfi_project_idx on rfi (project_id);

-- The standard 4-policy pattern. Copy it exactly — the shape is what makes
-- project scoping and viewer-readonly work.
alter table rfi enable row level security;

drop policy if exists rfi_read on rfi;
create policy rfi_read on rfi for select using (can_access_project(project_id));

drop policy if exists rfi_ins on rfi;
create policy rfi_ins on rfi for insert with check (
  is_writer() and created_by = auth.uid() and can_access_project(project_id));

drop policy if exists rfi_upd on rfi;
create policy rfi_upd on rfi for update
  using (is_writer() and can_access_project(project_id)
         and (created_by = auth.uid() or is_planner()))
  with check (is_writer() and can_access_project(project_id));

drop policy if exists rfi_del on rfi;
create policy rfi_del on rfi for delete
  using (is_writer() and can_access_project(project_id)
         and (created_by = auth.uid() or is_planner()));

grant select, insert, update, delete on rfi to authenticated;
```

> ⚠️ **`project_id` and `created_by` are not optional.** Every RLS policy above
> depends on them. A row missing either becomes invisible or unwritable.

**Audit trail** — one line, and the module inherits full traceability:

```sql
create trigger audit_rfi after insert or update or delete on rfi
  for each row execute function engineering_audit_trg();
```

Then add `'rfi'` to the `MOD` map in `EngData.activityRowHTML` so the feed says
"RFI" instead of the raw table name.

**Approval authority** — if the module has an approval step, add its decision
statuses to `engineering_decision_statuses()` and attach the guard:

```sql
create trigger guard_decision_rfi before update of status on rfi
  for each row execute function engineering_guard_decision();
```

**Files** — if it needs uploads, one private bucket named after the module key:

```sql
insert into storage.buckets (id, name, public) values ('rfi','rfi',false)
on conflict (id) do nothing;
```
plus the three storage policies (copy the `do $$` block from `0001` §9).

**Realtime** — for live multi-user editing:

```sql
alter publication supabase_realtime add table public.rfi;
alter table public.rfi replica identity full;   -- needed for the project_id filter
```

### 3. Build the page

`modules/rfi/index.html`. Copy the skeleton from
`modules/material-submittal/index.html` — it is the smaller of the two and already
carries the correct topbar, script order and permission wiring.

Required script order (module pages are one level deeper, hence `../../`):

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="../../assets/js/config.js?v=…"></script>
<script src="../../assets/js/auth.js?v=…"></script>
<script src="../../assets/js/db.js?v=…"></script>
<script src="../../assets/js/ui.js?v=…"></script>
<script src="../../assets/js/icons.js?v=…"></script>
<script src="../../assets/js/perm.js?v=…"></script>
<script src="module.js?v=…"></script>
<script>
  AppAuth.requireLogin(function (user, profile) {
    UI.renderUserBar(profile);
    Rfi.init(user, profile);
    Perm.applyReadonly(document, profile);
  });
</script>
```

Tag write actions declaratively:

```html
<button data-perm="create">+ Add</button>
<button data-perm="approve" data-perm-mode="disable">Approve</button>
```

### 4. Use the shared layer — do not reinvent it

| Need | Use | Never |
|---|---|---|
| Session, current user | `AppAuth.requireLogin` | your own session check |
| Project list, workspaces | `PDb.getProjects()` / `getWorkspaces()` | a direct `projects` query |
| Project picker | `UI.enhanceProjectSelect(sel)` | a plain `<select>` |
| Toast, modal, user bar | `UI.toast/modal/renderUserBar` | a bespoke dialog |
| **Escaping user text** | `Fmt.esc(value)` | raw interpolation into `innerHTML` |
| Money / dates | `Fmt.money` / `Fmt.date` | ad-hoc formatting |
| Icons | `Icons.svg(name, size)` | text glyphs (✎ ✕ ▾) |
| Permissions | `Perm.can` / `applyReadonly` | reading `profile.role` inline |
| Live collaboration | `PDCollab.join({...})` | a bespoke channel |
| Offline writes | `PDSync.write({...})` | a bespoke queue |

> ⚠️ **`Fmt.esc` on every piece of user-supplied text you put into HTML.** These
> modules build their tables with `innerHTML` string templating, so a drawing
> title is an XSS vector without it.

### 5. Styling

Use `assets/css/dashboard.css` tokens and classes: `.pd-card`, `.pd-btn`,
`.pd-input`, `.pd-select`, `.pd-table`, `.pd-modal`, `.pd-toast`. Reusable
engineering pieces (KPI grid, status bars, activity feed, status chips) are in
`assets/css/engineering.css`.

> ⚠️ **Never hardcode a colour.** Dark mode works by remapping the `--pd-*`
> variables under `html.pd-dark`; a literal hex silently breaks it. This has bitten
> the Planning App repeatedly — one register's level rail was hardcoded `#2b2c2b`,
> which *is* `--pd-card` in dark mode, giving 1.13:1 contrast.
>
> ⚠️ **Status chips: soft tint + dark text, never white on a saturated fill.**
> White 11px bold on solid fills measured 3.46–4.12:1, below the 4.5:1 that size
> requires. Follow the `.eng-chip` pattern (set `--c` on a status class; the chip
> and bar both derive from it).

---

## 2. Rules that are load-bearing

1. **Own your folder.** Change files under `modules/<key>/`, plus your own
   migration and your one line in `config.js`. Nothing else.
2. **Never query another module's table.** Cross-module reads belong in
   `assets/js/engdata.js`, which is the shell's sanctioned read-only aggregation
   layer.
3. **Paginate every list read.** PostgREST caps a select at **1000 rows** and
   returns no error. Use a keyset loop on `id` (`fetchAll` in `engdata.js` is the
   reference). This has silently truncated four Planning App modules.
4. **Project-scope every query** with `.eq('project_id', pid)`, where `pid` comes
   from `sessionStorage['pd_project']`.
5. **Store the object PATH, not a URL,** for uploads. Buckets are private; sign on
   demand with `createSignedUrl(path, 60)`. A stored URL expires.
6. **Upload before the row write**, and roll the object back if the write fails —
   otherwise a failed save orphans a file, or a row points at nothing.
7. **Preserve history.** Never overwrite a prior revision in place. Model
   revisions as an append-only jsonb array (Drawing Register) or as separate rows
   (Material Submittal) — and pick one deliberately.
8. **Bump `?v=` on any asset you change**, in every HTML file that references it.
9. **Server-side or it isn't enforced.** Every permission needs its Postgres rule.

---

## 3. Wiring into the dashboard

To add KPI cards for a new module, add a stats function to `assets/js/engdata.js`
following `drawingStats` / `submittalStats` (page with `fetchAll`, aggregate in
memory, return plain numbers plus a `byStatus` array), then add a section to
`dashboard.html` mirroring an existing one.

> ⚠️ Status vocabularies are **duplicated** in `engdata.js` because there is no
> module system to import a module's constants. If you change your module's status
> list, change it there too, or the dashboard under-counts silently.
> `EngData.selfTest(pid)` in the console reports statuses present in the data that
> the dashboard does not recognise.

---

## 4. Definition of done

- [ ] Full CRUD, project-scoped, `created_by` stamped on insert
- [ ] Migration idempotent and committed; RLS policies in place
- [ ] Audit trigger attached
- [ ] `Fmt.esc` on all injected user text
- [ ] List reads keyset-paginated past 1000 rows
- [ ] Shared auth / UI / icons used; no hardcoded colours; dark mode checked
- [ ] Write actions tagged `data-perm`; **and** the matching DB rule exists
- [ ] Verified as a `viewer` and as a `user` that the database refuses what the UI hides
- [ ] Responsive at 375 / 768 / 1280 with no horizontal page scroll
- [ ] `enabled: true` in `config.js`; asset `?v=` bumped
- [ ] `modules/<key>/CLAUDE.md` written — what it does, its migration, and the
      traps you hit. Both existing modules keep a detailed one; they are the most
      useful documents in the codebase.
