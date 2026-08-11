-- ============================================================================
-- Engineering App — 0007: audit privilege changes
-- ----------------------------------------------------------------------------
-- Run after 0006. Idempotent.
--
-- WHY
-- 0002 audits `drawing_register` and `material_submittal`, but not `users`. So a
-- change of ROLE — the most consequential change anyone can make in this system —
-- left no trace. The escalation bug found in 0005 could have been exploited with
-- no evidence: self-promote, approve your own drawings, demote back, and the trail
-- shows only a legitimate-looking planner approving work.
--
-- This records who changed whose privileges, when, and from what.
--
-- ⚠️ IT DOES NOT REUSE engineering_audit_trg(). That function does
-- `v_pid := new.project_id`, and `users` has no project_id column — plpgsql would
-- raise "record new has no field project_id" on the first write. A dedicated
-- trigger function is required, not a reused one.
--
-- ⚠️ IT DELIBERATELY IGNORES last_login. PDb.updateLastLogin() writes that column
-- on EVERY sign-in, so auditing it would bury real privilege changes under one
-- row per login per user per day. Only role / status / projects / id / email are
-- treated as audit-worthy; a name correction is not a security event either.
-- ============================================================================


-- ---- 1. trigger function ---------------------------------------------------
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
  -- Only the privilege-bearing columns. A redacted snapshot, not the whole row:
  -- the trail should answer "what access did this person have" without becoming a
  -- second copy of the user directory.
  if tg_op <> 'INSERT' then
    v_old := jsonb_build_object('email', old.email, 'name', old.name,
               'role', old.role, 'status', old.status, 'projects', old.projects);
  end if;
  if tg_op <> 'DELETE' then
    v_new := jsonb_build_object('email', new.email, 'name', new.name,
               'role', new.role, 'status', new.status, 'projects', new.projects);
  end if;

  if tg_op = 'UPDATE' then
    if new.role     is distinct from old.role     then v_changed := v_changed || 'role';     end if;
    if new.status   is distinct from old.status   then v_changed := v_changed || 'status';   end if;
    if new.projects is distinct from old.projects then v_changed := v_changed || 'projects'; end if;
    if new.email    is distinct from old.email    then v_changed := v_changed || 'email';    end if;
    -- Nothing security-relevant moved (a name edit, or a last_login touch) →
    -- record nothing.
    if array_length(v_changed, 1) is null then return null; end if;
  end if;

  select u.name, u.email into v_name, v_email from users u where u.id = v_actor;

  insert into engineering_audit (
    table_name, record_id, project_id, action, actor_id, actor_name, actor_email,
    changed_fields, old_data, new_data
  ) values (
    'users',
    coalesce(new.id, old.id),
    null,                     -- users are not project-scoped
    tg_op,
    v_actor,
    -- A trusted server-side session (SQL editor / service_role) has no auth.uid().
    -- Label it honestly rather than leaving the actor blank, so a role granted by
    -- hand in the SQL editor is distinguishable from one granted through the app.
    coalesce(v_name, case when v_actor is null then '(server-side / SQL editor)' end),
    v_email,
    nullif(v_changed, '{}'),
    v_old, v_new
  );
  return null;
end $$;

drop trigger if exists audit_users on users;
create trigger audit_users
  after insert or update or delete on users
  for each row execute function users_audit_trg();


-- ---- 2. privilege entries are admin-only ----------------------------------
-- engineering_audit_read was `project_id is null or can_access_project(...)`.
-- users entries carry project_id = null, so every approved user would be able to
-- read the whole organisation's role history. Module entries keep their existing
-- project-scoped visibility; users entries become admin-only.
drop policy if exists engineering_audit_read on engineering_audit;
create policy engineering_audit_read on engineering_audit
  for select using (
    case
      when table_name = 'users' then is_admin()
      else (project_id is null or can_access_project(project_id))
    end
  );


-- ---- 3. render privilege entries readably in the activity feed ------------
-- Adds `users` to the label/summary logic. Module rows are unchanged.
create or replace view engineering_activity as
select
  a.id, a.at, a.table_name, a.record_id, a.project_id, a.action,
  a.actor_id, coalesce(a.actor_name, a.actor_email, '(deleted user)') as actor,
  a.changed_fields,
  coalesce(a.new_data ->> 'drawing_no',   a.old_data ->> 'drawing_no',
           a.new_data ->> 'submittal_no', a.old_data ->> 'submittal_no',
           a.new_data ->> 'email',        a.old_data ->> 'email',
           a.new_data ->> 'title',        a.old_data ->> 'title') as record_label,
  a.old_data ->> 'status'   as old_status,
  a.new_data ->> 'status'   as new_status,
  a.old_data ->> 'revision' as old_revision,
  a.new_data ->> 'revision' as new_revision,
  case
    when a.action = 'INSERT' then 'created'
    when a.action = 'DELETE' then 'deleted'
    when a.table_name = 'users' and (a.old_data ->> 'role') is distinct from (a.new_data ->> 'role')
      then 'role: ' || coalesce(a.old_data ->> 'role', '—')
                    || ' → ' || coalesce(a.new_data ->> 'role', '—')
    when a.table_name = 'users' and (a.old_data ->> 'status') is distinct from (a.new_data ->> 'status')
      then 'account: ' || coalesce(a.old_data ->> 'status', '—')
                       || ' → ' || coalesce(a.new_data ->> 'status', '—')
    when (a.old_data ->> 'status') is distinct from (a.new_data ->> 'status')
      then 'status: ' || coalesce(nullif(a.old_data ->> 'status',''), 'Not Started')
                      || ' → ' || coalesce(nullif(a.new_data ->> 'status',''), 'Not Started')
    when (a.old_data ->> 'revision') is distinct from (a.new_data ->> 'revision')
      then 'revision: ' || coalesce(a.old_data ->> 'revision','—')
                        || ' → ' || coalesce(a.new_data ->> 'revision','—')
    else 'edited ' || array_to_string(a.changed_fields, ', ')
  end as summary
from engineering_audit a;

alter view engineering_activity set (security_invoker = true);
grant select on engineering_activity to authenticated;


-- ============================================================================
-- VERIFY
--
--   -- as an admin, change someone's role, then:
--   select at, actor, action, record_label, summary, changed_fields
--   from engineering_activity where table_name = 'users' order by at desc;
--
--   -- last_login churn must NOT appear (sign in a few times, then):
--   select count(*) from engineering_audit
--   where table_name = 'users' and changed_fields is null and action = 'UPDATE';
--   -- expect 0
--
--   -- a non-admin must not see privilege history at all:
--   await getSB().from('engineering_activity').select('*').eq('table_name','users');
--   -- expect []
-- ============================================================================
