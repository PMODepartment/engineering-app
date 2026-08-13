-- ============================================================================
-- Engineering App — 0016: fix admin_delete_user() targeting a VIEW
-- ----------------------------------------------------------------------------
-- Idempotent. Rollback at the bottom.
--
-- ⚠️ REAL BUG, live: "cannot update view drawing_revisions" on every delete of a
-- user who has ever authored a drawing.
--
-- admin_delete_user() (0001) drops the authorship link on every table before
-- deleting the auth.users row, discovering the table list with:
--
--     select table_name from information_schema.columns
--     where table_schema = 'public' and column_name = 'created_by'
--
-- `information_schema.columns` lists VIEW columns too, not just table columns —
-- and 0002 later added `drawing_revisions`, whose SELECT list includes
-- `d.created_by` (to keep the revision history readable). So the loop picked up
-- the view alongside the real tables and executed
-- `update public.drawing_revisions set created_by = null where created_by = …`,
-- which Postgres refuses because a view is not directly updatable — the exact
-- error the admin panel surfaced. `admin_delete_project()` never had this bug:
-- it discovers its table list from `pg_class` filtered to `relkind = 'r'`
-- (ordinary tables only), which is the pattern this migration brings
-- `admin_delete_user()` in line with.
-- ============================================================================

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
  -- ⚠️ BASE TABLES ONLY (pg_class.relkind = 'r') — see the header note. A view
  -- exposing created_by (drawing_revisions, and any future one) must never be
  -- targeted by this UPDATE.
  for r in
    select c.relname as table_name
      from pg_attribute a
      join pg_class c      on c.oid = a.attrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind = 'r'
       and a.attname = 'created_by' and a.attnum > 0 and not a.attisdropped
     order by c.relname
  loop
    execute format('update public.%I set created_by = null where created_by = %L', r.table_name, target);
  end loop;

  delete from auth.users where id = target;
end $$;

-- ============================================================================
-- ROLLBACK
-- ----------------------------------------------------------------------------
-- Restore the 0001 definition verbatim (reintroduces the bug):
--
-- create or replace function admin_delete_user(target uuid)
-- returns void language plpgsql security definer set search_path = public as $$
-- declare r record;
-- begin
--   if not is_admin() then raise exception 'Not authorized'; end if;
--   if target = auth.uid() then raise exception 'You cannot delete your own account'; end if;
--   if exists (select 1 from users where id = target and role = 'super_admin')
--      and not exists (select 1 from users where id = auth.uid() and role = 'super_admin') then
--     raise exception 'Only a super admin can delete a super admin';
--   end if;
--   for r in
--     select table_name from information_schema.columns
--     where table_schema = 'public' and column_name = 'created_by'
--   loop
--     execute format('update public.%I set created_by = null where created_by = %L', r.table_name, target);
--   end loop;
--   delete from auth.users where id = target;
-- end $$;
-- ============================================================================
