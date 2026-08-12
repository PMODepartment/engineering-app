-- ============================================================================
-- Engineering App — 0012: per-project top-sheet header defaults
-- ----------------------------------------------------------------------------
-- Idempotent. Rollback at the bottom.
--
-- WHY THIS TABLE EXISTS
-- The three PMO top sheets (F-GEN013 MAS, F-GEN011 RFA, F-GEN010 RFI) all print
-- a header block naming the PROJECT and the CLIENT, and RFA/RFI additionally
-- name a default TO / FROM party. `projects` carries the name but has no client
-- column — and it MUST NOT gain one: 0009/0010 made projects read-only here
-- because they are synced from the Planners Dashboard by an id-keyed upsert,
-- which would silently overwrite any column we added locally.
--
-- So the defaults live in the Engineering App's own table, keyed by project id.
-- One row per project; the generator reads it to prefill the form and the user
-- can still override any field on the sheet before printing.
--
-- ⚠️ project_id is text (projects.id is a short code like 'AVR101'), and it is
-- the PRIMARY KEY — a project has exactly one set of defaults.
-- ============================================================================

create table if not exists topsheet_defaults (
  project_id        text primary key references projects(id) on delete cascade,
  client_name       text,          -- "CLIENT:" on all three forms
  consultant_name   text,          -- "For and on behalf of [Engineer]" (RFI)
  default_to        text,          -- "TO:" — RFA / RFI
  default_from      text,          -- "FROM:" — RFA / RFI
  updated_by        uuid references users(id),
  updated_at        timestamptz default now(),
  created_at        timestamptz default now()
);

-- ---- RLS -------------------------------------------------------------------
-- Read follows project access, same as every module table. Writes are limited to
-- planners and above: this is project-level configuration that everyone's printed
-- forms inherit, not a per-user preference, so a `user`-role author should not be
-- able to change the client name on everybody's paperwork.
alter table topsheet_defaults enable row level security;

drop policy if exists topsheet_defaults_read on topsheet_defaults;
create policy topsheet_defaults_read on topsheet_defaults for select
  using (can_access_project(project_id));

drop policy if exists topsheet_defaults_ins on topsheet_defaults;
create policy topsheet_defaults_ins on topsheet_defaults for insert
  with check (is_planner() and can_access_project(project_id));

drop policy if exists topsheet_defaults_upd on topsheet_defaults;
create policy topsheet_defaults_upd on topsheet_defaults for update
  using (is_planner() and can_access_project(project_id))
  with check (is_planner() and can_access_project(project_id));

drop policy if exists topsheet_defaults_del on topsheet_defaults;
create policy topsheet_defaults_del on topsheet_defaults for delete
  using (is_planner() and can_access_project(project_id));

grant select, insert, update, delete on topsheet_defaults to authenticated;

-- ---- audit trail -----------------------------------------------------------
drop trigger if exists audit_topsheet_defaults on topsheet_defaults;
create trigger audit_topsheet_defaults after insert or update or delete
  on topsheet_defaults
  for each row execute function engineering_audit_trg();

-- ============================================================================
-- ROLLBACK
-- ----------------------------------------------------------------------------
-- drop trigger if exists audit_topsheet_defaults on topsheet_defaults;
-- drop table if exists topsheet_defaults;
-- ============================================================================
