-- ============================================================================
-- Engineering App — 0002: Audit trail, approval authority, revision history
-- ----------------------------------------------------------------------------
-- Run AFTER 0001-engineering-core.sql. Idempotent — safe to re-run.
--
-- These are the ONLY two deliberate extensions beyond what the Planners
-- Dashboard already does. Both exist because engineering records are
-- CONTROLLED DOCUMENTS and the Planning App has no equivalent:
--
--   1. AUDIT TRAIL. The Planning App's only traceability is
--      created_by/created_at/updated_at — it cannot answer "who changed this
--      status, when, and from what?", and a deleted row is gone. Section 1 adds
--      a generic audit table + trigger capturing user, time, action, record,
--      previous value and new value, including a full snapshot on DELETE (so an
--      accidental delete is recoverable).
--
--   2. APPROVAL AUTHORITY. The Planning App's RLS grants every non-viewer the
--      same write rights, so any `user` can mark a drawing Approved. The spec
--      requires review/approve to be a distinct permission enforced
--      server-side, not a hidden button. Section 2 adds a trigger restricting
--      transitions INTO an approval/rejection status to is_planner().
--
-- ⚠️ WHAT THIS DELIBERATELY DOES *NOT* DO — blocking writes that shrink the
-- `submissions` jsonb array (the revision history) was considered and rejected.
-- Both modules legitimately rewrite that array wholesale during Excel re-import,
-- so a shrink-guard would break imports. Revision history is protected by
-- RECOVERABILITY instead: every change to `submissions` is captured in
-- engineering_audit with the full before/after jsonb, so history can always be
-- reconstructed. Revisit only if imports move to an append-only path.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — AUDIT TRAIL
-- ============================================================================

create table if not exists engineering_audit (
  id             bigserial primary key,
  table_name     text        not null,
  record_id      uuid        not null,
  project_id     text,                       -- denormalised so RLS can scope reads
  action         text        not null check (action in ('INSERT','UPDATE','DELETE')),
  actor_id       uuid,                       -- auth.uid() at the time of the change
  actor_name     text,                       -- resolved at write time: users.name
  actor_email    text,
  changed_fields text[],                     -- UPDATE only: which columns moved
  old_data       jsonb,                      -- previous value (UPDATE/DELETE)
  new_data       jsonb,                      -- new value (INSERT/UPDATE)
  at             timestamptz not null default now()
);

create index if not exists engineering_audit_record_idx  on engineering_audit (table_name, record_id, at desc);
create index if not exists engineering_audit_project_idx on engineering_audit (project_id, at desc);
create index if not exists engineering_audit_actor_idx   on engineering_audit (actor_id, at desc);

comment on table engineering_audit is
  'Append-only audit trail for engineering controlled documents. Written ONLY by '
  'the engineering_audit_trg() trigger (security definer). Clients may read '
  'within their project scope and can never insert, update or delete.';

-- Columns whose churn would bury the meaningful history. `updated_at` moves on
-- every single write, so recording it as a "change" makes every diff noisy.
create or replace function engineering_audit_ignored_cols() returns text[]
  language sql immutable as $$ select array['updated_at']::text[] $$;

create or replace function engineering_audit_trg() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_old      jsonb;
  v_new      jsonb;
  v_changed  text[] := '{}';
  k          text;
  v_actor    uuid := auth.uid();
  v_name     text;
  v_email    text;
  v_pid      text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new); v_pid := new.project_id;
  elsif tg_op = 'DELETE' then
    v_old := to_jsonb(old); v_pid := old.project_id;
  else
    v_old := to_jsonb(old); v_new := to_jsonb(new); v_pid := new.project_id;
    -- Diff the two snapshots. A key counts as changed when the values differ,
    -- treating NULL and absent as equal so added columns don't show as edits.
    for k in select jsonb_object_keys(v_new) loop
      if k = any (engineering_audit_ignored_cols()) then continue; end if;
      if coalesce(v_old -> k, 'null'::jsonb) is distinct from coalesce(v_new -> k, 'null'::jsonb) then
        v_changed := v_changed || k;
      end if;
    end loop;
    -- Nothing meaningful moved (e.g. an updated_at-only touch) → record nothing.
    if array_length(v_changed, 1) is null then return null; end if;
  end if;

  -- Resolve the actor's name once, at write time. Storing it (rather than
  -- joining users later) keeps the trail readable after a user is deleted —
  -- admin_delete_user() removes the profile row, and an audit entry that read
  -- "(unknown) approved DR-001" would defeat the purpose.
  select u.name, u.email into v_name, v_email from users u where u.id = v_actor;

  insert into engineering_audit (
    table_name, record_id, project_id, action, actor_id, actor_name, actor_email,
    changed_fields, old_data, new_data
  ) values (
    tg_table_name,
    coalesce((v_new ->> 'id')::uuid, (v_old ->> 'id')::uuid),
    v_pid, tg_op, v_actor, v_name, v_email,
    nullif(v_changed, '{}'), v_old, v_new
  );
  return null;   -- AFTER trigger; return value is ignored
end $$;

do $$
declare t text;
begin
  foreach t in array array['drawing_register','material_submittal'] loop
    execute format('drop trigger if exists %I on %I', 'audit_'||t, t);
    execute format('create trigger %I after insert or update or delete on %I
                    for each row execute function engineering_audit_trg()', 'audit_'||t, t);
  end loop;
end $$;

-- RLS: readable within project scope; NOT writable by clients at all. The
-- trigger is security definer, so it writes regardless of these policies.
alter table engineering_audit enable row level security;

drop policy if exists engineering_audit_read on engineering_audit;
create policy engineering_audit_read on engineering_audit
  for select using (project_id is null or can_access_project(project_id));

-- No insert/update/delete policy exists → all three are denied for
-- `authenticated`. Revoke as well, so the failure is a clear 42501 rather than
-- a silently empty RLS rejection.
grant select on engineering_audit to authenticated;
revoke insert, update, delete on engineering_audit from authenticated;

-- Human-readable feed. Renders the same sentences the spec asks for, e.g.
--   "Juan Dela Cruz changed Drawing DR-001 status from Submitted to Approved."
create or replace view engineering_activity as
select
  a.id, a.at, a.table_name, a.record_id, a.project_id, a.action,
  a.actor_id, coalesce(a.actor_name, a.actor_email, '(deleted user)') as actor,
  a.changed_fields,
  coalesce(a.new_data ->> 'drawing_no',  a.old_data ->> 'drawing_no',
           a.new_data ->> 'submittal_no', a.old_data ->> 'submittal_no',
           a.new_data ->> 'title',        a.old_data ->> 'title') as record_label,
  a.old_data ->> 'status'   as old_status,
  a.new_data ->> 'status'   as new_status,
  a.old_data ->> 'revision' as old_revision,
  a.new_data ->> 'revision' as new_revision,
  case
    when a.action = 'INSERT' then 'created'
    when a.action = 'DELETE' then 'deleted'
    when (a.old_data ->> 'status') is distinct from (a.new_data ->> 'status')
      then 'status: ' || coalesce(nullif(a.old_data ->> 'status',''), 'Not Started')
                      || ' → ' || coalesce(nullif(a.new_data ->> 'status',''), 'Not Started')
    when (a.old_data ->> 'revision') is distinct from (a.new_data ->> 'revision')
      then 'revision: ' || coalesce(a.old_data ->> 'revision','—')
                        || ' → ' || coalesce(a.new_data ->> 'revision','—')
    else 'edited ' || array_to_string(a.changed_fields, ', ')
  end as summary
from engineering_audit a;

-- A view is not RLS-bearing itself; it inherits the base table's policies
-- because it is not security_invoker=off. Explicit for clarity:
alter view engineering_activity set (security_invoker = true);
grant select on engineering_activity to authenticated;


-- ============================================================================
-- SECTION 2 — APPROVAL AUTHORITY (review/approve is planner+ only)
-- ============================================================================

-- The statuses that represent a REVIEW DECISION. Reaching any of these is an
-- act of authority, not data entry. Kept as a function so both modules' status
-- vocabularies live in one place (they differ: the Drawing Register uses
-- "Approved w/ comments" lowercase-c, Material Submittal "Approved w/ Comments").
create or replace function engineering_decision_statuses() returns text[]
  language sql immutable as $$ select array[
    -- drawing_register
    'Approved', 'Approved w/ comments', 'Approved w/o comments',
    -- material_submittal
    'Approved w/ Comments', 'Rejected',
    -- shared
    'Resubmit'
  ]::text[] $$;

create or replace function engineering_guard_decision() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  -- Only a TRANSITION INTO a decision status is gated. Editing any other field
  -- on an already-approved row is untouched, so a `user` can still fix a typo
  -- in the remarks of an approved drawing.
  if new.status is distinct from old.status
     and new.status = any (engineering_decision_statuses())
     and not is_planner() then
    raise exception
      'Your role may not set status "%" — review and approval require the '
      'planner, admin or super_admin role.', new.status
      using errcode = '42501';
  end if;
  return new;
end $$;

-- ⚠️ UPDATE ONLY, deliberately. INSERT is not gated because both modules bulk-
-- import historical Excel registers whose rows are ALREADY approved; gating
-- inserts would make a `user` unable to import a legacy register at all. The
-- integrity goal is to stop someone self-approving a live document, and a
-- freshly inserted row has no prior state to escalate from. Every insert is
-- still captured in engineering_audit with its actor.
do $$
declare t text;
begin
  foreach t in array array['drawing_register','material_submittal'] loop
    execute format('drop trigger if exists %I on %I', 'guard_decision_'||t, t);
    execute format('create trigger %I before update of status on %I
                    for each row execute function engineering_guard_decision()',
                   'guard_decision_'||t, t);
  end loop;
end $$;


-- ============================================================================
-- SECTION 3 — REVISION HISTORY VIEW
-- ----------------------------------------------------------------------------
-- Both modules store revisions as a `submissions` jsonb array on the row rather
-- than as child rows, so revision history is invisible to SQL. This flattens it
-- into one row per drawing per revision — what the spec's "view the revision
-- history of a drawing" needs, and what any future report or export should read.
--
--   drawing_no | revision | status   | planned    | actual
--   DR-001     | 0        | Approved | 2026-01-10 | 2026-01-14
--   DR-001     | 1        | Submitted| 2026-03-01 | 2026-03-04
-- ============================================================================

create or replace view drawing_revisions as
select
  d.id            as drawing_id,
  d.project_id,
  d.drawing_no,
  d.drawing_code,
  d.title,
  d.discipline,
  d.parent_id,
  coalesce(s.ord - 1, 0)                   as rev_index,
  coalesce(s.item ->> 'rev', d.revision)   as revision,
  nullif(s.item ->> 'status','')           as status,
  nullif(s.item ->> 'planned','')::date    as planned_submission,
  nullif(s.item ->> 'actual','')::date     as actual_submission,
  nullif(s.item ->> 'approved','')::date   as approved_on,
  s.item ->> 'file_url'                    as file_url,
  d.created_by, d.created_at, d.updated_at
from drawing_register d
left join lateral (
  select item, ord
  from jsonb_array_elements(
         case when jsonb_typeof(d.submissions) = 'array' then d.submissions else '[]'::jsonb end
       ) with ordinality as t(item, ord)
) s on true
where coalesce(d.node_kind, 'drawing') = 'drawing';   -- exclude tree/group rows

alter view drawing_revisions set (security_invoker = true);
grant select on drawing_revisions to authenticated;

-- ⚠️ Material Submittal models revisions DIFFERENTLY from the Drawing Register.
-- It has NO `submissions` jsonb column — a resubmission is a SEPARATE ROW that
-- reuses the same submittal_no with a higher `revision_no` (the same reason the
-- module treats "one submittal, two document types" as two rows). So revision
-- history here is derived by grouping rows, not by unnesting an array.
-- `is_latest` marks the current controlled revision of each submittal.
create or replace view material_submittal_revisions as
select
  m.id            as submittal_id,
  m.project_id,
  m.submittal_no,
  m.material,
  m.discipline,
  m.trade_section,
  coalesce(m.revision_no, '0')  as revision,
  m.status,
  m.plan_submission_date        as planned_submission,
  m.date_submitted              as actual_submission,
  m.plan_approval_date          as planned_approval,
  m.date_approved               as approved_on,
  m.approver_consultant,
  m.approver_client,
  m.file_url,
  row_number() over (
    partition by m.project_id, m.submittal_no
    order by m.revision_no nulls first, m.created_at
  ) as rev_index,
  (row_number() over (
    partition by m.project_id, m.submittal_no
    order by m.revision_no desc nulls last, m.created_at desc
  ) = 1) as is_latest,
  m.created_by, m.created_at, m.updated_at
from material_submittal m
where m.submittal_no is not null;

alter view material_submittal_revisions set (security_invoker = true);
grant select on material_submittal_revisions to authenticated;

-- Done.
