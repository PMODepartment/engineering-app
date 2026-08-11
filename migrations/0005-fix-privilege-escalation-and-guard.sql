-- ============================================================================
-- Engineering App — 0005: SECURITY FIXES (privilege escalation + approval guard)
-- ----------------------------------------------------------------------------
-- Run immediately. Idempotent. Two real defects, both found by testing the live
-- database as a demoted (role = 'user') account rather than by reading the code.
--
--   BUG 1 — PRIVILEGE ESCALATION. Any approved user could make themselves
--           super_admin with one request. INHERITED FROM THE PLANNERS DASHBOARD,
--           which has the same hole — see the note at the end.
--
--   BUG 2 — The approval guard from 0002 did not fire. A role = 'user' account
--           successfully set a drawing's status to 'Approved'.
--
-- Reproduction of BUG 1, as a plain `user` (this SUCCEEDED before this migration):
--   await getSB().from('users').update({ role:'super_admin' }).eq('id', myUid);
-- ============================================================================


-- ============================================================================
-- SECTION 1 — BUG 1: PRIVILEGE ESCALATION VIA users UPDATE
-- ----------------------------------------------------------------------------
-- The inherited policy was:
--
--   create policy users_admin_update on users for update
--     using (auth.uid() = id or is_admin());
--
-- The `auth.uid() = id` branch exists for a legitimate reason — a user updating
-- their own profile (name, last_login). But the policy has:
--   • no WITH CHECK clause, and
--   • no restriction on WHICH COLUMNS may change.
--
-- So "update your own row" silently included "update your own role". Any approved
-- user could become super_admin, which then grants every project, the
-- Administration screen, and approval authority.
--
-- WHY THIS IS FIXED WITH A TRIGGER, NOT A BETTER POLICY: an RLS WITH CHECK
-- expression is evaluated against the NEW row only — it cannot see OLD, so it
-- cannot express "role must not have changed". Postgres has no column-level RLS.
-- A BEFORE UPDATE trigger is the correct and only clean mechanism.
-- ============================================================================

create or replace function users_guard_self_escalation() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  -- An admin may change anyone's role/status/projects. That is the whole point
  -- of the Administration screen.
  if is_admin() then
    return new;
  end if;

  -- Everyone else may edit their own profile, but NOT their privileges.
  if new.role is distinct from old.role then
    raise exception 'You may not change your own role.'
      using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    raise exception 'You may not change your own account status.'
      using errcode = '42501';
  end if;
  if new.projects is distinct from old.projects then
    raise exception 'You may not change your own project assignments.'
      using errcode = '42501';
  end if;
  -- Changing `id` would re-point the row at another auth user.
  if new.id is distinct from old.id then
    raise exception 'You may not change a profile id.'
      using errcode = '42501';
  end if;

  return new;
end $$;

-- ⚠️ Plain BEFORE UPDATE, deliberately NOT `before update of role, status, ...`.
-- An `UPDATE OF <cols>` trigger only fires when those columns appear in the SET
-- list, which makes the protection depend on how the client phrases its request.
-- For a security guard that is the wrong trade: always fire, then compare.
drop trigger if exists users_guard_self_escalation on users;
create trigger users_guard_self_escalation
  before update on users
  for each row execute function users_guard_self_escalation();

-- Belt and braces: also stop a non-admin INSERTing themselves as pre-approved.
-- The users_self_insert policy only checks `auth.uid() = id`, so a brand-new
-- registration could previously self-declare role='super_admin', status='approved'.
-- auth.js always sends user/pending, but the policy never enforced it.
create or replace function users_guard_self_insert() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_admin() then
    return new;
  end if;
  -- A self-registration is always an unprivileged, unapproved account.
  if new.role is distinct from 'user' or new.status is distinct from 'pending'
     or coalesce(array_length(new.projects, 1), 0) <> 0 then
    raise exception
      'A new account must be created as role=user, status=pending with no '
      'project assignments; an administrator grants access afterwards.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists users_guard_self_insert on users;
create trigger users_guard_self_insert
  before insert on users
  for each row execute function users_guard_self_insert();


-- ============================================================================
-- SECTION 2 — BUG 2: THE APPROVAL GUARD DID NOT FIRE
-- ----------------------------------------------------------------------------
-- 0002 created the guard as:
--   create trigger guard_decision_<t> BEFORE UPDATE OF status ON <t> ...
--
-- Same root cause as above: `UPDATE OF status` is not a reliable gate. It fires
-- only when `status` is in the statement's SET list, and it is easy for a client
-- to change the effective status without naming that column in a way the trigger
-- recognises. Recreated as a plain BEFORE UPDATE that always fires and then
-- compares old vs new — the guard's own condition already checks
-- `new.status is distinct from old.status`, so behaviour is otherwise identical.
--
-- (If the trigger was simply missing on your database, this recreates it either
-- way. Verify with the query at the bottom.)
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['drawing_register','material_submittal'] loop
    execute format('drop trigger if exists %I on %I', 'guard_decision_'||t, t);
    execute format('create trigger %I before update on %I
                    for each row execute function engineering_guard_decision()',
                   'guard_decision_'||t, t);
  end loop;
end $$;


-- ============================================================================
-- SECTION 3 — VERIFY
-- ----------------------------------------------------------------------------
-- 1. All FIVE triggers must be present and enabled ('O'):
--
--    select tgrelid::regclass as tbl, tgname, tgenabled
--    from pg_trigger
--    where not tgisinternal
--      and tgname in ('audit_drawing_register','audit_material_submittal',
--                     'guard_decision_drawing_register',
--                     'guard_decision_material_submittal',
--                     'users_guard_self_escalation','users_guard_self_insert')
--    order by tbl, tgname;
--
-- 2. From the app, as a DEMOTED account (role = 'user'), all three must fail
--    with 42501, and the last must still succeed:
--
--    await getSB().from('users').update({ role:'super_admin' }).eq('id', myUid);
--    await getSB().from('users').update({ status:'approved' }).eq('id', myUid);
--    await getSB().from('drawing_register').update({ status:'Approved' }).eq('id', someId);
--    await getSB().from('drawing_register').update({ remarks:'ok' }).eq('id', someId);
--
-- 3. An admin must still be able to manage users — confirm the Administration
--    screen can change a role and approve an account after this migration.
-- ============================================================================


-- ============================================================================
-- ⚠️ THE PLANNERS DASHBOARD HAS BUG 1 TOO
-- ----------------------------------------------------------------------------
-- `users_admin_update` came verbatim from that project's schema, so the same
-- self-promotion works there against `bgupuqnkqhixpuctyder` — and that app has
-- far more data and more users. Sections 1's two functions and two triggers are
-- self-contained and reference only `is_admin()` and the `users` table, both of
-- which exist there identically, so this section can be applied to the Planners
-- Dashboard project unchanged.
--
-- Test it there the same way before and after, using a non-admin account.
-- ============================================================================
