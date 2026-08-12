-- ============================================================================
-- Engineering App — 0013: method_register (Method Statement Registry)
-- ----------------------------------------------------------------------------
-- Idempotent. Rollback at the bottom.
--
-- Built against "MCC. ENG. MET. MRE. SLN101 Method Registry Tracker. 2026 07 15"
-- (Strevi Residences, Salinas Bacoor). That workbook's own formulas are the
-- spec — see modules/method-register/CLAUDE.md for the transcription.
--
-- SHAPE: a 4-level tree, exactly like drawing_register's.
--   trade (TW/CE/ST/…) › group › sub-group › METHOD STATEMENT
-- The three upper levels are STRUCTURAL ROWS (`node_kind`), not lookup tables,
-- so the register can be edited as a tree and a level can carry its own code and
-- ordering — the same decision drawing_register made, and the reason every
-- feature there (inline edit, drag order, filters, bulk actions) works here too.
--
-- ⚠️ `counts` IS THE LOAD-BEARING FIELD. In the workbook every SUMMARY metric is
-- gated on `N=1`, and 323 of its item rows carry N blank/0 — placeholders for
-- method statements that have been named but are not yet part of the target. Of
-- 323 rows only 103 count. A register that ignored this would over-report the
-- programme by 3x, so `counts` defaults TRUE but is honoured everywhere.
-- ============================================================================

create table if not exists method_register (
  id             uuid primary key default gen_random_uuid(),
  project_id     text not null references projects(id) on delete cascade,
  created_by     uuid references users(id),

  -- tree ---------------------------------------------------------------------
  -- null = a method statement (leaf). Otherwise the structural level this row is.
  node_kind      text check (node_kind in ('trade','group','subgroup')),
  trade_code     text,                 -- TW / CE / ST / AR / CV / RC / ME / EE / PL / FP / LA / SP
  trade_name     text,                 -- TEMPORARY WORKS, STRUCTURAL, …
  group_name     text,
  subgroup_name  text,
  seq_no         text,                 -- workbook col B: 10000 trade / 11000 group / 12100 sub / 12101 item
  ms_code        text,                 -- workbook col A: trade_code || seq_no, e.g. TW11001
  title          text,

  -- ⚠️ the N=1 flag. See the header note.
  counts         boolean not null default true,

  -- submission / approval ----------------------------------------------------
  latest_revision       int,           -- workbook col O, derived from the rev 1-4 planned dates
  plan_submission_date  date,
  actual_submission_date date,
  -- rev 1..4 planned/actual pairs, append-only: [{rev,planned,actual}]
  submissions           jsonb default '[]'::jsonb,
  plan_approval_date    date,
  actual_approval_date  date,

  -- Open | Approved | Approved w/ Comments | Disapproved
  status         text,
  -- Engg | Ops | Closed | Open  (⚠️ see the CLAUDE.md note — the workbook's
  -- SUMMARY only ever counts 'engg'/'ops', so its own 'Open' rows vanish)
  ball_in        text,
  approved_sheets int,

  -- prerequisite attachments. The workbook writes the literal 'balance' when one
  -- is still outstanding; stored here as "is it done yet", so % BAL is a plain
  -- count of `false`.
  hirac_done     boolean not null default false,
  qcc_done       boolean not null default false,
  mas_done       boolean not null default false,
  isd_done       boolean not null default false,

  reference_link text,
  priority       int check (priority between 1 and 3),
  responsible    text,
  target_date    date,
  remarks        text,

  sort_order     int default 0,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- Re-assert every column so a partially-created table converges.
alter table method_register add column if not exists node_kind             text;
alter table method_register add column if not exists trade_code            text;
alter table method_register add column if not exists trade_name            text;
alter table method_register add column if not exists group_name            text;
alter table method_register add column if not exists subgroup_name         text;
alter table method_register add column if not exists seq_no                text;
alter table method_register add column if not exists ms_code               text;
alter table method_register add column if not exists title                 text;
alter table method_register add column if not exists counts                boolean not null default true;
alter table method_register add column if not exists latest_revision       int;
alter table method_register add column if not exists plan_submission_date  date;
alter table method_register add column if not exists actual_submission_date date;
alter table method_register add column if not exists submissions           jsonb default '[]'::jsonb;
alter table method_register add column if not exists plan_approval_date    date;
alter table method_register add column if not exists actual_approval_date  date;
alter table method_register add column if not exists status                text;
alter table method_register add column if not exists ball_in               text;
alter table method_register add column if not exists approved_sheets       int;
alter table method_register add column if not exists hirac_done            boolean not null default false;
alter table method_register add column if not exists qcc_done              boolean not null default false;
alter table method_register add column if not exists mas_done              boolean not null default false;
alter table method_register add column if not exists isd_done              boolean not null default false;
alter table method_register add column if not exists reference_link        text;
alter table method_register add column if not exists priority              int;
alter table method_register add column if not exists responsible           text;
alter table method_register add column if not exists target_date           date;
alter table method_register add column if not exists remarks               text;
alter table method_register add column if not exists sort_order            int default 0;

create index if not exists method_register_project_idx on method_register (project_id);
create index if not exists method_register_trade_idx   on method_register (project_id, trade_code);
create index if not exists method_register_status_idx  on method_register (project_id, status);
create index if not exists method_register_counts_idx  on method_register (project_id, counts);

comment on column method_register.counts is
  'The workbook''s N=1 flag. Every SUMMARY metric counts only rows where this is '
  'true; a false row is a named-but-not-yet-targeted method statement.';
comment on column method_register.status is
  'Open | Approved | Approved w/ Comments | Disapproved';
comment on column method_register.ball_in is
  'Engg | Ops | Closed | Open — who is currently holding the method statement.';

-- ---- RLS: the standard 4-policy pattern ------------------------------------
alter table method_register enable row level security;

drop policy if exists method_register_read on method_register;
create policy method_register_read on method_register for select
  using (can_access_project(project_id));

drop policy if exists method_register_ins on method_register;
create policy method_register_ins on method_register for insert with check (
  is_writer() and created_by = auth.uid() and can_access_project(project_id));

drop policy if exists method_register_upd on method_register;
create policy method_register_upd on method_register for update
  using (is_writer() and can_access_project(project_id)
         and (created_by = auth.uid() or is_planner()))
  with check (is_writer() and can_access_project(project_id));

drop policy if exists method_register_del on method_register;
create policy method_register_del on method_register for delete
  using (is_writer() and can_access_project(project_id)
         and (created_by = auth.uid() or is_planner()));

grant select, insert, update, delete on method_register to authenticated;

-- ---- audit trail -----------------------------------------------------------
drop trigger if exists audit_method_register on method_register;
create trigger audit_method_register after insert or update or delete
  on method_register
  for each row execute function engineering_audit_trg();

-- ============================================================================
-- ROLLBACK
-- ----------------------------------------------------------------------------
-- drop trigger if exists audit_method_register on method_register;
-- drop table if exists method_register;
-- ============================================================================
