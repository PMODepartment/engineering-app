-- ============================================================================
-- Engineering App — 0003: legacy ownership + editable-by-planner policy
-- ----------------------------------------------------------------------------
-- Run AFTER 0002. Idempotent. Required BEFORE migrate-data.mjs.
--
-- THE PROBLEM THIS SOLVES
-- Records are being migrated from the Planners Dashboard, which runs on a
-- DIFFERENT Supabase project. Two hard consequences:
--
--   1. `users.id` references `auth.users(id)`, and password hashes are not
--      portable between projects. So the original authors' profile rows CANNOT
--      be inserted here — there is no auth account to hang them off. And
--      `drawing_register.created_by` references `users(id)`, so migrated rows
--      cannot carry their original creator id either.
--
--   2. The module RLS policy is
--         update using (... and (created_by = auth.uid() or is_admin()))
--      Every migrated row would therefore be editable by ADMINS ONLY — the
--      planners who actually maintain these registers day to day would be
--      locked out of every historical record on day one.
--
-- THE ANSWER, in two parts:
--
--   Section 1 — `legacy_users` keeps the original authors' names and emails in
--   a table with NO auth foreign key, purely for attribution, and both module
--   tables gain `legacy_created_by`. Migrated rows land with `created_by = null`
--   and `legacy_created_by` set, so "Imported from Planners Dashboard —
--   originally created by Juan Dela Cruz" is still answerable. When Juan later
--   registers here, `migrate-data.mjs --relink-users` matches him by email and
--   fills in the real `created_by`.
--
--   Section 2 — the update/delete policy is widened from
--   "creator or admin" to "creator or PLANNER (which includes admin)".
--   ⚠️ This is a deliberate authorisation change, not a migration hack. It is
--   also the correct rule for a controlled-document register: a drawing register
--   is owned by the engineering team, not by whichever individual first typed
--   the row. A `user` still edits only their own rows; `viewer` still writes
--   nothing. Without it, migrated history is frozen.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — LEGACY ATTRIBUTION
-- ============================================================================

-- Deliberately NO foreign key to auth.users or public.users: these people have
-- no account in this project yet, and may never get one.
create table if not exists legacy_users (
  id           uuid primary key,          -- the ORIGINAL Planning App auth uuid
  name         text,
  email        text,
  role         text,                      -- role they held in the Planning App
  status       text,
  projects     text[],
  source_app   text default 'planners-dashboard',
  imported_at  timestamptz default now(),
  relinked_to  uuid references users(id) on delete set null  -- set by --relink-users
);

create index if not exists legacy_users_email_idx on legacy_users (lower(email));

comment on table legacy_users is
  'Original authors of records migrated from the Planners Dashboard. Attribution '
  'only — these ids are NOT auth accounts in this project. When a person '
  'registers here, migrate-data.mjs --relink-users sets relinked_to and rewrites '
  'the module rows'' created_by.';

alter table drawing_register   add column if not exists legacy_created_by uuid;
alter table material_submittal add column if not exists legacy_created_by uuid;

create index if not exists drawing_register_legacy_idx   on drawing_register (legacy_created_by);
create index if not exists material_submittal_legacy_idx on material_submittal (legacy_created_by);

comment on column drawing_register.legacy_created_by is
  'Original Planners Dashboard author (see legacy_users). Set only on migrated '
  'rows, where created_by is null because that user has no account here yet.';

-- Readable everywhere (it is just names on historical records); writable only by
-- admins and the service_role migration script.
alter table legacy_users enable row level security;

drop policy if exists legacy_users_read on legacy_users;
create policy legacy_users_read on legacy_users for select using (is_approved());

drop policy if exists legacy_users_admin_write on legacy_users;
create policy legacy_users_admin_write on legacy_users for all
  using (is_admin()) with check (is_admin());

grant select on legacy_users to authenticated;

-- One place for the UI to ask "who owns this row?", whoever that turns out to be.
create or replace function engineering_author(p_created_by uuid, p_legacy uuid)
  returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select u.name  from users        u where u.id = p_created_by),
    (select u.email from users        u where u.id = p_created_by),
    (select l.name || ' (Planners Dashboard)' from legacy_users l where l.id = p_legacy),
    (select l.email                           from legacy_users l where l.id = p_legacy),
    'Unknown'
  );
$$;


-- ============================================================================
-- SECTION 2 — WIDEN UPDATE/DELETE TO PLANNERS
-- read  : can_access_project(project_id)                       [unchanged]
-- ins   : is_writer() and created_by = auth.uid() and access   [unchanged]
-- upd   : is_writer() and access and (own row or IS_PLANNER)   [widened]
-- del   : is_writer() and access and (own row or IS_PLANNER)   [widened]
--
-- is_planner() = approved and role in (super_admin, admin, planner), so this
-- strictly ADDS the planner role to what admins could already do. Nobody loses
-- access. `viewer` is still excluded by is_writer(); a plain `user` is still
-- limited to rows they created.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['drawing_register','material_submittal'] loop
    execute format('drop policy if exists %I on %I', t||'_upd', t);
    execute format('create policy %I on %I for update
                      using (is_writer() and can_access_project(project_id)
                             and (created_by = auth.uid() or is_planner()))
                      with check (is_writer() and can_access_project(project_id))',
                   t||'_upd', t);

    execute format('drop policy if exists %I on %I', t||'_del', t);
    execute format('create policy %I on %I for delete
                      using (is_writer() and can_access_project(project_id)
                             and (created_by = auth.uid() or is_planner()))',
                   t||'_del', t);
  end loop;
end $$;


-- ============================================================================
-- SECTION 3 — ALLOW created_by TO BE NULL ON MIGRATED ROWS
-- ----------------------------------------------------------------------------
-- `created_by` is already nullable in 0001, so there is nothing to alter. What
-- needs stating is the INTERACTION: the insert policy demands
-- `created_by = auth.uid()`, so a NULL created_by can only ever be written by
-- the service_role migration script (which bypasses RLS) — a normal client
-- cannot forge an unowned row. That is exactly the property we want, so the
-- insert policy is left alone.
--
-- Verify after migrating (expect a count for migrated rows, 0 afterwards):
--   select count(*) from drawing_register where created_by is null;
--   select count(*) from drawing_register where legacy_created_by is not null;
-- ============================================================================

-- Convenience: what still needs relinking, by person.
create or replace view legacy_ownership_pending as
select
  l.id            as legacy_id,
  l.name,
  l.email,
  l.role          as planning_app_role,
  l.relinked_to,
  (select count(*) from drawing_register   d where d.legacy_created_by = l.id
     and d.created_by is null)                                as drawings_pending,
  (select count(*) from material_submittal m where m.legacy_created_by = l.id
     and m.created_by is null)                                as submittals_pending
from legacy_users l
order by l.name;

alter view legacy_ownership_pending set (security_invoker = true);
grant select on legacy_ownership_pending to authenticated;

-- Done.
