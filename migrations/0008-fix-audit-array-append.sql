-- ============================================================================
-- Engineering App — 0008: fix a bug in 0007 that BLOCKS all privilege changes
-- ----------------------------------------------------------------------------
-- Run immediately. Idempotent. 0007 must be applied first (this replaces its
-- trigger function).
--
-- ⚠️ IF YOU HAVE RUN 0007, ADMINISTRATION IS CURRENTLY BROKEN. Changing a role,
-- approving an account, or assigning projects all fail with:
--
--     malformed array literal: "projects"
--
-- THE BUG
-- 0007's trigger accumulated the list of changed columns like this:
--
--     v_changed := v_changed || 'projects';        -- v_changed is text[]
--
-- Postgres has two candidate operators here — `anyarray || anyelement` (append
-- one element) and `anyarray || anyarray` (concatenate two arrays). With an
-- UNTYPED string literal on the right, resolution picks array || array, so
-- Postgres tries to parse 'projects' AS an array literal and raises. The
-- exception propagates out of the AFTER trigger and aborts the whole UPDATE.
--
-- Net effect: instead of recording privilege changes, 0007 PREVENTED them. The
-- audit row is never written either, because the statement rolls back.
--
-- THE FIX
-- Use array_append(), which has exactly one meaning and cannot be mis-resolved.
-- (`v_changed || 'projects'::text` would also work; array_append is clearer about
-- the intent and immune to a future editor dropping the cast.)
--
-- WHY IT WASN'T CAUGHT
-- 0007 was written and shipped without exercising a privilege change against the
-- database. Every other guard in 0005/0006 was tested by actually attempting the
-- thing it was meant to allow or refuse; this one was not, and it was the one
-- that broke. The verify block at the bottom is now a real test, not a comment.
-- ============================================================================

create or replace function users_audit_trg() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_changed text[] := '{}';
  v_actor   uuid   := auth.uid();
  v_name    text;
  v_email   text;
  v_old     jsonb;
  v_new     jsonb;
begin
  if tg_op <> 'INSERT' then
    v_old := jsonb_build_object('email', old.email, 'name', old.name,
               'role', old.role, 'status', old.status, 'projects', old.projects);
  end if;
  if tg_op <> 'DELETE' then
    v_new := jsonb_build_object('email', new.email, 'name', new.name,
               'role', new.role, 'status', new.status, 'projects', new.projects);
  end if;

  if tg_op = 'UPDATE' then
    -- array_append, NOT `|| 'literal'` — see the header. This is the whole fix.
    if new.role     is distinct from old.role     then v_changed := array_append(v_changed, 'role');     end if;
    if new.status   is distinct from old.status   then v_changed := array_append(v_changed, 'status');   end if;
    if new.projects is distinct from old.projects then v_changed := array_append(v_changed, 'projects'); end if;
    if new.email    is distinct from old.email    then v_changed := array_append(v_changed, 'email');    end if;
    -- Nothing security-relevant moved (a name edit, or last_login churn) → do not
    -- record anything.
    if array_length(v_changed, 1) is null then return null; end if;
  end if;

  select u.name, u.email into v_name, v_email from users u where u.id = v_actor;

  insert into engineering_audit (
    table_name, record_id, project_id, action, actor_id, actor_name, actor_email,
    changed_fields, old_data, new_data
  ) values (
    'users',
    coalesce(new.id, old.id),
    null,
    tg_op,
    v_actor,
    coalesce(v_name, case when v_actor is null then '(server-side / SQL editor)' end),
    v_email,
    nullif(v_changed, '{}'),
    v_old, v_new
  );
  return null;
end $$;


-- ============================================================================
-- VERIFY — run this. It is a test, not a suggestion.
-- Every statement below must succeed, and the select must return three rows.
-- ============================================================================

-- 1. A projects change (the exact case that failed).
update users set projects = array['ZZTEST']::text[] where email = 'fmlozano@megawide.com.ph';
update users set projects = '{}'::text[]             where email = 'fmlozano@megawide.com.ph';

-- 2. A role change round-trip.
update users set role = 'planner'     where email = 'fmlozano@megawide.com.ph';
update users set role = 'super_admin' where email = 'fmlozano@megawide.com.ph';

-- 3. A name edit, which must NOT be audited.
update users set name = 'Francis Lozano' where email = 'fmlozano@megawide.com.ph';

-- Expect 4 rows: projects x2, role x2. NO row for the name edit.
select at, actor, action, record_label, summary, changed_fields
from engineering_activity
where table_name = 'users'
order by at desc;

-- And confirm the account is left in the right state.
select email, role, status, projects from users where email = 'fmlozano@megawide.com.ph';
