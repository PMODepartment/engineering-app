-- ============================================================================
-- Engineering App — 0014: value_engineering (Value Engineering List)
-- ----------------------------------------------------------------------------
-- Idempotent. Rollback at the bottom.
--
-- PROJECT-SCOPED, exactly like drawing_register / material_submittal /
-- method_register: `project_id` is NOT NULL and every RLS policy is the standard
-- 4-policy pattern over can_access_project().
--
-- ⚠️ NO SOURCE WORKBOOK. Unlike method_register (whose SUMMARY formulas were the
-- spec) this schema was DESIGNED, not transcribed — the owner confirmed there is
-- no existing VE tracker to build against. Treat every vocabulary below as a
-- first cut to be corrected against real practice, not as an authority.
--
-- ⚠️ THE THREE COST COLUMNS ARE THE WHOLE POINT, and they are three different
-- questions that a single "saving" column would collapse:
--
--   baseline_cost   what the design as-tendered costs
--   proposed_cost   what the VE alternative costs
--   actual_cost     what it cost once implemented (null until it is)
--
-- Potential saving = baseline − proposed, and is a CLAIM.
-- Realised saving  = baseline − actual,   and is a FACT, available only for
--                    rows that reached 'Implemented'.
-- Both are derived in the module (`savingOf` / `realisedOf`) rather than stored,
-- so a corrected cost can never leave a stale saving behind it. A VE register
-- that reports only the claim always over-states itself; the Summary reports the
-- two side by side and never adds them together.
-- ============================================================================

create table if not exists value_engineering (
  id             uuid primary key default gen_random_uuid(),
  project_id     text not null references projects(id) on delete cascade,
  created_by     uuid references users(id),

  -- identity ------------------------------------------------------------------
  ve_no          text,                 -- register number, e.g. VE-001
  title          text,
  description    text,                 -- the proposal, in the proposer's words
  discipline     text,                 -- Architectural / Structural / Civil / …
  element        text,                 -- the BOQ item or work package it touches
  origin         text,                 -- who raised it (Design / Site / Client / Vendor)
  proposed_by    text,
  date_raised    date,

  -- money ---------------------------------------------------------------------
  -- ⚠️ Savings are DERIVED, never stored. See the header note.
  baseline_cost  numeric(16,2),
  proposed_cost  numeric(16,2),
  actual_cost    numeric(16,2),        -- null until implemented

  -- decision ------------------------------------------------------------------
  -- Proposed | Under Review | Endorsed | Approved | Implemented | Rejected | On Hold
  status         text,
  decision_by    text,
  decision_date  date,
  rejection_reason text,

  -- impact --------------------------------------------------------------------
  schedule_impact_days int,            -- negative = saves time, positive = costs time
  -- None | Low | Medium | High — the honest counterweight to the saving.
  quality_impact text,
  risk_notes     text,

  priority       int check (priority between 1 and 3),
  responsible    text,
  target_date    date,
  reference_link text,
  remarks        text,

  sort_order     int default 0,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- Re-assert every column so a partially-created table converges.
alter table value_engineering add column if not exists ve_no                text;
alter table value_engineering add column if not exists title                text;
alter table value_engineering add column if not exists description          text;
alter table value_engineering add column if not exists discipline           text;
alter table value_engineering add column if not exists element              text;
alter table value_engineering add column if not exists origin               text;
alter table value_engineering add column if not exists proposed_by          text;
alter table value_engineering add column if not exists date_raised          date;
alter table value_engineering add column if not exists baseline_cost        numeric(16,2);
alter table value_engineering add column if not exists proposed_cost        numeric(16,2);
alter table value_engineering add column if not exists actual_cost          numeric(16,2);
alter table value_engineering add column if not exists status               text;
alter table value_engineering add column if not exists decision_by          text;
alter table value_engineering add column if not exists decision_date        date;
alter table value_engineering add column if not exists rejection_reason     text;
alter table value_engineering add column if not exists schedule_impact_days int;
alter table value_engineering add column if not exists quality_impact       text;
alter table value_engineering add column if not exists risk_notes           text;
alter table value_engineering add column if not exists priority             int;
alter table value_engineering add column if not exists responsible          text;
alter table value_engineering add column if not exists target_date          date;
alter table value_engineering add column if not exists reference_link       text;
alter table value_engineering add column if not exists remarks              text;
alter table value_engineering add column if not exists sort_order           int default 0;

create index if not exists value_engineering_project_idx    on value_engineering (project_id);
create index if not exists value_engineering_status_idx     on value_engineering (project_id, status);
create index if not exists value_engineering_discipline_idx on value_engineering (project_id, discipline);

comment on table value_engineering is
  'Value Engineering List — cost-saving proposals raised against a project''s '
  'tendered design, from proposal through decision to realised saving.';
comment on column value_engineering.baseline_cost is
  'Cost of the design as tendered. Potential saving = baseline - proposed; '
  'realised saving = baseline - actual. Neither is stored: both are derived so a '
  'corrected cost cannot leave a stale saving behind it.';
comment on column value_engineering.actual_cost is
  'What it actually cost once implemented. NULL until then — this is what '
  'separates a claimed saving from a realised one.';
comment on column value_engineering.status is
  'Proposed | Under Review | Endorsed | Approved | Implemented | Rejected | On Hold';
comment on column value_engineering.schedule_impact_days is
  'Negative saves programme days, positive costs them. A VE item that saves money '
  'and loses two weeks is not a saving until someone has seen both numbers.';

-- ---- RLS: the standard 4-policy pattern ------------------------------------
alter table value_engineering enable row level security;

drop policy if exists value_engineering_read on value_engineering;
create policy value_engineering_read on value_engineering for select
  using (can_access_project(project_id));

drop policy if exists value_engineering_ins on value_engineering;
create policy value_engineering_ins on value_engineering for insert with check (
  is_writer() and created_by = auth.uid() and can_access_project(project_id));

drop policy if exists value_engineering_upd on value_engineering;
create policy value_engineering_upd on value_engineering for update
  using (is_writer() and can_access_project(project_id)
         and (created_by = auth.uid() or is_planner()))
  with check (is_writer() and can_access_project(project_id));

drop policy if exists value_engineering_del on value_engineering;
create policy value_engineering_del on value_engineering for delete
  using (is_writer() and can_access_project(project_id)
         and (created_by = auth.uid() or is_planner()));

grant select, insert, update, delete on value_engineering to authenticated;

-- ---- audit trail -----------------------------------------------------------
drop trigger if exists audit_value_engineering on value_engineering;
create trigger audit_value_engineering after insert or update or delete
  on value_engineering
  for each row execute function engineering_audit_trg();

-- ---- approval authority ----------------------------------------------------
-- ⚠️ A VE decision is a MONEY decision, so moving a row into Approved / Rejected
-- / Endorsed / Implemented must be restricted to is_planner() server-side, not
-- merely hidden in the UI.
--
-- ⚠️ THIS REPLACES A SHARED FUNCTION. engineering_decision_statuses() is defined
-- in 0002 and consulted by drawing_register's and material_submittal's guards
-- too, so the 0002 list is reproduced BELOW VERBATIM and only two names are
-- added. Dropping one of those six would silently un-gate approval on a sibling
-- module. 'Approved' and 'Rejected' are already in the 0002 list, so this
-- module's Approved/Rejected are gated by inheritance; only 'Endorsed' and
-- 'Implemented' are new.
create or replace function engineering_decision_statuses() returns text[]
  language sql immutable as $$ select array[
    -- drawing_register (0002 — verbatim)
    'Approved', 'Approved w/ comments', 'Approved w/o comments',
    -- material_submittal (0002 — verbatim)
    'Approved w/ Comments', 'Rejected',
    -- shared (0002 — verbatim)
    'Resubmit',
    -- value_engineering (0014 — added here)
    'Endorsed', 'Implemented'
  ]::text[] $$;

drop trigger if exists guard_decision_value_engineering on value_engineering;
create trigger guard_decision_value_engineering before update of status
  on value_engineering
  for each row execute function engineering_guard_decision();

-- ============================================================================
-- ROLLBACK
-- ----------------------------------------------------------------------------
-- drop trigger if exists guard_decision_value_engineering on value_engineering;
-- drop trigger if exists audit_value_engineering on value_engineering;
-- drop table if exists value_engineering;
-- (engineering_decision_statuses() is shared — restore 0002's version by hand.)
-- ============================================================================
