-- 0021 — CONTRACT PACKAGES from the Planners app -----------------------------------
-- A project is bought as several contract packages — "Package 1 — Tower 1 and General
-- Requirements", "Package 2 — Towers 2-7". They come off the contract documents, the
-- Planners app owns them, and engineering consumes them: a drawing, a submittal or an
-- RFA belongs to one package's scope, and "what is outstanding for Package 2" is a
-- question this app cannot answer today.
--
-- ⚠️ IT IS A MIRROR, NOT A LIVE READ. This app and the Planners app are SEPARATE
-- Supabase projects (zkxzaijznutmiueeurbb vs bgupuqnkqhixpuctyder) and share no
-- tables. The Planners `push-packages` Edge Function writes this table with this
-- project's service-role key — the same shape the Planners app's own sync-eng mirror
-- uses in the opposite direction.
--
-- ⚠️ WRITES ARE SERVICE-ROLE ONLY. No policy grants insert/update/delete to
-- authenticated or anon: a contract package is a contractual fact, and one fabricated
-- in a browser could end up cited in a submittal log nobody agreed to.
--
-- ⚠️ THE LINK COLUMNS ARE OWNED BY THIS APP. drawing_register.planners_package_id is
-- set by engineers here; the push only refreshes the list to choose from. One app
-- silently re-filing another team's records is unrecoverable.
--
-- Run in the Engineering Supabase SQL editor. Idempotent (re-runnable).
-- ---------------------------------------------------------------------------------

create table if not exists planners_packages (
  planners_package_id uuid primary key,   -- the Planners uuid: a rename must not orphan links
  planners_project_id text not null,
  project_id          text,
  code                text not null,
  name                text not null,
  description         text,
  status              text default 'active',
  sort_order          int  default 0,
  start_date          date,
  end_date            date,
  contract_amount     numeric,
  synced_at           timestamptz default now()
);
create index if not exists planners_packages_project_idx on planners_packages (project_id, sort_order);
create index if not exists planners_packages_src_idx     on planners_packages (planners_project_id);

alter table planners_packages enable row level security;
drop policy if exists planners_packages_read on planners_packages;
create policy planners_packages_read on planners_packages
  for select to authenticated using (true);
grant select on planners_packages to authenticated;

-- ---------------------------------------------------------------------------------
-- The link on the registers this app owns
-- ---------------------------------------------------------------------------------
-- ⚠️ NO FOREIGN KEY: the mirror is refreshed delete-then-insert per project, so a FK
-- would either block the refresh or cascade real engineering records away. A package
-- that disappears upstream leaves the id in place, read as "no longer in Planners".
-- ⚠️ NULL = not yet assigned, and stays a normal state. No back-fill: guessing a lot
-- for existing drawings would misreport every package total the day this ran.
alter table drawing_register add column if not exists planners_package_id uuid;
create index if not exists drawing_register_planners_package_idx
  on drawing_register (planners_package_id);

comment on column drawing_register.planners_package_id is
  'Contract package (Planners app) this drawing belongs to. Set here; the package list is mirrored in by the Planners push-packages function. NULL = not yet assigned.';

-- ---------------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------------
--   select code, name, project_id from planners_packages order by sort_order;
--        -- empty until the Planners app pushes
--   select column_name from information_schema.columns
--    where table_name = 'drawing_register' and column_name = 'planners_package_id';  -- expect 1
