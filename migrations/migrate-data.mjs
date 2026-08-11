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
//   Required environment variables — a key that BYPASSES RLS on each side, so it
//   can read every project's rows:
//     SRC_URL   SRC_SERVICE_KEY     (planning app: bgupuqnkqhixpuctyder)
//     DST_URL   DST_SERVICE_KEY     (engineering app: zkxzaijznutmiueeurbb)
//
//   ⚠️ USE THE NEW-STYLE SECRET KEY: `sb_secret_…`, from
//   Settings → API Keys → Secret keys. BOTH Megawide projects have "Legacy API
//   keys" DISABLED, so the old `service_role` JWT (eyJ…) is rejected outright
//   with "Legacy API keys are disabled" — it is not a permissions problem and no
//   amount of re-copying that JWT will fix it. The `sb_publishable_…` key is the
//   wrong one too: it cannot bypass RLS, so it "succeeds" while copying nothing.
//
//   Check both before importing:  node migrate-data.mjs --preflight
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
const PREFLIGHT = args.includes('--preflight');
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

// Bucket → the table whose rows point into it. The table is used to cross-check
// "0 objects": that is only good news if no row references a file. See
// reportOrphanRefs().
const BUCKETS = ['drawing-register', 'material-submittal'];
const BUCKET_TABLE = {
  'drawing-register':   'drawing_register',
  'material-submittal': 'material_submittal',
};

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

// "0 objects" is ambiguous and the two meanings matter very differently:
//   • nothing was ever uploaded            → fine, nothing to migrate
//   • the listing missed them / wrong name → every attachment is about to be
//                                            silently left behind
// The rows themselves settle it: if any source row has a file_url, there MUST be
// objects. Called on both dry and real runs so the discrepancy cannot slip past.
async function reportFileRefs(bucket, objectCount) {
  const table = BUCKET_TABLE[bucket];
  if (!table) return;
  const { count, error } = await src.from(table)
    .select('*', { count: 'exact', head: true })
    .not('file_url', 'is', null);
  if (error) { console.log(`      (could not count file_url refs: ${error.message})`); return; }

  if (!count && !objectCount) {
    console.log(`      ✓ consistent: no row references a file, and none exist`);
  } else if (count && !objectCount) {
    console.log(`      ✗ ${count} row(s) have file_url set but the bucket lists 0 objects.`);
    console.log(`        Those attachments would be LOST. Check the bucket name and`);
    console.log(`        that the source key can read storage before importing.`);
  } else if (!count && objectCount) {
    console.log(`      ⚠️ ${objectCount} object(s) exist but no row references one`);
    console.log(`         (orphans — harmless, they will be copied anyway)`);
  } else {
    console.log(`      ${count} row(s) reference a file; ${objectCount} object(s) present`);
  }
}

async function copyBucket(bucket) {
  const paths = await listAllObjects(bucket);
  console.log(`  ${bucket}: ${paths.length} object(s)`);
  await reportFileRefs(bucket, paths.length);
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

// Tests BOTH connections independently and reports which side is misconfigured,
// without copying anything. Added because a bad key surfaced as a bare
// "FAILED: users: Invalid API key" that did not say WHICH project rejected it —
// and with two URLs and two keys in play, that is the first thing you need.
//
// Never prints key material: only a length and a format classification, which is
// enough to tell a service_role key from an anon key pasted by mistake.
async function preflight() {
  const shape = (k) => {
    if (!k) return 'unset';
    if (/^sb_secret_/.test(k))      return 'sb_secret_… (new-style secret — OK)';
    if (/^sb_publishable_/.test(k)) return 'sb_publishable_… ⚠️ PUBLISHABLE, NOT service_role';
    // ⚠️ A legacy JWT is NOT automatically usable. Both Megawide projects have
    // "Legacy API keys" DISABLED, so even a correct service_role JWT is rejected
    // with "Legacy API keys are disabled". Treat it as a failure and say why —
    // the fix is a new-style sb_secret_ key, not a different JWT.
    if (/^eyJ/.test(k)) {
      let role = 'unreadable';
      try { role = JSON.parse(Buffer.from(k.split('.')[1], 'base64').toString()).role; } catch {}
      return `legacy JWT (role="${role}") ⚠️ LEGACY KEYS ARE DISABLED on these ` +
             `projects — use the sb_secret_… key from Settings → API Keys → Secret keys`;
    }
    return 'unrecognised format';
  };

  const sides = [
    { label: 'SOURCE      (planning app)', client: src, url: process.env.SRC_URL, key: process.env.SRC_SERVICE_KEY },
    { label: 'DESTINATION (engineering)',  client: dst, url: process.env.DST_URL, key: process.env.DST_SERVICE_KEY },
  ];

  let bad = 0;

  // ⚠️ THE SAME KEY IN BOTH FIELDS IS THE DANGEROUS MISTAKE. If SRC and DST both
  // authenticate against the same project, a real run copies that project's
  // tables over themselves — or, with the URLs the other way round, writes the
  // empty destination over the live source. Two legacy JWTs are the same length
  // regardless of project, so this cannot be spotted by eye. Fail hard.
  if (process.env.SRC_SERVICE_KEY && process.env.SRC_SERVICE_KEY === process.env.DST_SERVICE_KEY) {
    console.log('✗ SRC_SERVICE_KEY and DST_SERVICE_KEY are IDENTICAL.\n');
    console.log('  Each key must come from its own project. With one key in both');
    console.log('  fields the import would read and write the same database —');
    console.log('  potentially overwriting live Planning App data with empty tables.\n');
    process.exitCode = 1;
    return;
  }

  // For legacy JWTs the payload carries the project ref, so a key/URL mismatch
  // (right key, wrong side) can be caught before any data moves. sb_secret_ keys
  // are opaque, so this check simply does not apply to them.
  const refOf = (k) => {
    if (!k || !/^eyJ/.test(k)) return null;
    try { return JSON.parse(Buffer.from(k.split('.')[1], 'base64').toString()).ref || null; }
    catch { return null; }
  };
  for (const s of sides) {
    const ref = refOf(s.key);
    const urlRef = (s.url || '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
    if (ref && urlRef && ref !== urlRef) {
      console.log(`✗ ${s.label}: key belongs to project "${ref}" but the URL points at "${urlRef}".`);
      console.log('  SRC and DST are almost certainly swapped.\n');
      bad++;
    }
  }

  for (const s of sides) {
    const desc = s.key ? s.key.length + ' chars, ' + shape(s.key) : 'UNSET';
    console.log(`${s.label}`);
    console.log(`  url:  ${s.url}`);
    console.log(`  key:  ${desc}`);

    // A wrong-privilege key must FAIL preflight even if the read technically
    // succeeds. An anon/publishable key returns 200 with 0 rows (RLS filtered
    // everything out), which would otherwise print a reassuring ✓ and then
    // silently "migrate" nothing at all — the worst possible outcome here.
    if (!s.key || /⚠️|unset|unrecognised/.test(desc)) {
      console.log(`  read: ✗ skipped — key is not a service_role key\n`);
      bad++;
      continue;
    }

    // `users` exists in both projects and is RLS-protected, so it only reads
    // back for a key that genuinely bypasses RLS.
    const { count, error } = await s.client.from('users').select('*', { count: 'exact', head: true });
    if (error) {
      // error.message is sometimes empty on an auth rejection; fall back to
      // whatever the client did give us rather than printing a bare "✗".
      const why = error.message || error.code || error.hint ||
                  JSON.stringify(error) || 'unknown error';
      console.log(`  read: ✗ ${why}\n`);
      bad++;
    } else if (!count) {
      // Reached the API but saw nothing. On the SOURCE that means the wrong
      // project or a key without real access — the planning app has users.
      console.log(`  read: ⚠️ connected, but users is EMPTY (0 rows).`);
      console.log(`        On the source that means the wrong project or a key`);
      console.log(`        that cannot bypass RLS. Expected on a fresh destination.\n`);
    } else {
      console.log(`  read: ✓ users readable (${count} rows) — RLS genuinely bypassed\n`);
    }
  }

  if (bad) {
    console.log(`${bad} side(s) failed. Fix those before running the import.`);
    process.exitCode = 1;
  } else {
    console.log('Both connections OK. Re-run with --dry-run to see what would be copied.');
  }
}

async function main() {
  console.log(`Engineering App data migration${DRY ? ' — DRY RUN (nothing is written)' : ''}`);
  console.log(`  source:      ${process.env.SRC_URL}`);
  console.log(`  destination: ${process.env.DST_URL}\n`);

  if (PREFLIGHT) { await preflight(); return; }
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

// ⚠️ process.exitCode, NOT process.exit(). process.exit() tears the process down
// while supabase-js still holds open keep-alive sockets, which trips a libuv
// assertion on Windows —
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94
// — printing a scary crash immediately after the real error message and making
// it look like the script itself blew up. Setting exitCode lets Node drain its
// handles and exit cleanly with the same status.
main().catch(e => {
  console.error('\nFAILED:', e.message);
  if (/Invalid API key|JWT|401|apikey/i.test(e.message)) {
    console.error(`
  That is an authentication failure, not a data problem. Check:

    • "Legacy API keys are disabled" means you used an old eyJ… JWT. BOTH
      Megawide projects are on the new key system. Use the SECRET key —
      Settings → API Keys → Secret keys → sb_secret_… — not the JWT, and not
      the sb_publishable_ key (which cannot bypass RLS).
    • Each key must belong to the project its URL points at. A valid key from
      the WRONG project also reports "Invalid API key".
        SRC_URL = ${process.env.SRC_URL || '(unset)'}
        DST_URL = ${process.env.DST_URL || '(unset)'}
    • Run with --preflight to test both connections without copying anything.`);
  }
  process.exitCode = 1;
});
