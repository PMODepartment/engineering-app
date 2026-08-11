-- ============================================================================
-- Engineering App — 0004: harden the audit trail's grants
-- ----------------------------------------------------------------------------
-- Run any time after 0002. Idempotent. Small but worth doing.
--
-- WHY
-- 0002 revoked insert/update/delete on engineering_audit from `authenticated`,
-- on the assumption that this made the table append-only at the privilege level
-- as well as the policy level. Probing the live project showed that is only half
-- true:
--
--   • Supabase ships DEFAULT PRIVILEGES that grant BOTH `anon` and
--     `authenticated` full DML on any new table in `public`. 0002 revoked from
--     `authenticated` only, so `anon` kept its grant.
--   • The table is still safe — it has no insert/update/delete POLICY, so RLS
--     rejects every write. Verified: an anonymous DELETE affected 0 rows.
--   • But the failure mode is a silent `204 / []` ("deleted nothing") rather than
--     a clear `42501 permission denied`. For an audit trail, "your attempt to
--     tamper was refused" should be unambiguous, and a table nobody may write to
--     should not carry the privilege to write to it.
--
-- This closes both roles, so the guarantee holds at two independent layers:
-- no GRANT, and no POLICY.
-- ============================================================================

revoke insert, update, delete on engineering_audit from anon, authenticated;
revoke insert, update, delete on engineering_audit from public;

-- `select` is intentionally kept — the Activity page reads the trail, scoped by
-- the engineering_audit_read policy (project_id is null or can_access_project).
grant select on engineering_audit to authenticated;

-- Do NOT revoke from service_role: the SECURITY DEFINER trigger executes as the
-- table owner, but the migration script and any future maintenance run as
-- service_role and must still be able to read it.

-- ⚠️ Also close the future hole: Supabase's default privileges would grant these
-- again on any table created later. Nothing to do for existing tables, but if you
-- add another append-only table, repeat the revoke above for it.

-- ---------------------------------------------------------------------------
-- Verify (expect: 42501 permission denied, NOT a silent 0-row success)
--
--   -- as an authenticated user, from the browser console:
--   await getSB().from('engineering_audit').delete().gt('id', 0);
--   await getSB().from('engineering_audit').insert({ table_name:'x',
--     record_id:'00000000-0000-0000-0000-000000000001', action:'INSERT' });
--
-- And confirm reads still work:
--   await getSB().from('engineering_activity').select('*').limit(5);
-- ---------------------------------------------------------------------------

-- Done.
