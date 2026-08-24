// Edge Function: send-mail — issue a top sheet (MAS / RFA / RFI) by email
// -----------------------------------------------------------------------------
// The app is a static GitHub Pages site, so it can hold no secret: a mail
// credential shipped to the browser is a published credential. Sending therefore
// happens here, and this function is deliberately the SAME SHAPE as
// `sync-projects` — same CORS block, same JWT-decode-then-look-up-the-profile
// authorisation, same "report what we actually hold" key guard. One pattern for
// privileged server work in this org, not three.
//
// Transport is Microsoft Graph with the client-credentials (app-only) flow, so
// mail leaves from the real megawide.com.ph tenant and lands in the sender's own
// Sent Items — which is what makes an issued RFA traceable afterwards.
//
// DEPLOY (from engineering-app/):
//   supabase functions deploy send-mail --project-ref zkxzaijznutmiueeurbb
//   supabase secrets set \
//     MS_TENANT_ID=<directory (tenant) id> \
//     MS_CLIENT_ID=<application (client) id> \
//     MS_CLIENT_SECRET=<client secret VALUE, not the secret id> \
//     ENG_SERVICE_KEY=<this project's sb_secret_ key> \
//     --project-ref zkxzaijznutmiueeurbb
//
// AZURE SETUP (IT does this once — the app cannot self-provision it)
//   1. App registration → API permissions → Microsoft Graph → APPLICATION
//      permission `Mail.Send` → Grant admin consent.
//   2. ⚠️⚠️ THEN RESTRICT IT. Application `Mail.Send` grants send-as-ANY-mailbox
//      in the tenant. Untouched, this function's credential could send mail as
//      the CEO. Exchange Online must scope it to a mail-enabled security group:
//        New-ApplicationAccessPolicy -AppId <client id> `
//          -PolicyScopeGroupId eng-app-senders@megawide.com.ph `
//          -AccessRight RestrictAccess -Description "Engineering App top sheets"
//      Until that policy exists, treat this function as over-privileged.
//   3. This code's own half of that guarantee is below: THE SENDER IS TAKEN FROM
//      THE VERIFIED CALLER'S PROFILE, NEVER FROM THE REQUEST BODY. A caller
//      cannot ask to send as somebody else, whatever they post.
//
// WHY NOT SMTP / Resend: chosen with the user. Graph sends as the actual person,
// keeps a copy in their mailbox, and needs no new domain or DNS record.
// -----------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const GRAPH = "https://graph.microsoft.com/v1.0";

// ⚠️ Graph's simple sendMail carries attachments INLINE in the request, and the
// whole request is capped at 4MB — call it 3MB of payload once base64 (+33%) and
// the JSON envelope are counted. A merged top sheet plus a consultant's drawing
// set goes past that routinely, so anything larger goes the draft + upload-session
// route instead. Both paths exist because the small one is a single round trip and
// is what most MAS sheets need.
const INLINE_LIMIT = 3 * 1024 * 1024;
// Graph's own ceiling for an upload session is 150MB; well past anything sane to
// email, and a mailbox will usually refuse long before. Bounded so a mistake
// fails here rather than after a long upload.
const MAX_TOTAL = 30 * 1024 * 1024;
const UPLOAD_SLICE = 4 * 1024 * 1024;   // must be a multiple of 320KB
const MAX_RECIPIENTS = 50;

// A hostile or fat-fingered address list should fail before any mail moves.
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function addrs(list: unknown, label: string): { emailAddress: { address: string } }[] {
  if (list == null || list === "") return [];
  const arr = (Array.isArray(list) ? list : String(list).split(/[,;]/))
    .map((s) => String(s).trim()).filter(Boolean);
  for (const a of arr) {
    if (!EMAIL_RE.test(a)) throw new Error(`${label}: "${a}" is not a valid email address`);
  }
  return arr.map((a) => ({ emailAddress: { address: a } }));
}

// base64 length → decoded byte length, without decoding it.
function b64Bytes(b64: string): number {
  const s = b64.replace(/=+$/, "");
  return Math.floor((s.length * 3) / 4);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function graphToken(tenant: string, clientId: string, secret: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: secret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    // Surfaced verbatim: AADSTS codes are the only useful diagnostic here, and
    // hiding them turns "consent was never granted" into "sending failed".
    throw new Error(`Microsoft token request failed (${r.status}): ${j.error_description || j.error || "no token"}`);
  }
  return j.access_token as string;
}

async function graph(token: string, method: string, path: string, body?: unknown, raw?: Uint8Array, extra?: Record<string, string>) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(extra || {}) };
  let payload: BodyInit | undefined;
  if (raw) payload = raw;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, { method, headers, body: payload });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* 202/204 bodies are empty */ }
  if (!r.ok) {
    const msg = parsed?.error?.message || text || `HTTP ${r.status}`;
    throw new Error(`Graph ${method} ${path.replace(GRAPH, "")} failed (${r.status}): ${msg}`);
  }
  return parsed;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const ENG_URL = Deno.env.get("SUPABASE_URL")!;
    // ⚠️ Same trap as sync-projects: this project is on the new API-key format, so
    // the auto-injected legacy SUPABASE_SERVICE_ROLE_KEY silently degrades to
    // `anon` and the profile lookup below would come back empty — which would read
    // as "you are not authorised" rather than "the function is misconfigured".
    const ENG_SERVICE = Deno.env.get("ENG_SERVICE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const kind = (k?: string) => k?.startsWith("sb_secret_") ? "new" : k?.startsWith("ey") ? "legacy-jwt" : "unknown";
    if (kind(ENG_SERVICE) !== "new") {
      return json({
        error: "ENG_SERVICE_KEY must be this project's new sb_secret_ key",
        eng_key_kind: kind(ENG_SERVICE), has_ENG_SERVICE_KEY: !!Deno.env.get("ENG_SERVICE_KEY"),
      }, 500);
    }

    const TENANT = Deno.env.get("MS_TENANT_ID");
    const CLIENT = Deno.env.get("MS_CLIENT_ID");
    const SECRET = Deno.env.get("MS_CLIENT_SECRET");
    if (!TENANT || !CLIENT || !SECRET) {
      // Names the missing pieces. "Mail is not configured" with no detail is the
      // kind of error someone spends an afternoon on.
      return json({
        error: "Microsoft Graph is not configured on this function",
        missing: { MS_TENANT_ID: !TENANT, MS_CLIENT_ID: !CLIENT, MS_CLIENT_SECRET: !SECRET },
        hint: "supabase secrets set MS_TENANT_ID=… MS_CLIENT_ID=… MS_CLIENT_SECRET=… — see the header of this function",
      }, 503);
    }

    const db = createClient(ENG_URL, ENG_SERVICE, { auth: { persistSession: false } });

    // ---- Authorize the caller, and decide who the mail is FROM ---------------
    const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!auth) return json({ error: "Missing Authorization" }, 401);

    let uid: string | null = null;
    try {
      const seg = auth.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      uid = JSON.parse(atob(seg))?.sub || null;
    } catch { uid = null; }
    if (!uid) return json({ error: "Could not read user id from token" }, 401);

    const { data: prof, error: pErr } = await db.from("users")
      .select("email,name,role,status").eq("id", uid).maybeSingle();

    // Issuing a top sheet to a client or consultant is an outward, on-the-record
    // act, so it takes the same roles that may write the registers the sheet is
    // generated from — not merely a signed-in reader.
    const allowed = !!prof && prof.status === "approved" &&
      ["super_admin", "admin", "planner"].includes(prof.role);
    if (!allowed) {
      return json({
        error: "Requires an approved planner, admin or super_admin", uid,
        profile_found: !!prof, role: prof?.role ?? null, status: prof?.status ?? null,
        lookup_error: pErr?.message ?? null,
      }, 403);
    }

    // ⚠️⚠️ THE SENDER. Taken from the profile the JWT resolves to — never from the
    // request body. This is the guard that keeps an application-wide Mail.Send
    // permission from becoming "send as anybody": a caller can choose recipients,
    // but they cannot choose whose mailbox the message leaves from.
    const sender = String(prof!.email || "").trim();
    if (!EMAIL_RE.test(sender)) {
      return json({ error: "Your profile has no valid email address, so mail cannot be sent as you", sender }, 400);
    }

    const body = await req.json().catch(() => ({} as any));
    const dryRun = body?.dry_run === true;

    let to, cc, bcc;
    try {
      to  = addrs(body?.to, "to");
      cc  = addrs(body?.cc, "cc");
      bcc = addrs(body?.bcc, "bcc");
    } catch (e) { return json({ error: String((e as Error).message) }, 400); }

    if (!to.length) return json({ error: "At least one 'to' recipient is required" }, 400);
    const nRcpt = to.length + cc.length + bcc.length;
    if (nRcpt > MAX_RECIPIENTS) {
      return json({ error: `Too many recipients (${nRcpt}); the limit is ${MAX_RECIPIENTS}` }, 400);
    }

    const subject = String(body?.subject || "").trim();
    if (!subject) return json({ error: "A subject is required" }, 400);

    // Plain text is accepted and wrapped, because the callers compose a short
    // covering note, not a newsletter.
    const isHtml = body?.html === true;
    const rawBody = String(body?.body || "");
    const content = isHtml ? rawBody
      : `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;white-space:pre-wrap">${
          rawBody.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string))
        }</div>`;

    // attachments: [{ name, contentType, contentBytes (base64) }]
    const atts = Array.isArray(body?.attachments) ? body.attachments : [];
    let total = 0;
    for (const a of atts) {
      if (!a?.name || typeof a?.contentBytes !== "string") {
        return json({ error: "Each attachment needs a name and base64 contentBytes" }, 400);
      }
      total += b64Bytes(a.contentBytes);
    }
    if (total > MAX_TOTAL) {
      return json({
        error: `Attachments total ${(total / 1048576).toFixed(1)}MB, over the ${MAX_TOTAL / 1048576}MB limit`,
        hint: "Send the drawing set by transmittal link instead of by mail.",
      }, 413);
    }

    const started = Date.now();
    const summary = {
      caller: sender, from: sender,
      to: to.map((x) => x.emailAddress.address),
      cc: cc.map((x) => x.emailAddress.address),
      bcc: bcc.map((x) => x.emailAddress.address),
      subject, attachments: atts.map((a: any) => ({ name: a.name, bytes: b64Bytes(a.contentBytes) })),
      total_bytes: total,
      route: total > INLINE_LIMIT ? "draft+upload-session" : "sendMail",
    };

    // A dry run proves configuration and authorisation without putting mail in
    // front of a client. Deliberately returns BEFORE acquiring a token, so it is
    // also safe to call from a smoke test.
    if (dryRun) return json({ ok: true, dry_run: true, ...summary });

    const token = await graphToken(TENANT, CLIENT, SECRET);
    const box = `/users/${encodeURIComponent(sender)}`;

    if (total <= INLINE_LIMIT) {
      // ---- one round trip ---------------------------------------------------
      await graph(token, "POST", `${box}/sendMail`, {
        message: {
          subject, body: { contentType: "HTML", content },
          toRecipients: to, ccRecipients: cc, bccRecipients: bcc,
          attachments: atts.map((a: any) => ({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: a.name,
            contentType: a.contentType || "application/octet-stream",
            contentBytes: a.contentBytes,
          })),
        },
        // Keeps the issued sheet in the sender's Sent Items, which is the point
        // of sending as the real person.
        saveToSentItems: true,
      });
      return json({ ok: true, ms: Date.now() - started, ...summary });
    }

    // ---- large: draft → upload each attachment → send ------------------------
    // ⚠️ THE DRAFT IS THE RISK IN THIS PATH. If an upload fails half way we must
    // not leave a half-built message sitting in the sender's Drafts, where
    // someone may later send it by hand believing it complete. Any failure after
    // the draft exists deletes it before reporting.
    const draft = await graph(token, "POST", `${box}/messages`, {
      subject, body: { contentType: "HTML", content },
      toRecipients: to, ccRecipients: cc, bccRecipients: bcc,
    });
    const mid = draft?.id;
    if (!mid) throw new Error("Graph did not return a draft message id");

    try {
      for (const a of atts) {
        const bytes = b64ToBytes(a.contentBytes);
        const session = await graph(token, "POST", `${box}/messages/${mid}/attachments/createUploadSession`, {
          AttachmentItem: {
            attachmentType: "file",
            name: a.name,
            size: bytes.length,
            contentType: a.contentType || "application/octet-stream",
          },
        });
        const url = session?.uploadUrl;
        if (!url) throw new Error(`No uploadUrl for attachment "${a.name}"`);
        for (let off = 0; off < bytes.length; off += UPLOAD_SLICE) {
          const end = Math.min(off + UPLOAD_SLICE, bytes.length);
          const slice = bytes.subarray(off, end);
          // ⚠️ The upload URL is pre-authorised and must NOT carry the bearer
          // token; Graph rejects the chunk if it does.
          const r = await fetch(url, {
            method: "PUT",
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(slice.length),
              "Content-Range": `bytes ${off}-${end - 1}/${bytes.length}`,
            },
            body: slice,
          });
          if (!r.ok) {
            throw new Error(`Uploading "${a.name}" failed at byte ${off} (${r.status}): ${await r.text()}`);
          }
        }
      }
      await graph(token, "POST", `${box}/messages/${mid}/send`);
    } catch (e) {
      try { await graph(token, "DELETE", `${box}/messages/${mid}`); } catch { /* best effort */ }
      throw e;
    }

    return json({ ok: true, ms: Date.now() - started, ...summary });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
