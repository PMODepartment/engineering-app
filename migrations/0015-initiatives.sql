-- ============================================================================
-- Engineering App — 0015: initiatives (Engineering Initiatives)
-- ----------------------------------------------------------------------------
-- Idempotent. Rollback at the bottom.
--
-- ⚠️ THIS IS THE FIRST ORG-WIDE TABLE IN THE APP. Every other module table has
-- `project_id text NOT NULL` and RLS of the form `can_access_project(project_id)`.
-- Here `project_id` is NULLABLE: an initiative is a department-level programme
-- (a standard, a tool, a training push) that MAY be attached to a project but
-- usually is not. The owner asked for exactly this shape.
--
-- Three consequences, all of them deliberate:
--
--   1. ⚠️ READ IS NOT `can_access_project(project_id)`. That function returns
--      FALSE for a NULL pid, so the obvious policy would hide every unattached
--      initiative from everyone including admins — i.e. the whole table. The
--      policy is therefore "approved user AND (no project OR you can see that
--      project)": org-wide rows are visible to every approved user, and an
--      initiative pinned to a project you cannot access stays hidden, so
--      attaching a project can only ever NARROW visibility, never widen it.
--
--   2. ⚠️ The same `project_id is null or ...` guard is repeated in the INSERT
--      and UPDATE WITH CHECK clauses. Without it a user could park an
--      initiative on a project they have no access to.
--
--   3. The audit trigger needs no change: engineering_audit_trg() copies
--      `new.project_id` into a NULLABLE column, and engineering_audit's own read
--      policy already reads `project_id is null or can_access_project(...)`.
--
-- ⚠️ NO SOURCE WORKBOOK — this schema was designed, not transcribed. The owner
-- confirmed there is no existing initiatives tracker. Vocabularies below are a
-- first cut to be corrected against real practice.
--
-- ⚠️ `progress_pct` IS ENTERED, NOT DERIVED. There is no task breakdown under an
-- initiative to roll up from, so the number is a human's judgement. It is
-- constrained 0-100 and shown as a bar, but never presented as measured: the
-- Overview's headline is the STATUS mix, and progress is only ever reported for
-- the In Progress subset, where it means something.
-- ============================================================================

create table if not exists initiatives (
  id             uuid primary key default gen_random_uuid(),
  -- ⚠️ NULLABLE, and no `not null` — see the header note. Still FK-checked, so a
  -- bogus id cannot be stored, and cascades if the project is ever deleted.
  project_id     text references projects(id) on delete cascade,
  created_by     uuid references users(id),

  -- identity ------------------------------------------------------------------
  init_no        text,                 -- register number, e.g. INI-2026-004
  title          text,
  description    text,
  -- Process Improvement | Digitalisation | Cost Optimisation | Quality |
  -- Safety | Sustainability | Capability & Training | Standardisation
  category       text,
  department     text,                 -- the owning department/section
  owner_name     text,                 -- the person accountable for delivery
  sponsor        text,                 -- the manager backing it

  -- lifecycle -----------------------------------------------------------------
  -- Idea | Planned | In Progress | On Hold | Completed | Cancelled
  status         text,
  priority       int check (priority between 1 and 3),
  progress_pct   int check (progress_pct between 0 and 100),
  start_date     date,
  target_date    date,
  completed_date date,

  -- benefit -------------------------------------------------------------------
  -- Cost | Time | Quality | Safety | Compliance | Capability
  benefit_type   text,
  benefit_note   text,                 -- what "better" looks like, in words
  -- ⚠️ Only meaningful when benefit_type = 'Cost'. A peso figure against a
  -- SAFETY initiative is a category error, so the module refuses to total it
  -- across benefit types and the form only offers it for Cost.
  benefit_value  numeric(16,2),
  -- the one number that says whether it worked
  kpi_metric     text,
  kpi_baseline   numeric(16,2),
  kpi_target     numeric(16,2),
  kpi_current    numeric(16,2),

  reference_link text,
  remarks        text,

  sort_order     int default 0,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- Re-assert every column so a partially-created table converges.
alter table initiatives add column if not exists init_no        text;
alter table initiatives add column if not exists title          text;
alter table initiatives add column if not exists description    text;
alter table initiatives add column if not exists category       text;
alter table initiatives add column if not exists department     text;
alter table initiatives add column if not exists owner_name     text;
alter table initiatives add column if not exists sponsor        text;
alter table initiatives add column if not exists status         text;
alter table initiatives add column if not exists priority       int;
alter table initiatives add column if not exists progress_pct   int;
alter table initiatives add column if not exists start_date     date;
alter table initiatives add column if not exists target_date    date;
alter table initiatives add column if not exists completed_date date;
alter table initiatives add column if not exists benefit_type   text;
alter table initiatives add column if not exists benefit_note   text;
alter table initiatives add column if not exists benefit_value  numeric(16,2);
alter table initiatives add column if not exists kpi_metric     text;
alter table initiatives add column if not exists kpi_baseline   numeric(16,2);
alter table initiatives add column if not exists kpi_target     numeric(16,2);
alter table initiatives add column if not exists kpi_current    numeric(16,2);
alter table initiatives add column if not exists reference_link text;
alter table initiatives add column if not exists remarks        text;
alter table initiatives add column if not exists sort_order     int default 0;

create index if not exists initiatives_project_idx  on initiatives (project_id);
create index if not exists initiatives_status_idx   on initiatives (status);
create index if not exists initiatives_category_idx on initiatives (category);

comment on table initiatives is
  'Engineering Initiatives — ORG-WIDE. project_id is nullable: an initiative is '
  'a department-level programme that may optionally be attached to a project. '
  'This is the only engineering table not scoped to a single project.';
comment on column initiatives.project_id is
  'OPTIONAL project link. NULL = org-wide, visible to every approved user. Set = '
  'visible only to users who can access that project, so attaching a project can '
  'only narrow visibility, never widen it.';
comment on column initiatives.progress_pct is
  'Human-entered judgement, not a roll-up — there is no task breakdown beneath an '
  'initiative. Reported only for In Progress rows.';
comment on column initiatives.benefit_value is
  'Peso value of the benefit. Meaningful only when benefit_type = ''Cost''; the '
  'module never totals it across benefit types.';

-- ---- RLS -------------------------------------------------------------------
-- ⚠️ NOT the standard 4-policy pattern — see consequences 1 and 2 in the header.
-- Every clause carries `project_id is null or can_access_project(project_id)`
-- rather than `can_access_project(project_id)` alone, which is FALSE for NULL
-- and would hide the entire org-wide table from everybody.
alter table initiatives enable row level security;

drop policy if exists initiatives_read on initiatives;
create policy initiatives_read on initiatives for select using (
  is_approved() and (project_id is null or can_access_project(project_id)));

drop policy if exists initiatives_ins on initiatives;
create policy initiatives_ins on initiatives for insert with check (
  is_writer() and created_by = auth.uid()
  and (project_id is null or can_access_project(project_id)));

drop policy if exists initiatives_upd on initiatives;
create policy initiatives_upd on initiatives for update
  using (is_writer()
         and (project_id is null or can_access_project(project_id))
         and (created_by = auth.uid() or is_planner()))
  with check (is_writer()
         and (project_id is null or can_access_project(project_id)));

drop policy if exists initiatives_del on initiatives;
create policy initiatives_del on initiatives for delete
  using (is_writer()
         and (project_id is null or can_access_project(project_id))
         and (created_by = auth.uid() or is_planner()));

grant select, insert, update, delete on initiatives to authenticated;

-- ---- audit trail -----------------------------------------------------------
-- Works unchanged on a null project_id: engineering_audit.project_id is nullable
-- and its read policy already handles `project_id is null`.
drop trigger if exists audit_initiatives on initiatives;
create trigger audit_initiatives after insert or update or delete
  on initiatives
  for each row execute function engineering_audit_trg();

-- ⚠️ NO approval guard, deliberately. An initiative has no review authority —
-- 'Completed' is a statement of fact by the owner, not a decision granted by a
-- planner. Attaching engineering_guard_decision() here would be wrong AND
-- ineffective: none of this module's statuses appear in
-- engineering_decision_statuses().

-- ============================================================================
-- ROLLBACK
-- ----------------------------------------------------------------------------
-- drop trigger if exists audit_initiatives on initiatives;
-- drop table if exists initiatives;
-- ============================================================================
