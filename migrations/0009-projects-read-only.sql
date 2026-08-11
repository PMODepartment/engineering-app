-- ============================================================================
-- Engineering App — 0009: projects and workspaces become READ-ONLY here
-- ----------------------------------------------------------------------------
-- Idempotent. Rollback at the bottom.
--
-- DECISION
-- The Planners Dashboard is the single place projects and workspaces are created
-- and maintained. The Engineering App SOURCES them and never edits them.
--
-- WHY THIS IS ENFORCED IN THE DATABASE, NOT JUST THE UI
-- The two apps are on separate Supabase projects, so nothing propagates between
-- them: a project created here would be invisible in the Planners Dashboard, and
-- the periodic re-sync (`migrate-data.mjs --only=workspaces,projects`) upserts
-- keyed on id — so it would OVERWRITE local edits and never delete local
-- additions. Divergence would be silent, and would show up as "my project is
-- missing" weeks later. Hiding the buttons is not enough: the REST API is public
-- and RLS is the only real boundary (see README §3).
--
-- ⚠️ TWO SURFACES HAVE TO BE CLOSED, and the second is easy to miss:
--   1. the RLS write policies on projects / workspaces, and
--   2. admin_archive_project / admin_delete_project / admin_delete_workspace —
--      SECURITY DEFINER functions, which BYPASS RLS by design. Dropping the
--      policies alone would leave archive and delete fully working.
--
-- The migration script is unaffected: it connects with a service_role/secret key,
-- which bypasses both RLS and these grants.
-- ============================================================================


-- ---- 1. remove the write policies -----------------------------------------
-- Reads stay exactly as they were: project-scoped for normal users, everything
-- for admins.
drop policy if exists projects_ins   on projects;
drop policy if exists projects_upd   on projects;
drop policy if exists projects_del   on projects;
drop policy if exists workspaces_write on workspaces;

-- With RLS enabled and no write policy, every insert/update/delete is denied.
-- Belt and braces, and for a clearer error: also remove the table privilege, so
-- the failure is "permission denied" rather than a silent 0-row success. (0004
-- documents why that distinction matters — a policy-blocked DELETE returns 204
-- having done nothing, which reads like success.)
revoke insert, update, delete on projects   from anon, authenticated;
revoke insert, update, delete on workspaces  from anon, authenticated;
grant select on projects   to anon, authenticated;
grant select on workspaces to anon, authenticated;


-- ---- 2. close the SECURITY DEFINER back door ------------------------------
-- These run as the function owner and ignore RLS, so revoking EXECUTE is the only
-- way to stop them. Nothing in the Engineering App calls them after this; the
-- Planners Dashboard has its own copies, unaffected.
-- ⚠️ THESE THREE LINES ARE NOT SUFFICIENT — see 0010, which must also be applied.
-- PostgreSQL grants EXECUTE on every new function to PUBLIC by default, so
-- `authenticated` keeps EXECUTE *via PUBLIC* and these revokes have no effect.
-- Verified the hard way: after 0009 alone, an admin still archived a live project.
revoke execute on function admin_archive_project(text, boolean) from public, anon, authenticated;
revoke execute on function admin_delete_project(text)           from public, anon, authenticated;
revoke execute on function admin_delete_workspace(text)         from public, anon, authenticated;


-- ---- 3. keep user↔project ASSIGNMENT working ------------------------------
-- Assigning a user to a project writes `users.projects`, not `projects`, so it is
-- untouched by the above. That must keep working: it is how an admin grants
-- access here, and it is Engineering-App-specific — the two apps have separate
-- user tables, so assignments do NOT come across in the sync.
-- (No change needed; recorded so nobody "tidies up" users.projects next.)


-- ============================================================================
-- VERIFY
--
-- (a) As an admin IN THE APP, every one of these must now FAIL:
--       await getSB().from('projects').insert({ id:'ZZNEW', name:'x' });
--       await getSB().from('projects').update({ name:'y' }).eq('id','BAU101');
--       await getSB().from('projects').delete().eq('id','BAU101');
--       await getSB().from('workspaces').insert({ id:'ZZW', name:'x' });
--       await getSB().rpc('admin_archive_project', { target:'BAU101', archive:true });
--       await getSB().rpc('admin_delete_project',  { target:'BAU101' });
--
--     ⚠️ Check the ROW COUNT, not just the absence of an error, on update/delete:
--       select name, status from projects where id = 'BAU101';   -- must be unchanged
--
-- (b) These must still WORK:
--       await getSB().from('projects').select('*');               -- reading
--       await getSB().from('workspaces').select('*');             -- reading
--       -- and in Administration → Users: change a role, assign projects
--
-- (c) The sync must still work — from the import folder, with the secret keys:
--       node migrate-data.mjs --only=workspaces,projects --dry-run
--       node migrate-data.mjs --only=workspaces,projects
-- ============================================================================


-- ============================================================================
-- ROLLBACK — restores writable projects/workspaces exactly as 0001 had them.
-- ----------------------------------------------------------------------------
--   grant insert, update, delete on projects  to authenticated;
--   grant insert, update, delete on workspaces to authenticated;
--   grant execute on function admin_archive_project(text, boolean) to authenticated;
--   grant execute on function admin_delete_project(text)           to authenticated;
--   grant execute on function admin_delete_workspace(text)         to authenticated;
--
--   -- Copied VERBATIM from 0001. Do not paraphrase these: a first draft of this
--   -- block was written from memory and had projects_ins too permissive and
--   -- projects_del too strict, which would have silently changed who can do what.
--   create policy projects_ins on projects for insert
--     with check (is_planner());
--   create policy projects_upd on projects for update
--     using      (is_planner() and (is_admin() or can_access_project(id)))
--     with check (is_planner() and (is_admin() or can_access_project(id)));
--   create policy projects_del on projects for delete
--     using      (is_planner() and (is_admin() or can_access_project(id)));
--   create policy workspaces_write on workspaces for all
--     using (is_planner()) with check (is_planner());
--
--   Diff against 0001 §5 before trusting this block.
-- ============================================================================
