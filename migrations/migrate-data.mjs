// ============================================================================
// Engineering App — data migration: Planners Dashboard → Engineering App
// ----------------------------------------------------------------------------
// Copies the engineering data from the Planning App's Supabase project into the
// Engineering App's own project, PRESERVING ids, timestamps, revision history
// (the `submissions` jsonb) and uploaded files.
//
//   Usage (Node 18+). ⚠️ `npm i -g` does NOT work: Node does not resolve ESM
//   imports from the global npm root, so a global install still fails with
//   ERR_MODULE_NOT_FOUND. Install into a scratch folder and run the script from
//   THERE, so `node_modules` is found by walking up from the script's location:
//
//     mkdir eng-import && cd eng-import
//     npm init -y && npm pkg set type=module
//     npm i @supabase/supabase-js
//     cp /path/to/migrations/migrate-data.mjs .
//
//   This repo deliberately has no package.json — do not create one here just to
//   run this script.
//
//     node migrate-data.mjs --dry-run       # report only, writes nothing
//     node migrate-data.mjs                 # perform the copy
//     node migrate-data.mjs --only=projects,drawing_register
//     node migrate-data.mjs --skip-files    # rows only, no storage objects
//
//   Required environment variables — SERVICE ROLE keys, because this must
//   bypass RLS on both sides and read every project's rows:
//     SRC_URL   SRC_SERVICE_KEY     (planning app: bgupuqnkqhixpuctyder)
//     DST_URL   DST_SERVICE_KEY     (engineering app: zkxzaijznutmiueeurbb)
//
// ⚠️ NEVER commit a service_role key, and never put one in assets/js/config.js.
// Export them in the shell for the length of this run and then forget them.
//
// ============================================================================
// WHAT THIS SCRIPT DOES **NOT** DO — read before running
// ----------------------------------------------------------------------------
// It does not migrate USER ACCOUNTS. The two Supabase projects have separate
// `auth.users` tables and password hashes are not portable between projects, so
// every user must register once in the Engineering App and be approved by an
// Engineering App admin. This is a direct consequence of choosing a separate
// Supabase project.
//
// That creates a problem this script DOES solve. Every source row carries a
// `created_by` uuid pointing at a Planning App auth user that does not exist
// here — and `users.id` references `auth.users(id)` while
// `drawing_register.created_by` references `users(id)`, so those rows CANNOT be
// inserted as-is. They would be rejected by the foreign key.
//
// So: the original authors go into `legacy_users` (no auth FK, attribution
// only), and each migrated row lands with `created_by = null` plus
// `legacy_created_by` = the original uuid. Ownership stays answerable
// ("originally created by Juan Dela Cruz"), and `--relink-users` fills in the
// real `created_by` once that person registers here, matched by email.
//
// ⚠️ REQUIRES migration 0003-legacy-ownership.sql to have been applied — it
// creates legacy_users, adds legacy_created_by, and widens the update policy so
// planners (not just admins) can edit migrated rows. Without 0003 this script
// fails fast, and migrated history would be admin-only-editable.
//
// ⚠️ RUN ORDER — apply 0002 (the audit trail) LAST, AFTER this script:
//
//     0001-engineering-core.sql
//     0003-legacy-ownership.sql
//     node migrate-data.mjs                 ← bulk import happens here
//     0002-engineering-audit-and-approval.sql
//
// Reason: 0002 puts an audit trigger on both module tables. This script writes
// with the service_role key, where `auth.uid()` is NULL — so importing a 1,500
// drawing register with 0002 already applied would insert 1,500 audit entries
// attributed to "(deleted user)", burying the real change history under
// synthetic noise on day one. The migration is not an edit anyone made; it is
// the starting state. Applying 0002 afterwards means the audit trail begins at
// the cutover, which is what an auditor actually wants.
//
// If 0002 IS already applied and you must re-import, disable the triggers for
// the duration instead (as the postgres/service role, in the SQL editor):
//     alter table drawing_register   disable trigger audit_drawing_register;
//     alter table material_submittal disable trigger audit_material_submittal;
//   …run this script…
//     alter table drawing_register   enable  trigger audit_drawing_register;
//     alter table material_submittal enable  trigger audit_material_submittal;
//
//   Order matters (foreign keys): workspaces → projects → module tables.
// ============================================================================

import { createClient } from '@supabase/supabase-js';

const args     = process.argv.slice(2);
const DRY      = args.includes('--dry-run');
const SKIPFILE = args.includes('--skip-files');
const RELINK   = args.includes('--relink-users');
const onlyArg  = args.find(a => a.startsWith('--only='));
const ONLY     = onlyArg ? onlyArg.split('=')[1].split(',').map(s => s.trim()) : null;

const need = n => {
  const v = process.env[n];
  if (!v) { console.error(`Missing environment variable ${n}`); process.exit(1); }
  return v;
};

const src = createClient(need('SRC_URL'), need('SRC_SERVICE_KEY'), { auth: { persistSession: false } });
const dst = createClient(need('DST_URL'), need('DST_SERVICE_KEY'), { auth: { persistSession: false } });

// Tables in dependency order. `key` is the conflict target for the upsert, so a
// re-run updates rather than duplicating — the whole script is idempotent and
// safe to run repeatedly (e.g. a second pass to pick up late edits before cutover).
// `users` is NOT here — see the header. Source profiles go to `legacy_users`
// via copyLegacyUsers(), and module rows are rewritten by reownRows().
const TABLES = [
  { name: 'workspaces',         key: 'id' },
  { name: 'projects',           key: 'id' },
  { name: 'drawing_register',   key: 'id', reown: true },
  { name: 'material_submittal', key: 'id', reown: true },
];

const BUCKETS = ['drawing-register', 'material-submittal'];

const PAGE = 500;

// ---------------------------------------------------------------------------
// Paged read. Ordered by id and using a keyset cursor rather than .range(),
// because PostgREST caps a plain select at 1000 rows and an offset-based scan
// can skip or repeat rows if anything is written mid-migration.
// ---------------------------------------------------------------------------
async function readAll(client, table) {
  const out = [];
  let last = null;
  for (;;) {
    let q = client.from(table).select('*').order('id').limit(PAGE);
    if (last !== null) q = q.gt('id', last);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data.length) break;
    out.push(...data);
    last = data[data.length - 1].id;
    if (data.length < PAGE) break;
  }
  return out;
}

// Move the original creator out of `created_by` (which has an FK to a user that
// does not exist here) into `legacy_created_by` (which has none). Done in memory
// before the upsert, so the FK is never violated.
function reownRows(rows) {
  let moved = 0;
  for (const r of rows) {
    if (r.created_by) { r.legacy_created_by = r.created_by; r.created_by = null; moved++; }
  }
  return moved;
}

async function copyTable({ name, key, reown }) {
  if (ONLY && !ONLY.includes(name)) { console.log(`  ${name}: skipped (--only)`); return; }
  const rows = await readAll(src, name);
  console.log(`  ${name}: ${rows.length} row(s) in source`);
  if (reown && rows.length) {
    const moved = reownRows(rows);
    console.log(`  ${name}: ${moved} row(s) re-attributed to legacy_created_by`);
  }
  if (!rows.length || DRY) return;

  // Chunked upsert. 200 keeps each request comfortably under the payload limit
  // even for drawing_register rows carrying a long `submissions` array.
  let done = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await dst.from(name).upsert(chunk, { onConflict: key });
    if (error) throw new Error(`${name} upsert @${i}: ${error.message}`);
    done += chunk.length;
    process.stdout.write(`\r  ${name}: wrote ${done}/${rows.length}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Storage. Objects are copied by download → upload; there is no server-side
// cross-project copy. Buckets are private in both projects, so the service key
// is what makes the download possible.
// ---------------------------------------------------------------------------
async function listAllObjects(bucket, prefix = '') {
  const found = [];
  const { data, error } = await src.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
  for (const entry of data) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    // A folder entry has no id/metadata — recurse into it. Files are stored as
    // <project_id>/<timestamp>_<name>, so there is exactly one level, but
    // recursing keeps this correct if that ever changes.
    if (entry.id === null) found.push(...await listAllObjects(bucket, path));
    else found.push(path);
  }
  return found;
}

async function copyBucket(bucket) {
  const paths = await listAllObjects(bucket);
  console.log(`  ${bucket}: ${paths.length} object(s)`);
  if (!paths.length || DRY) return;

  let ok = 0, failed = [];
  for (const path of paths) {
    const dl = await src.storage.from(bucket).download(path);
    if (dl.error) { failed.push([path, dl.error.message]); continue; }
    const buf = Buffer.from(await dl.data.arrayBuffer());
    const up = await dst.storage.from(bucket).upload(path, buf, {
      // upsert so a re-run overwrites rather than erroring on a partial run.
      upsert: true,
      contentType: dl.data.type || 'application/octet-stream',
    });
    if (up.error) failed.push([path, up.error.message]);
    else ok++;
    process.stdout.write(`\r  ${bucket}: copied ${ok}/${paths.length}`);
  }
  console.log('');
  if (failed.length) {
    // Reported, not thrown: a missing object should not abort the whole run, but
    // it MUST be visible — a row pointing at an object that never arrived shows
    // the user a broken download link with no other symptom.
    console.log(`  ⚠️ ${bucket}: ${failed.length} object(s) FAILED:`);
    failed.slice(0, 20).forEach(([p, m]) => console.log(`      ${p} — ${m}`));
    if (failed.length > 20) console.log(`      …and ${failed.length - 20} more`);
  }
}

// ---------------------------------------------------------------------------
// --relink-users: after people have registered in the Engineering App, point
// their historical rows at their NEW auth uuid, matched on email.
//
// Run this as often as needed — it only touches rows whose created_by still
// holds an old id, so re-running after each batch of approvals is safe.
// ---------------------------------------------------------------------------
async function copyLegacyUsers() {
  const rows = await readAll(src, 'users');
  console.log(`  legacy_users: ${rows.length} source profile(s)`);
  if (!rows.length || DRY) return;
  const payload = rows.map(u => ({
    id: u.id, name: u.name, email: u.email,
    role: u.role, status: u.status, projects: u.projects || [],
    source_app: 'planners-dashboard',
  }));
  const { error } = await dst.from('legacy_users').upsert(payload, { onConflict: 'id' });
  if (error) {
    if (/legacy_users/.test(error.message) && /does not exist|schema cache/i.test(error.message)) {
      throw new Error('legacy_users is missing — apply migrations/0003-legacy-ownership.sql first.');
    }
    throw new Error(`legacy_users: ${error.message}`);
  }
  console.log(`  legacy_users: wrote ${payload.length}`);
}

// Attach historical rows to real accounts, matched on email. Only rows still
// unowned (created_by is null) are touched, so this is safe to re-run after each
// batch of approvals and can never steal a row someone legitimately created here.
async function relinkUsers() {
  const legacy = await readAll(dst, 'legacy_users');
  if (!legacy.length) {
    console.log('  legacy_users is empty — run the migration without --relink-users first.');
    return;
  }
  const { data: authList, error } = await dst.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(`listUsers: ${error.message}`);

  // Only people who have actually been APPROVED should take ownership; a pending
  // registration must not gain edit rights over historical records early.
  const profiles = await readAll(dst, 'users');
  const approved = new Map(profiles.filter(p => p.status === 'approved').map(p => [p.id, p]));
  const newByEmail = new Map(
    authList.users
      .filter(u => approved.has(u.id))
      .map(u => [(u.email || '').toLowerCase(), u.id])
  );

  const remap = legacy
    .map(l => ({ legacy: l, newId: newByEmail.get((l.email || '').toLowerCase()) }))
    .filter(x => x.newId && x.newId !== x.legacy.id);

  console.log(`  ${remap.length} of ${legacy.length} legacy user(s) now have an approved account here`);
  if (DRY) {
    remap.forEach(r => console.log(`    ${r.legacy.email}: ${r.legacy.id} → ${r.newId}`));
    return;
  }

  for (const r of remap) {
    for (const t of ['drawing_register', 'material_submittal']) {
      const { error: e1, count } = await dst.from(t)
        .update({ created_by: r.newId }, { count: 'exact' })
        .eq('legacy_created_by', r.legacy.id)
        .is('created_by', null);
      if (e1) throw new Error(`relink ${t} ${r.legacy.email}: ${e1.message}`);
      console.log(`    ${r.legacy.email}: ${t} ${count ?? 0} row(s)`);
    }
    await dst.from('legacy_users').update({ relinked_to: r.newId }).eq('id', r.legacy.id);
  }

  // Report what is still unattributed, so it is never silently forgotten.
  for (const t of ['drawing_register', 'material_submittal']) {
    const { count } = await dst.from(t)
      .select('*', { count: 'exact', head: true })
      .is('created_by', null);
    if (count) console.log(`  ${t}: ${count} row(s) still awaiting their author's registration`);
  }
}

// ---------------------------------------------------------------------------
async function verify() {
  console.log('\nVerification (source → destination row counts):');
  for (const { name } of TABLES) {
    const a = await src.from(name).select('*', { count: 'exact', head: true });
    const b = await dst.from(name).select('*', { count: 'exact', head: true });
    const sc = a.count ?? '?', dc = b.count ?? '?';
    const flag = sc === dc ? 'OK' : (DRY ? '(dry run)' : '⚠️ MISMATCH');
    console.log(`  ${name.padEnd(20)} ${String(sc).padStart(6)} → ${String(dc).padStart(6)}  ${flag}`);
  }
}

async function main() {
  console.log(`Engineering App data migration${DRY ? ' — DRY RUN (nothing is written)' : ''}`);
  console.log(`  source:      ${process.env.SRC_URL}`);
  console.log(`  destination: ${process.env.DST_URL}\n`);

  if (RELINK) { console.log('Relinking users by email:'); await relinkUsers(); return; }

  console.log('Legacy attribution:');
  await copyLegacyUsers();

  console.log('\nTables:');
  for (const t of TABLES) await copyTable(t);

  if (!SKIPFILE) {
    console.log('\nStorage objects:');
    for (const b of BUCKETS) await copyBucket(b);
  } else {
    console.log('\nStorage: skipped (--skip-files)');
  }

  await verify();

  console.log(`
Next steps:
  1. Ask each engineering user to register at the Engineering App and approve
     them in Administration (role must match what they had in the Planning App).
  2. Re-run with --relink-users to attach their historical records to their new
     account. Safe to run repeatedly as more people are approved.
  3. Spot-check a drawing and a submittal, including opening an attached file.
  4. Only then remove the Planning App's module.js/module.css leftovers.
`);
}

main().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
