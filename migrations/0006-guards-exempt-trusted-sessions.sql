-- ============================================================================
-- Engineering App — 0006: guards must exempt trusted server-side sessions
-- ----------------------------------------------------------------------------
-- Run immediately after 0005. Idempotent.
--
-- WHAT 0005 GOT WRONG
-- The three guard triggers all gate on `is_admin()`, which resolves the caller
-- from `auth.uid()` — the JWT of a browser request. In a session with NO JWT,
-- `auth.uid()` is NULL, so `is_admin()` is FALSE. That describes every trusted
-- server-side session:
--
--   • the Supabase SQL editor            (runs as postgres, no JWT)
--   • `service_role` API calls           (migrate-data.mjs)
--   • psql / CLI / scheduled jobs
--
-- So 0005 locked the database's own administrators out of administration:
--
--   1. The documented bootstrap step stops working. You can no longer run
--        update users set role='super_admin' where email='…';
--      in the SQL editor — the trigger raises "You may not change your own role."
--      That is the ONLY way to create the first admin, so a fresh deployment
--      becomes unrecoverable.
--   2. `migrate-data.mjs` (service_role) could not set an approved status on any
--      row it updates, because engineering_guard_decision would refuse it.
--   3. Recovering a locked-out account by hand becomes impossible.
--
-- THE FIX
-- Treat "no JWT" as a trusted server-side session and exempt it.
--
-- ⚠️ WHY THAT IS NOT A NEW HOLE. The `anon` role also has no JWT, but anon never
-- reaches these triggers: RLS is evaluated first, and
--   • users_admin_update requires (auth.uid() = id or is_admin()) — both false
--   • users_self_insert  requires (auth.uid() = id)                — false
--   • the module tables require can_access_project()               — false
-- so an anonymous request is rejected by policy before any trigger runs. The
-- triggers only ever see authenticated users (who have a JWT, hence a real
-- is_admin() answer) and trusted server-side sessions (which have no JWT and
-- legitimately bypass RLS anyway — a service_role key can already do anything).
--
-- In other words: these triggers exist to stop a signed-in USER escalating their
-- own privileges. They were never the control that protects against an untrusted
-- caller — RLS is. Exempting no-JWT sessions restores that separation.
-- ============================================================================


-- ---- 1. self-escalation guard ---------------------------------------------
create or replace function users_guard_self_escalation() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  -- Trusted server-side session (SQL editor / service_role / CLI), or an admin
  -- acting through the app. Both are legitimately allowed to change privileges.
  if auth.uid() is null or is_admin() then
    return new;
  end if;

  if new.role is distinct from old.role then
    raise exception 'You may not change your own role.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    raise exception 'You may not change your own account status.' using errcode = '42501';
  end if;
  if new.projects is distinct from old.projects then
    raise exception 'You may not change your own project assignments.' using errcode = '42501';
  end if;
  if new.id is distinct from old.id then
    raise exception 'You may not change a profile id.' using errcode = '42501';
  end if;

  return new;
end $$;


-- ---- 2. self-registration guard -------------------------------------------
create or replace function users_guard_self_insert() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or is_admin() then
    return new;
  end if;
  if new.role is distinct from 'user' or new.status is distinct from 'pending'
     or coalesce(array_length(new.projects, 1), 0) <> 0 then
    raise exception
      'A new account must be created as role=user, status=pending with no '
      'project assignments; an administrator grants access afterwards.'
      using errcode = '42501';
  end if;
  return new;
end $$;


-- ---- 3. approval-authority guard (0002) -----------------------------------
-- Same exemption, for the same reason: migrate-data.mjs runs as service_role and
-- must be able to write historical rows that are already approved.
create or replace function engineering_guard_decision() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or is_planner() then
    return new;
  end if;
  if new.status is distinct from old.status
     and new.status = any (engineering_decision_statuses()) then
    raise exception
      'Your role may not set status "%" — review and approval require the '
      'planner, admin or super_admin role.', new.status
      using errcode = '42501';
  end if;
  return new;
end $$;


-- ============================================================================
-- RESTORE THE LOCKED-OUT ACCOUNT
-- Demoting to 'planner' while testing 0005 left this account unable to promote
-- itself back. Now that trusted sessions are exempt, this works again — and the
-- fact that it works IS the proof that fix #1 above is effective.
-- ============================================================================

update users
   set role = 'super_admin', status = 'approved'
 where email = 'fmlozano@megawide.com.ph';

-- Confirm:
select email, role, status from users where email = 'fmlozano@megawide.com.ph';


-- ============================================================================
-- VERIFY (after running this file)
--
-- 1. In the SQL editor — the bootstrap path must work again:
--      update users set role = 'planner' where email = 'fmlozano@megawide.com.ph';
--      update users set role = 'super_admin' where email = 'fmlozano@megawide.com.ph';
--    Both must succeed with no exception.
--
-- 2. From the app as a NON-admin (have an admin demote you, or use a second
--    account) — all of these must still be refused with 42501:
--      await getSB().from('users').update({ role:'super_admin' }).eq('id', myUid);
--      await getSB().from('users').update({ status:'approved' }).eq('id', myUid);
--      await getSB().from('drawing_register').update({ status:'Approved' }).eq('id', someId);
--    While these must still succeed:
--      await getSB().from('users').update({ name:'New Name' }).eq('id', myUid);
--      await getSB().from('drawing_register').update({ remarks:'ok' }).eq('id', someId);
-- ============================================================================
