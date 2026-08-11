-- ============================================================================
-- ENGINEERING APP — consolidated Supabase schema (FINAL state, single paste)
--
-- Derived from the Planning App by replaying supabase-schema.sql + every
-- migration that touches the platform layer, `drawing_register`, or
-- `material_submittal`. Only those pieces are included — no other module tables.
--
-- Fully idempotent: create ... if not exists / add column if not exists /
-- drop policy if exists before create policy / create or replace function.
-- Run in the Supabase SQL Editor of the NEW (empty) Engineering project.
--
-- Source migrations folded in:
--   supabase-schema.sql (base)
--   2026-06-18-fix-rls-recursion.sql       2026-06-18-grants.sql
--   2026-06-18-project-access-rls.sql      2026-06-18-admin-delete-user.sql
--   2026-06-18-storage-buckets.sql         2026-06-30-workspaces-project-selector.sql
--   2026-07-14-grant-service-role.sql      2026-07-16-consolidated.sql (§2 + §3 only)
--   2026-07-16-drawing-register-full.sql   2026-07-16-drawing-register-nodes.sql
--   2026-07-20-material-submittal-full.sql
--   2026-07-20-material-submittal-storage-delete.sql
--   2026-07-20-storage-planner-delete-all-buckets.sql
--   2026-07-21-rls-project-scope-fix.sql (no-op here: touches schedule tables only)
--   2026-07-21-viewer-readonly.sql
--   2026-07-25-schedule-document-links.sql  <-- NOT in the original list; it adds
--                                               3 columns to BOTH module tables
--   2026-07-26-realtime-collab.sql          2026-07-26-realtime-collab-registers.sql
--   2026-07-26-realtime-collab-material-submittal.sql
--   2026-08-05-drawing-register-sheets.sql  2026-08-11-drawing-register-scope.sql
-- ============================================================================


-- ============================================================================
-- SECTION 1 — PLATFORM: core tables (workspaces, projects, users)
-- ============================================================================

-- ---- workspaces (Workspace → Program → Group tree; owns projects) ----------
create table if not exists workspaces (
  id          text primary key,                  -- short code, e.g. 'PMO', 'CALIMAG'
  name        text not null,
  code        text,                              -- short prefix used in list grouping
  parent_id   text references workspaces(id),    -- null = root
  node_type   text default 'workspace'
                check (node_type in ('workspace','program','group')),
  group_head  text,
  sort_order  int  default 0,
  created_at  timestamptz default now()
);

-- ---- projects --------------------------------------------------------------
create table if not exists projects (
  id          text primary key,                  -- e.g. 'AVR101'
  name        text not null,
  location    text,
  status      text default 'active',             -- active | archived
  start_date  date,
  end_date    date,
  created_at  timestamptz default now()
);

-- later-added project columns (2026-06-30-workspaces-project-selector.sql)
alter table projects add column if not exists workspace_id    text references workspaces(id);
alter table projects add column if not exists group_head      text;
alter table projects add column if not exists description     text;
alter table projects add column if not exists project_manager text;
alter table projects add column if not exists forecast_start  date;
alter table projects add column if not exists forecast_finish date;
alter table projects add column if not exists original_budget numeric;
alter table projects add column if not exists estimated_cost  numeric;

-- NOTE: the Planning App's `projects` also carries schedule-rollup cache columns
-- (schedule_progress / schedule_start / schedule_finish / schedule_activities /
-- schedule_updated_at). They are written ONLY by the Project Schedule module,
-- which the Engineering App does not have, so they are intentionally omitted.
-- Uncomment if you later port that module:
-- alter table projects add column if not exists schedule_progress    numeric;
-- alter table projects add column if not exists schedule_start       date;
-- alter table projects add column if not exists schedule_finish      date;
-- alter table projects add column if not exists schedule_activities  integer;
-- alter table projects add column if not exists schedule_updated_at  timestamptz;

-- ---- users (profile mirror of auth.users) ----------------------------------
create table if not exists users (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text,
  email       text,
  role        text default 'user'
                check (role in ('super_admin','admin','planner','user','viewer')),
  status      text default 'pending'
                check (status in ('pending','approved','rejected')),
  projects    text[] default '{}',               -- assigned project ids
  last_login  timestamptz,
  created_at  timestamptz default now()
);


-- ============================================================================
-- SECTION 2 — RLS HELPER FUNCTIONS (final versions)
-- All SECURITY DEFINER + fixed search_path so they read `users` bypassing RLS —
-- this is what prevents the 54001 infinite-recursion bug
-- (2026-06-18-fix-rls-recursion.sql). Each only inspects auth.uid()'s own row.
-- ============================================================================

create or replace function is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from users u
    where u.id = auth.uid() and u.status = 'approved' and u.role in ('admin','super_admin')
  );
$$;

create or replace function is_approved() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from users u where u.id = auth.uid() and u.status = 'approved');
$$;

-- approved AND not a viewer (viewer is read-only) — 2026-07-21-viewer-readonly.sql
create or replace function is_writer() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from users u
    where u.id = auth.uid() and u.status = 'approved' and u.role <> 'viewer'
  );
$$;

-- approved AND role in (super_admin, admin, planner) — 2026-06-30 migration
create or replace function is_planner() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from users u
    where u.id = auth.uid() and u.status = 'approved'
      and u.role in ('super_admin','admin','planner')
  );
$$;

-- admins: all projects; everyone else: only ids in their users.projects array
create or replace function can_access_project(pid text) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from users u
    where u.id = auth.uid() and u.status = 'approved'
      and (u.role in ('admin','super_admin') or pid = any(u.projects))
  );
$$;


-- ============================================================================
-- SECTION 3 — GRANTS (required IN ADDITION to RLS)
-- PostgREST runs as `authenticated`/`anon`; without table GRANTs every request
-- fails 42501 before RLS is even evaluated. `anon` gets schema usage only.
-- service_role grants: 2026-07-14-grant-service-role.sql (Edge Functions).
-- ============================================================================

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on all tables    in schema public to authenticated;
grant select, insert, update, delete on all tables    in schema public to service_role;
grant usage, select                 on all sequences  in schema public to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to service_role;


-- ============================================================================
-- SECTION 4 — RLS: users / projects / workspaces
-- ============================================================================

alter table users      enable row level security;
alter table projects   enable row level security;
alter table workspaces enable row level security;

-- users -----------------------------------------------------------------------
drop policy if exists users_self_read on users;
create policy users_self_read   on users for select using (auth.uid() = id or is_admin());
drop policy if exists users_self_insert on users;
create policy users_self_insert on users for insert with check (auth.uid() = id);
drop policy if exists users_admin_update on users;
create policy users_admin_update on users for update using (auth.uid() = id or is_admin());

-- projects --------------------------------------------------------------------
-- SELECT is the ONLY read gate; write policies are PER-COMMAND on purpose.
-- `for all` would also cover SELECT and OR with projects_read, letting planners
-- see unassigned projects (2026-07-16-consolidated.sql §2 security fix).
drop policy if exists projects_read         on projects;
create policy projects_read on projects for select using (is_admin() or can_access_project(id));

drop policy if exists projects_admin_write  on projects;
drop policy if exists projects_write        on projects;
drop policy if exists projects_ins          on projects;
drop policy if exists projects_upd          on projects;
drop policy if exists projects_del          on projects;

-- INSERT stays unscoped: a brand-new project isn't in anyone's array yet.
create policy projects_ins on projects for insert
  with check (is_planner());
create policy projects_upd on projects for update
  using      (is_planner() and (is_admin() or can_access_project(id)))
  with check (is_planner() and (is_admin() or can_access_project(id)));
create policy projects_del on projects for delete
  using      (is_planner() and (is_admin() or can_access_project(id)));

-- workspaces (org structure, not project data → any approved user may read) ---
drop policy if exists workspaces_read on workspaces;
create policy workspaces_read  on workspaces for select using (is_approved());
drop policy if exists workspaces_write on workspaces;
create policy workspaces_write on workspaces for all
  using (is_planner()) with check (is_planner());

grant select, insert, update, delete on workspaces to authenticated;


-- ============================================================================
-- SECTION 5 — ADMIN RPC FUNCTIONS
-- ============================================================================

-- Delete a user completely: removes auth.users (cascades to public.users) so the
-- email is freed for re-registration. Authorship is nulled, their data is kept.
-- Admin-only, no self-delete, only a super_admin may delete a super_admin.
create or replace function admin_delete_user(target uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if target = auth.uid() then raise exception 'You cannot delete your own account'; end if;
  if exists (select 1 from users where id = target and role = 'super_admin')
     and not exists (select 1 from users where id = auth.uid() and role = 'super_admin') then
    raise exception 'Only a super admin can delete a super admin';
  end if;

  -- keep their data, drop the authorship link (avoids FK restrict on delete)
  for r in
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'created_by'
  loop
    execute format('update public.%I set created_by = null where created_by = %L', r.table_name, target);
  end loop;

  delete from auth.users where id = target;
end $$;

-- Archive is the primary "remove a project" action (module rows hold FKs to it).
-- No new column: projects.status ('active' | 'archived') already means this.
create or replace function admin_archive_project(target text, archive boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not exists (select 1 from projects where id = target) then
    raise exception 'Project % not found', target;
  end if;
  update projects
     set status = case when archive then 'archived' else 'active' end
   where id = target;
end $$;

-- Hard delete — empty-only escape hatch. The table list is discovered from the
-- pg catalog (any table with a project_id column), so modules added later are
-- covered automatically.
create or replace function admin_delete_project(target text)
returns void language plpgsql security definer set search_path = public as $$
declare
  t        text;
  n        bigint;
  blockers text := '';
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not exists (select 1 from projects where id = target) then
    raise exception 'Project % not found', target;
  end if;

  for t in
    select c.relname
      from pg_attribute a
      join pg_class c      on c.oid = a.attrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind = 'r'
       and a.attname = 'project_id' and a.attnum > 0 and not a.attisdropped
       and c.relname <> 'projects'
     order by c.relname
  loop
    execute format('select count(*) from %I where project_id = $1', t) into n using target;
    if n > 0 then blockers := blockers || format('%s (%s), ', t, n); end if;
  end loop;

  if blockers <> '' then
    raise exception 'Project % still has data in: %. Archive it instead, or clear these first.',
      target, rtrim(blockers, ', ');
  end if;

  -- users.projects is a text[] with no FK — strip the id so assignments don't dangle.
  update users set projects = array_remove(projects, target)
   where projects @> array[target];

  delete from projects where id = target;
end $$;

create or replace function admin_delete_workspace(target text)
returns void language plpgsql security definer set search_path = public as $$
declare kids bigint; projs bigint;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not exists (select 1 from workspaces where id = target) then
    raise exception 'Workspace % not found', target;
  end if;

  select count(*) into kids  from workspaces where parent_id    = target;
  select count(*) into projs from projects   where workspace_id = target;

  if kids > 0 or projs > 0 then
    raise exception
      'Cannot delete %: it still contains % child workspace/program(s) and % project(s). Move or remove them first.',
      target, kids, projs;
  end if;

  delete from workspaces where id = target;
end $$;

grant execute on function admin_delete_user(uuid)              to authenticated;
grant execute on function admin_archive_project(text, boolean) to authenticated;
grant execute on function admin_delete_project(text)           to authenticated;
grant execute on function admin_delete_workspace(text)         to authenticated;


-- ============================================================================
-- SECTION 6 — MODULE TABLE: drawing_register (FINAL shape)
-- Base (supabase-schema.sql) + 2026-07-16-full + 2026-07-16-nodes
-- + 2026-07-25-schedule-document-links + 2026-08-05-sheets + 2026-08-11-scope.
-- Written out as one full CREATE (all columns already merged), with the ALTERs
-- repeated afterwards so this is safe on a DB built from an older copy.
-- ============================================================================

create table if not exists drawing_register (
  id             uuid primary key default gen_random_uuid(),
  project_id     text references projects(id),
  drawing_no     text,
  title          text,
  discipline     text,
  revision       text,
  status         text,      -- For Review | Revise & Resubmit | Approved w/ comments
                            -- | Approved w/o comments | Approved | Superseded
  issue_date     date,
  due_date       date,
  file_url       text,      -- Storage path in the 'drawing-register' bucket
  remarks        text,

  -- structured drawing code parts (workbook "Coding Reference" sheet):
  -- <proj_code>-<building_ref>-<company>-<drawing_type>-<discipline>-<floor_level>-<dwg_number>-<revision>
  proj_code      text,
  building_ref   text,      -- TW1..TW9 / GEN
  company        text,      -- MCC (Megawide) / subcontractor acronym
  drawing_type   text,      -- ECD/SD1/SD2/FCD/CSD/ISD/DRC
  floor_level    text,      -- GEN/FD/GF/2F.. / RDF / RORD
  dwg_number     text,      -- numeric sheet no (4750, A-101)
  drawing_code   text,      -- full composed code (also = drawing_no)

  -- grouping / classification
  phase          text,      -- Concept Design / Schematic Design 1 / 2 / For Construction
  category       text,      -- Floor Plan / Elevation / Section
  description    text,
  responsible    text,      -- consultant / party (ECTA, RBS, In-House)

  -- progress
  no_of_sheets    integer default 1,
  approved_sheets integer default 0,
  approved_pct    numeric,                      -- 0..1

  -- submission tracking across revisions: [{rev, planned, actual}, ...]
  submissions      jsonb default '[]'::jsonb,
  planned_approval date,
  actual_approval  date,

  sort_order      integer default 0,
  node_kind       text default 'drawing',       -- phase | discipline | category | drawing

  -- schedule link (2026-07-25) — plain text, NO FK on purpose: it targets
  -- project_schedule.activity_id (business key), which survives P6 re-imports.
  -- ⚠️ OPEN ITEM for the Engineering App: there is no project_schedule table
  -- here, so these three columns are inert until/unless a schedule module lands.
  schedule_activity_id text,
  schedule_wbs         text,
  lead_days            int,

  -- per-sheet matrix (2026-08-05): a sheet is an ordinary row pointing at its
  -- parent drawing; the parent's sheet counters become derived roll-ups.
  parent_id      uuid references drawing_register(id) on delete cascade,

  -- scope (2026-08-11)
  scope          text not null default 'Main Contract',   -- Main Contract | Change Order

  created_by     uuid references users(id),
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- idempotent re-assertion of every later-added column
alter table drawing_register add column if not exists proj_code            text;
alter table drawing_register add column if not exists building_ref         text;
alter table drawing_register add column if not exists company              text;
alter table drawing_register add column if not exists drawing_type         text;
alter table drawing_register add column if not exists floor_level          text;
alter table drawing_register add column if not exists dwg_number           text;
alter table drawing_register add column if not exists drawing_code         text;
alter table drawing_register add column if not exists phase                text;
alter table drawing_register add column if not exists category             text;
alter table drawing_register add column if not exists description          text;
alter table drawing_register add column if not exists responsible          text;
alter table drawing_register add column if not exists no_of_sheets         integer default 1;
alter table drawing_register add column if not exists approved_sheets      integer default 0;
alter table drawing_register add column if not exists approved_pct         numeric;
alter table drawing_register add column if not exists submissions          jsonb default '[]'::jsonb;
alter table drawing_register add column if not exists planned_approval     date;
alter table drawing_register add column if not exists actual_approval      date;
alter table drawing_register add column if not exists sort_order           integer default 0;
alter table drawing_register add column if not exists node_kind            text default 'drawing';
alter table drawing_register add column if not exists schedule_activity_id text;
alter table drawing_register add column if not exists schedule_wbs         text;
alter table drawing_register add column if not exists lead_days            int;
alter table drawing_register add column if not exists parent_id            uuid references drawing_register(id) on delete cascade;
alter table drawing_register add column if not exists scope                text not null default 'Main Contract';

update drawing_register set node_kind = 'drawing'      where node_kind is null;
update drawing_register set scope     = 'Main Contract' where scope     is null;

create index if not exists drawing_register_project_sort_idx on drawing_register (project_id, sort_order);
create index if not exists drawing_register_kind_idx         on drawing_register (project_id, node_kind, sort_order);
create index if not exists drawing_register_sched_act_idx    on drawing_register (project_id, schedule_activity_id);
create index if not exists drawing_register_parent_idx       on drawing_register (parent_id);

comment on column drawing_register.parent_id is
  'Sheet rows point at their parent drawing. NULL = a normal drawing (or a structural node).';
comment on column drawing_register.schedule_activity_id is
  'Links to project_schedule.activity_id (business key, survives re-import). '
  'The activity''s start is the drawing''s need-by date.';
comment on column drawing_register.lead_days is
  'Days the drawing must be approved BEFORE the linked activity starts. '
  'NULL = project default (~30). required_approval = activity_start - lead_days.';


-- ============================================================================
-- SECTION 7 — MODULE TABLE: material_submittal (FINAL shape)
-- Base (supabase-schema.sql) + 2026-07-20-material-submittal-full
-- + 2026-07-25-schedule-document-links.
-- ============================================================================

create table if not exists material_submittal (
  id              uuid primary key default gen_random_uuid(),
  project_id      text references projects(id),
  submittal_no    text,      -- full composed 7-part code
  material        text,      -- workbook "Item"
  specification   text,
  supplier        text,      -- workbook "Vendor"
  status          text,      -- see comment below
  date_submitted  date,      -- ACTUAL submission date
  date_required   date,      -- Required Date Baseline
  date_approved   date,      -- ACTUAL approval date (drives the S-curve actual)
  file_url        text,      -- Storage path in the 'material-submittal' bucket
  remarks         text,

  -- 7-part structured submittal number:
  -- <project>-<building>-<company>-<doctype>-<discipline>-<floor>-<number>
  code_project    text,
  code_building   text,
  code_company    text,
  code_doctype    text,
  code_discipline text,
  code_floor      text,
  code_number     text,

  -- classification
  trade_section   text,      -- workbook section headers (GENERAL REQUIREMENT, REBAR, …)
  discipline      text,      -- CL/ST/AR/ME/EL/PL/FP… → drives the dashboard S-curve
  trade_code      text,      -- legacy redundant "Trades" column, Excel-parity only
  floor_levels    text,
  location        text,

  -- item detail
  reference_document text,
  brand              text,
  type_presentation  text,   -- Sample Board | Mock Up | Brochure and Technical
                             -- Data Sheet | Sample | Product Certification | Test Results

  -- planned half of each date pair
  plan_submission_date date,
  plan_approval_date   date, -- PLANNED series of the dashboard S-curve

  -- approval / revision
  approver_consultant text,
  approver_client     text,
  revision_no         text,
  mas_id              text,

  -- ordering
  seq_no     int,            -- workbook's visible "NO." (display only)
  sort_order int default 0,  -- stable ordering within a trade section

  -- schedule link (2026-07-25) — see the same OPEN ITEM note on drawing_register
  schedule_activity_id text,
  schedule_wbs         text,
  lead_days            int,

  created_by      uuid references users(id),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- idempotent re-assertion of every later-added column
alter table material_submittal add column if not exists code_project         text;
alter table material_submittal add column if not exists code_building        text;
alter table material_submittal add column if not exists code_company         text;
alter table material_submittal add column if not exists code_doctype         text;
alter table material_submittal add column if not exists code_discipline      text;
alter table material_submittal add column if not exists code_floor           text;
alter table material_submittal add column if not exists code_number          text;
alter table material_submittal add column if not exists trade_section        text;
alter table material_submittal add column if not exists discipline           text;
alter table material_submittal add column if not exists trade_code           text;
alter table material_submittal add column if not exists floor_levels         text;
alter table material_submittal add column if not exists location             text;
alter table material_submittal add column if not exists reference_document   text;
alter table material_submittal add column if not exists brand                text;
alter table material_submittal add column if not exists type_presentation    text;
alter table material_submittal add column if not exists plan_submission_date date;
alter table material_submittal add column if not exists plan_approval_date   date;
alter table material_submittal add column if not exists approver_consultant  text;
alter table material_submittal add column if not exists approver_client      text;
alter table material_submittal add column if not exists revision_no          text;
alter table material_submittal add column if not exists mas_id               text;
alter table material_submittal add column if not exists seq_no               int;
alter table material_submittal add column if not exists sort_order           int default 0;
alter table material_submittal add column if not exists schedule_activity_id text;
alter table material_submittal add column if not exists schedule_wbs         text;
alter table material_submittal add column if not exists lead_days            int;

create index if not exists material_submittal_project_idx    on material_submittal(project_id);
create index if not exists material_submittal_discipline_idx on material_submittal(project_id, discipline);
create index if not exists material_submittal_status_idx     on material_submittal(project_id, status);
create index if not exists material_submittal_sched_act_idx  on material_submittal(project_id, schedule_activity_id);

comment on column material_submittal.status is
  'Approved | Approved w/ Comments | Resubmit | Rejected | For Information | For Submission | Pending Approval';
comment on column material_submittal.discipline is
  'Discipline code (CL/ST/AR/ME/EL/PL/FP…) — drives the dashboard S-curve grouping.';
comment on column material_submittal.plan_approval_date is
  'Planned approval date — the PLANNED series of the dashboard S-curve.';
comment on column material_submittal.date_approved is
  'Actual approval date — the ACTUAL series of the dashboard S-curve.';
comment on column material_submittal.schedule_activity_id is
  'Links to project_schedule.activity_id (business key, survives re-import). '
  'The activity''s start is the submittal''s need-by date.';
comment on column material_submittal.lead_days is
  'Days the material must be approved BEFORE the linked activity starts '
  '(procurement + delivery lead). NULL = project default (~45).';


-- ============================================================================
-- SECTION 8 — MODULE-TABLE RLS (final: viewer-readonly writes, scoped reads)
-- read  : can_access_project(project_id)
-- ins   : is_writer() and created_by = auth.uid() and can_access_project(...)
-- upd   : is_writer() and can_access_project(...) and (own row or admin)
-- del   : is_writer() and can_access_project(...) and (own row or admin)
-- (final state after 2026-06-18-project-access-rls + 2026-07-21-viewer-readonly)
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['drawing_register','material_submittal'] loop
    execute format('alter table %I enable row level security', t);

    execute format('drop policy if exists %I on %I', t||'_read', t);
    execute format('create policy %I on %I for select using (can_access_project(project_id))', t||'_read', t);

    execute format('drop policy if exists %I on %I', t||'_ins', t);
    execute format('create policy %I on %I for insert with check (is_writer() and created_by = auth.uid() and can_access_project(project_id))', t||'_ins', t);

    execute format('drop policy if exists %I on %I', t||'_upd', t);
    execute format('create policy %I on %I for update using (is_writer() and can_access_project(project_id) and (created_by = auth.uid() or is_admin())) with check (is_writer() and can_access_project(project_id))', t||'_upd', t);

    execute format('drop policy if exists %I on %I', t||'_del', t);
    execute format('create policy %I on %I for delete using (is_writer() and can_access_project(project_id) and (created_by = auth.uid() or is_admin()))', t||'_del', t);
  end loop;
end $$;

grant select, insert, update, delete on drawing_register   to authenticated;
grant select, insert, update, delete on material_submittal to authenticated;


-- ============================================================================
-- SECTION 9 — STORAGE: buckets + storage.objects policies (FINAL)
-- One PRIVATE bucket per file-bearing module. Private = only reachable via a
-- short-lived signed URL (createSignedUrl).
--   select/insert : is_approved()
--   delete        : owner = auth.uid() OR is_planner()
-- The owner branch is KEPT deliberately: insert is is_approved(), so `user`/
-- `viewer` roles can upload and must stay able to delete their own uploads.
-- (2026-06-18-storage-buckets + 2026-07-20-material-submittal-storage-delete
--  + 2026-07-20-storage-planner-delete-all-buckets)
-- ============================================================================

insert into storage.buckets (id, name, public) values
  ('drawing-register',   'drawing-register',   false),
  ('material-submittal', 'material-submittal', false)
on conflict (id) do nothing;

-- Guard: the delete policy's USING expression is parsed at creation time.
do $$
begin
  if to_regprocedure('public.is_planner()') is null then
    raise exception 'is_planner() is missing — run SECTION 2 first';
  end if;
end $$;

do $$
declare b text;
begin
  foreach b in array array['drawing-register','material-submittal'] loop
    execute format('drop policy if exists %I on storage.objects', b||'_read');
    execute format('create policy %I on storage.objects for select using (bucket_id = %L and is_approved())', b||'_read', b);

    execute format('drop policy if exists %I on storage.objects', b||'_ins');
    execute format('create policy %I on storage.objects for insert with check (bucket_id = %L and is_approved())', b||'_ins', b);

    execute format('drop policy if exists %I on storage.objects', b||'_del');
    execute format('create policy %I on storage.objects for delete using (bucket_id = %L and (owner = auth.uid() or is_planner()))', b||'_del', b);
  end loop;
end $$;

-- NOTE: the Planning App also has a 'progress-photos' bucket. Omitted — that
-- module is not part of the Engineering App.


-- ============================================================================
-- SECTION 10 — REALTIME / LIVE COLLAB (PDCollab)
-- Presence (who's here) + cursor broadcast need NO server change — they ride the
-- Realtime websocket. Only the LIVE-VALUE stream (postgres_changes) needs the
-- table in the `supabase_realtime` publication. RLS still applies to Realtime,
-- so a client only receives events for rows it can already SELECT.
--
-- There is NO presence/collab table in the Planning App — presence is entirely
-- in-memory over the websocket. Nothing to create here.
--
-- REPLICA IDENTITY FULL so UPDATE/DELETE payloads carry every column, including
-- project_id, which the client subscription filters on (project_id=eq.<pid>).
-- The default (PK only) would omit it and filtered events would never arrive.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['drawing_register','material_submittal'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $$;


-- ============================================================================
-- SECTION 11 — updated_at
-- ⚠️ NOT PORTED FROM PLANNING APP: neither drawing_register nor
-- material_submittal has a database trigger there. `updated_at` defaults to
-- now() on insert and is set explicitly by the app on every update. Only
-- project_schedule (a module not included here) has a set_updated_at trigger.
-- If you want DB-enforced updated_at in the Engineering App instead, uncomment:
--
-- create or replace function set_updated_at() returns trigger
--   language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
-- do $$
-- declare t text;
-- begin
--   foreach t in array array['drawing_register','material_submittal'] loop
--     execute format('drop trigger if exists set_updated_at_%s on %I', t, t);
--     execute format('create trigger set_updated_at_%s before update on %I
--                     for each row execute function set_updated_at()', t, t);
--   end loop;
-- end $$;
-- ============================================================================


-- ============================================================================
-- SECTION 12 — SEED + BOOTSTRAP (optional)
-- ============================================================================

insert into workspaces (id, name, code, parent_id, node_type, group_head, sort_order) values
  ('CORP',     'Corporate Root',  'Corp',  null,   'workspace', null, 0),
  ('NONPROD',  'Non Production',  'NonP',  'CORP', 'workspace', null, 1),
  ('PROD',     'Production',      'Prod',  'CORP', 'workspace', null, 2),
  ('EPC',      'Megawide EPC',    'EPC',   'PROD', 'workspace', null, 0),
  ('HOLDCO',   'Megawide HoldCo', 'HoldCo','PROD', 'workspace', null, 1),
  ('BIDS',     'Bids',            'Bids',  'EPC',  'workspace', null, 0),
  ('OPS',      'Operations',      'Ops',   'EPC',  'workspace', null, 1),
  ('PMO',      'PMO',             'PMO',   'EPC',  'program',   null, 2),
  ('CALIMAG',  'Calimag Group',   'CAL',   'OPS',  'group', 'Calimag Group',   0),
  ('RODRIN',   'Rodrin Group',    'ROD',   'OPS',  'group', 'Rodrin Group',    1),
  ('RONQUILLO','Ronquillo Group', 'RON',   'OPS',  'group', 'Ronquillo Group', 2),
  ('TAN',      'Tan Group',       'TAN',   'OPS',  'group', 'Tan Group',       3),
  ('FLORES',   'Flores Group',    'FLO',   'OPS',  'group', 'Flores Group',    4)
on conflict (id) do nothing;

-- After you self-register through the app, promote yourself:
--   update users set role = 'super_admin', status = 'approved'
--   where email = 'fmlozano@megawide.com.ph';

-- Re-assert grants for anything created above (belt & braces).
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;

-- Done.
