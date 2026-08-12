-- ============================================================================
-- Engineering App — 0011: group_heads replaces the workspaces tree
--
-- Mirrors the Planners Dashboard migration of the same date. The Workspace →
-- Program → Group tree collapsed into ONE tag: projects.group_head_id.
--
-- ⚠️ RUN THE PLANNERS DASHBOARD MIGRATION FIRST, then re-run the sync
--     node migrate-data.mjs --only=group_heads,projects
-- This file only prepares the destination schema; it does not move data. Run it
-- BEFORE the sync, or the sync fails on a missing table / missing column.
--
-- Read-only here, exactly like projects: this app SOURCES org structure, it does
-- not author it (see 0009, and Perm.canEditProjects()). So group_heads gets a
-- read policy and no write policy, and its write privileges are revoked.
-- Idempotent (safe to re-run).
-- ============================================================================

-- ---- 1. the mirrored lookup table -----------------------------------------
-- Same shape as the source. No RPCs and no write policy: nothing in this app
-- creates or edits a group head, and the sync writes with the service role,
-- which bypasses RLS.
create table if not exists group_heads (
  id          text primary key,
  name        text not null,
  sort_order  int  default 0,
  active      boolean default true,
  created_at  timestamptz default now()
);

alter table group_heads enable row level security;

drop policy if exists group_heads_read on group_heads;
create policy group_heads_read on group_heads for select using (is_approved());

-- No group_heads_write policy, by design. With RLS on and no write policy every
-- insert/update/delete is denied; the revoke below turns that from a silent
-- 0-row success into an explicit "permission denied" (see 0004/0009 on why that
-- distinction matters).
revoke insert, update, delete on group_heads from anon, authenticated;
grant select on group_heads to anon, authenticated;

-- ---- 2. the tag on projects -----------------------------------------------
alter table projects add column if not exists group_head_id text references group_heads(id);
create index if not exists projects_group_head_idx on projects (group_head_id);

-- ---- 3. drop the tree ------------------------------------------------------
-- Safe to drop unconditionally HERE (unlike in the Planners Dashboard, which
-- backfills first): this database is a mirror. Nothing in it is a source of
-- truth, so anything lost is re-synced from the Dashboard.
drop function if exists admin_delete_workspace(text);
alter table projects drop column if exists workspace_id;
alter table projects drop column if exists group_head;
drop table if exists workspaces;

-- ---- 4. verify -------------------------------------------------------------
-- Signed in as a normal approved user, in the browser console:
--   await getSB().from('group_heads').select('*');                 -- reading works
--   await getSB().from('group_heads').insert({id:'ZZ',name:'x'});  -- must FAIL
-- ============================================================================
