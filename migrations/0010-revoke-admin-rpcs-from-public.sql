-- ============================================================================
-- Engineering App — 0010: actually revoke the project admin RPCs
-- ----------------------------------------------------------------------------
-- Run immediately after 0009. Idempotent.
--
-- ⚠️ 0009 IS INCOMPLETE. Verified against the live database: after applying it, a
-- signed-in admin could still archive and delete projects.
--
--     await getSB().rpc('admin_archive_project', { target:'BAU101', archive:true });
--     → SUCCEEDED. BAU101 was archived.
--
-- 0009's table-level work was fine — insert/update/delete on projects and
-- workspaces are correctly refused with 42501. Only the FUNCTION revokes failed.
--
-- WHY
-- 0009 did:
--     revoke execute on function admin_archive_project(text, boolean)
--       from anon, authenticated;
--
-- but PostgreSQL grants EXECUTE on every new function to **PUBLIC** by default.
-- `authenticated` therefore still held EXECUTE *via PUBLIC*, and revoking from
-- the role directly does nothing about a privilege inherited from PUBLIC. The
-- table revokes in 0009 worked precisely because that file DID include
-- `from public` for tables — the same clause was simply missing for functions.
--
-- The second RPC gave the tell, and it was misread at first: admin_delete_project
-- appeared to be "REFUSED", but its message was
--     "Project BAU101 still has data in: drawing_register (511). Archive it…"
-- which is the function's OWN business rule. To produce that message it had to
-- EXECUTE. A permission failure would have said "permission denied for function".
-- ============================================================================

-- ---- the fix: include PUBLIC ------------------------------------------------
revoke execute on function admin_archive_project(text, boolean) from public, anon, authenticated;
revoke execute on function admin_delete_project(text)           from public, anon, authenticated;
revoke execute on function admin_delete_workspace(text)         from public, anon, authenticated;

-- service_role keeps EXECUTE (it is not PUBLIC-derived and is not revoked here),
-- so migrate-data.mjs and any future maintenance are unaffected.

-- ⚠️ Any NEW function added later starts with EXECUTE granted to PUBLIC again.
-- If you add a privileged RPC, revoke from PUBLIC explicitly — do not assume
-- `from authenticated` is enough.


-- ============================================================================
-- VERIFY — as a signed-in ADMIN in the app. Both must now be refused, and the
-- error must mention PERMISSION, not a business rule:
--
--   await getSB().rpc('admin_archive_project', { target:'BAU101', archive:true });
--   await getSB().rpc('admin_delete_workspace', { target:'CALIMAG' });
--
-- Expect: "permission denied for function admin_archive_project".
--
-- ⚠️ Do NOT test with `admin_delete_project` on a real project. If the revoke has
-- not worked, the only thing standing between the call and a deleted project is
-- that function's own "still has data" check — which passes happily for any
-- project that has no module rows yet.
--
-- Then confirm BAU101 is still active and untouched:
--   select id, status from projects where id = 'BAU101';       -- active
--   select count(*) from drawing_register where project_id = 'BAU101';  -- 511
--
-- And that the grants are genuinely gone:
--   select p.proname, coalesce(array_to_string(p.proacl, ' '), '(default: PUBLIC)') as acl
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('admin_archive_project','admin_delete_project','admin_delete_workspace');
--   -- No entry should grant =X to anon, authenticated, or an empty (PUBLIC) role.
-- ============================================================================


-- ============================================================================
-- ROLLBACK
--   grant execute on function admin_archive_project(text, boolean) to authenticated;
--   grant execute on function admin_delete_project(text)           to authenticated;
--   grant execute on function admin_delete_workspace(text)         to authenticated;
-- (This restores role-level EXECUTE, not the original PUBLIC default, which is
-- the safer of the two anyway.)
-- ============================================================================
