// Edge Function: sync-projects — Planners Dashboard → Engineering App
// -----------------------------------------------------------------------------
// Replaces the GitHub Action as the thing that moves projects + group heads, so
// the sync can be triggered from INSIDE this app (Admin → Projects → "Sync now")
// instead of from the Actions tab on github.com.
//
// Deliberately modelled on planning-app's `sync-wpm`, which already solves this
// exact shape (in-app button → Edge Function → cross-project service-key read →
// upsert). Same auth model, same key-format guard, same CORS. One pattern for
// cross-app data in this org, not two.
//
// SECURITY MODEL
//  - Reads the Planners Dashboard with ITS service key (SRC_SERVICE_KEY), held
//    only as an Edge Function secret — never shipped to the browser. This app is
//    a static GitHub Pages site, so anything it ships is public; that is the
//    whole reason this is a function and not browser JS.
//  - Writes here with THIS project's service key, bypassing RLS — and with it
//    the 0009 read-only guarantee. That is intended: this function IS the
//    sanctioned writer 0009 carves out for.
//  - Callers must be an approved admin / super_admin (JWT verified), OR the
//    invocation presents this project's service key (for the scheduled run).
//
// DEPLOY (from engineering-app/):
//   supabase functions deploy sync-projects --project-ref zkxzaijznutmiueeurbb
//   supabase secrets set \
//     SRC_URL=https://bgupuqnkqhixpuctyder.supabase.co \
//     SRC_SERVICE_KEY=<Planners sb_secret_ key> \
//     ENG_SERVICE_KEY=<this project's sb_secret_ key> \
//     --project-ref zkxzaijznutmiueeurbb
//
// The SRC_* names match the GitHub Action's variables, so the same values carry
// over — see .github/workflows/sync-projects.yml, which this supersedes.
//
// ⚠️⚠️ THE `TABLES` LIST IS THE ENTIRE BOUNDARY BETWEEN THE TWO APPS ⚠️⚠️
// Hardcoded to group_heads + projects and deliberately NOT a parameter.
// migrate-data.mjs can also copy drawing_register and material_submittal, which
// is right for a one-off cutover and catastrophic here: it would overwrite this
// app's LIVE register with a stale Planners snapshot and destroy every change
// made since cutover. The workflow guarded that with a `--only=` flag someone
// could edit; this guards it by making the wider set unreachable from the API.
// Do not add a `tables` input.
//
// ORDER MATTERS: group_heads first — projects.group_head_id is an FK into it, so
// syncing projects against a stale group_heads fails on any project tagged with
// a group head created since the last run.
// -----------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---- The boundary. Read the banner above before touching this. -------------
const TABLES = [
  { name: "group_heads", key: "id" },
  { name: "projects",    key: "id" },
];

// Columns intentionally absent from THIS database: the Engineering App has no
// Project Schedule module, so 0001 omits the rollup caches that module writes.
// Ported verbatim from migrations/migrate-data.mjs.
const EXPECTED_DROPS: Record<string, string[]> = {
  projects: ["schedule_progress", "schedule_start", "schedule_finish",
             "schedule_activities", "schedule_updated_at"],
};

// Tables here that reference a project. A project with rows in any of them holds
// real engineering work and is never auto-pruned.
const ENGINEERING_DATA_TABLES = ["drawing_register", "material_submittal"];

const MISSING_COL_RE = /Could not find the '([^']+)' column/;
const PAGE = 500, CHUNK = 200;

// Paged read, keyset-cursored on id. PostgREST caps a plain select at 1000 rows,
// and an offset scan can skip or repeat rows if anything is written mid-run.
async function readAll(client: any, table: string) {
  const out: any[] = [];
  let last: any = null;
  for (;;) {
    let q = client.from(table).select("*").order("id").limit(PAGE);
    if (last !== null) q = q.gt("id", last);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data.length) break;
    out.push(...data);
    last = data[data.length - 1].id;
    if (data.length < PAGE) break;
  }
  return out;
}

// COLUMN PROJECTION — attempt the write, learn from the failure, retry.
// The two schemas are deliberately not identical, and this project's OpenAPI
// document returns no column definitions, so the schema cannot be introspected
// up front. PostgREST names the offending column in its error, so the database
// stays the source of truth.
// ⚠️ A column is dropped ONLY if declared in EXPECTED_DROPS. Anything else
// aborts — on a module table a silent drop would be lost engineering data.
async function upsertChunk(dst: any, table: string, chunk: any[], key: string, dropped: Set<string>) {
  for (let attempt = 0; attempt <= 12; attempt++) {
    for (const c of dropped) for (const r of chunk) delete r[c];
    const { error } = await dst.from(table).upsert(chunk, { onConflict: key });
    if (!error) return;

    const m = MISSING_COL_RE.exec(error.message || "");
    if (!m) throw new Error(`${table} upsert: ${error.message}`);
    const col = m[1];
    if (!(EXPECTED_DROPS[table] || []).includes(col)) {
      throw new Error(
        `${table}: the source has a column this database does not: "${col}". ` +
        `Refusing to drop it silently. Either add the column here, or add it to ` +
        `EXPECTED_DROPS in this function if the omission is deliberate.`);
    }
    dropped.add(col);
  }
  throw new Error(`${table}: too many missing columns; aborting rather than looping`);
}

// PRUNE — remove projects that no longer exist upstream.
// Opt-in and narrow ON PURPOSE. An upsert is recoverable by re-running it; a
// delete is not, and this function holds a key that bypasses every RLS policy.
// So: default is REPORT ONLY, and even with prune a project is deleted only if
// it holds NO rows in any table here. One with drawings or submittals is
// reported as blocked and left alone — that is engineering work whose upstream
// project vanishing is a situation for a human, not a scheduled job.
async function findOrphans(dst: any, srcProjectIds: Set<string>) {
  const here = await readAll(dst, "projects");
  const orphans: any[] = [];
  for (const p of here) {
    if (srcProjectIds.has(p.id)) continue;
    const holds: Record<string, number> = {};
    for (const t of ENGINEERING_DATA_TABLES) {
      const { count, error } = await dst.from(t)
        .select("id", { count: "exact", head: true }).eq("project_id", p.id);
      if (error) throw new Error(`${t} orphan check: ${error.message}`);
      if (count) holds[t] = count;
    }
    orphans.push({ id: p.id, name: p.name, status: p.status, holds,
                   removable: Object.keys(holds).length === 0 });
  }
  return orphans;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const ENG_URL = Deno.env.get("SUPABASE_URL")!;
    // ⚠️ This project runs on the NEW API-key format, so the auto-injected
    // legacy SUPABASE_SERVICE_ROLE_KEY is NOT honored — it silently degrades to
    // `anon`, and every write fails or returns a misleading permission error.
    // sync-wpm learned this the hard way; guard and report what we actually hold
    // rather than falling back and failing obscurely.
    const ENG_SERVICE = Deno.env.get("ENG_SERVICE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const SRC_URL = Deno.env.get("SRC_URL");
    const SRC_SERVICE = Deno.env.get("SRC_SERVICE_KEY");
    if (!SRC_URL || !SRC_SERVICE) return json({ error: "SRC_URL / SRC_SERVICE_KEY not configured" }, 500);

    const kind = (k?: string) => k?.startsWith("sb_secret_") ? "new" : k?.startsWith("ey") ? "legacy-jwt" : "unknown";
    if (kind(ENG_SERVICE) !== "new") return json({
      error: "ENG_SERVICE_KEY must be this project's new sb_secret_ key",
      eng_key_kind: kind(ENG_SERVICE), has_ENG_SERVICE_KEY: !!Deno.env.get("ENG_SERVICE_KEY"),
    }, 500);

    const dst = createClient(ENG_URL, ENG_SERVICE, { auth: { persistSession: false } });

    // ---- Authorize the caller ----------------------------------------------
    const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!auth) return json({ error: "Missing Authorization" }, 401);

    let caller = "scheduled";
    let allowed = auth === ENG_SERVICE; // service-key / cron invocation
    if (!allowed) {
      // The platform (verify_jwt=true) already validated the signature, so `sub`
      // can be trusted — decode directly rather than calling GoTrue, which trips
      // over disabled legacy keys.
      let uid: string | null = null;
      try {
        const seg = auth.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        uid = JSON.parse(atob(seg))?.sub || null;
      } catch { uid = null; }
      if (!uid) return json({ error: "Could not read user id from token" }, 401);

      const { data: prof, error: pErr } = await dst.from("users")
        .select("email,role,status").eq("id", uid).maybeSingle();
      // Admin only: 0009 makes the Planners Dashboard the owner of projects, so
      // pulling them across is an administrative act, not a planning one.
      allowed = !!prof && prof.status === "approved" &&
        ["super_admin", "admin"].includes(prof.role);
      if (!allowed) return json({
        error: "Requires an approved admin", uid, profile_found: !!prof,
        role: prof?.role ?? null, status: prof?.status ?? null,
        lookup_error: pErr?.message ?? null,
      }, 403);
      caller = prof!.email || uid;
    }

    const body = await req.json().catch(() => ({} as any));
    const dryRun = body?.dry_run === true;
    const prune  = body?.prune === true;

    const src = createClient(SRC_URL, SRC_SERVICE, { auth: { persistSession: false } });
    const started = Date.now();
    const report: any = { ok: true, caller, dry_run: dryRun, tables: {}, pruned: [] };

    // ---- Copy ---------------------------------------------------------------
    let srcProjectIds = new Set<string>();
    for (const { name, key } of TABLES) {
      const rows = await readAll(src, name);
      if (name === "projects") srcProjectIds = new Set(rows.map((r: any) => r.id));
      report.tables[name] = { source_rows: rows.length, written: 0, dropped_columns: [] as string[] };
      if (!rows.length || dryRun) continue;

      const dropped = new Set<string>();
      for (let i = 0; i < rows.length; i += CHUNK) {
        await upsertChunk(dst, name, rows.slice(i, i + CHUNK), key, dropped);
        report.tables[name].written += Math.min(CHUNK, rows.length - i);
      }
      report.tables[name].dropped_columns = [...dropped];
    }

    // ---- Reconcile ----------------------------------------------------------
    report.orphans = await findOrphans(dst, srcProjectIds);
    if (prune && !dryRun) {
      for (const o of report.orphans.filter((o: any) => o.removable)) {
        const { error } = await dst.from("projects").delete().eq("id", o.id);
        if (error) throw new Error(`prune ${o.id}: ${error.message}`);
        report.pruned.push(o.id);
      }
    }
    report.blocked_orphans = report.orphans.filter((o: any) => !o.removable).map((o: any) => o.id);
    report.duration_ms = Date.now() - started;
    return json(report);

  } catch (e) {
    // Fail loudly with the real message. The workflow's own notes warn against
    // asserting a cause — its first version blamed an expired key when the fault
    // was a Node version. Report what happened; let the reader diagnose.
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
