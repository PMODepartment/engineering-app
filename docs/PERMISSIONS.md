# Permissions

The Engineering App reuses the **existing Planners Dashboard role set** unchanged.
No new roles were invented, so a role means the same thing in both apps.

```
super_admin  →  admin  →  planner  →  user  →  viewer
```

`status` is separate from role (`pending | approved | rejected`) and gates login
regardless of role: an unapproved account is redirected to `pending.html`.

---

## 1. Capability matrix

| Capability | super_admin | admin | planner | user | viewer |
|---|---|---|---|---|---|
| Open the Engineering App | ✓ | ✓ | ✓ | ✓ | ✓ |
| View Drawing Register | ✓ | ✓ | ✓ | ✓ | ✓ |
| View Material Submittal Log | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create records | ✓ | ✓ | ✓ | ✓ | — |
| Edit records | ✓ | ✓ | any | own | — |
| Submit | ✓ | ✓ | ✓ | ✓ | — |
| **Review / approve / reject** | ✓ | ✓ | ✓ | — | — |
| Upload files | ✓ | ✓ | ✓ | ✓ | — |
| Download / preview files | ✓ | ✓ | ✓ | ✓ | ✓ |
| Export to Excel / print | ✓ | ✓ | ✓ | ✓ | ✓ |
| Delete / archive records | ✓ | ✓ | any | own | — |
| Delete a stored file | ✓ | ✓ | ✓ | own uploads | — |
| Bulk import | ✓ | ✓ | ✓ | ✓ | — |
| Clear all records for a project | ✓ | ✓ | ✓ | — | — |
| View the audit trail | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manage users, roles, approvals | ✓ | ✓ | — | — | — |
| Manage projects and workspaces | ✓ | ✓ | planner+ (create/edit) | — | — |

"own" = the row's `created_by` equals the current user.

### Project scoping applies on top of all of it

Every capability additionally requires access to the record's project:

- `admin` / `super_admin` — **all** projects
- everyone else — only project ids listed in their `users.projects` array
  (assigned in **Administration**)

So a `planner` may edit any record *in their assigned projects*, not globally.

---

## 2. Where each rule is enforced

Two layers. **Only the second one is security.**

### Layer 1 — UX (`assets/js/perm.js`)

Decides what to *show*. Hides toolbar buttons a role cannot use, so people are not
offered actions that will fail.

```js
Perm.can(profile, 'approve')          // may this role ever approve?
Perm.can(profile, 'delete', row)      // …and for this specific row (project + ownership)?
Perm.canModule(profile, 'drawing-register')
Perm.applyReadonly(document, profile) // hides/disables every [data-perm] element
```

Module markup is declarative:

```html
<button id="dr-add" data-perm="create">+ Add</button>
<button data-perm="approve" data-perm-mode="disable">Approve</button>
```

> ⚠️ **A hidden button is not access control.** Anyone can open the console and
> issue the request. `perm.js` exists so the UI is honest, not to stop anyone.

### Layer 2 — Postgres (the actual enforcement)

There is no API server in this architecture — the browser talks to PostgREST
directly. **Row-Level Security is the only real boundary.**

#### RLS helper functions (`0001`)

All `SECURITY DEFINER` with a fixed `search_path`, so they read `users` while
bypassing RLS — this is what avoids the 54001 infinite-recursion bug.

| Function | True when |
|---|---|
| `is_approved()` | `status = 'approved'` |
| `is_writer()` | approved **and** role ≠ `viewer` |
| `is_planner()` | approved **and** role ∈ (super_admin, admin, planner) |
| `is_admin()` | approved **and** role ∈ (super_admin, admin) |
| `can_access_project(pid)` | admin, **or** `pid` ∈ `users.projects` |

#### Policies on `drawing_register` and `material_submittal`

| Operation | Policy |
|---|---|
| `select` | `can_access_project(project_id)` |
| `insert` | `is_writer()` **and** `created_by = auth.uid()` **and** `can_access_project(...)` |
| `update` | `is_writer()` **and** `can_access_project(...)` **and** (`created_by = auth.uid()` **or** `is_planner()`) |
| `delete` | same as update |

The `created_by = auth.uid()` requirement on insert means a client **cannot forge
a row owned by someone else**, and cannot create an unowned row — only the
`service_role` migration script can, which is exactly the property we want.

> The update/delete rule was widened from the Planning App's `or is_admin()` to
> `or is_planner()` in `0003`. Reason and consequences: [MIGRATION.md §3](MIGRATION.md).

#### Approval authority (`0002`)

RLS can express "who may write", but not "who may write *this particular
value*". Approval is a decision, not data entry, so it needs a trigger:

```
engineering_guard_decision()  — BEFORE UPDATE OF status
```

Raises `42501` if a row's status *changes into* a decision status
(`Approved`, `Approved w/ comments`, `Approved w/o comments`,
`Approved w/ Comments`, `Rejected`, `Resubmit`) and the caller is not
`is_planner()`.

Two deliberate limits:

- **Only transitions.** Editing any other field on an already-approved record is
  untouched, so a `user` can still fix a typo in the remarks of an approved drawing.
- **UPDATE only, not INSERT.** Both modules bulk-import historical Excel registers
  whose rows are *already* approved; gating inserts would stop a `user` importing
  a legacy register at all. A freshly inserted row has no prior state to escalate
  from, and every insert is still recorded in `engineering_audit` with its actor.

#### Storage

Buckets `drawing-register` and `material-submittal` are **private**.

| Operation | Policy |
|---|---|
| `select` / `insert` | `is_approved()` |
| `delete` | `owner = auth.uid()` **or** `is_planner()` |

The `owner` branch is kept deliberately: insert is `is_approved()`, so a `user`
can upload — replacing it with `is_planner()` alone would remove their ability to
delete their own upload.

#### Audit trail (`0002`)

`engineering_audit` is readable within project scope and **writable by nobody** —
there is no insert/update/delete policy, and those grants are explicitly revoked
from `authenticated`. Only the `SECURITY DEFINER` trigger writes to it. Not even
an admin can alter the record.

---

## 3. Changing permissions

### Restrict a module to certain roles

`assets/js/perm.js`:

```js
var MODULE_ROLES = { 'rfi': PLANNERS };
```

Both the sidebar and the launcher then hide it for everyone else. **Add a matching
RLS policy on that module's table** — the JS change alone hides the link, it does
not protect the data.

### Add a capability

Add it to `CAPS` in `perm.js`, then tag controls with `data-perm="<name>"`. If it
guards data rather than only UI, add the Postgres rule in the same change.

### Add a role

Don't, if it can be avoided. `users.role` has a CHECK constraint, and every helper
function plus `AppAuth.ROLES` in both apps would need updating in step — and the
Planners Dashboard reads the same column. Prefer expressing the need as a
capability of an existing role.

---

## 4. Verifying enforcement

Hiding a button proves nothing. Test the database directly — sign in as a
`viewer`, open the console on any module page, and confirm the write is refused:

```js
// expect: error 42501 (or an empty RLS rejection), NOT success
await getSB().from('drawing_register')
  .insert({ project_id: sessionStorage.getItem('pd_project'), title: 'rls probe' });
```

And as a `user` (not planner), on a row you can otherwise edit:

```js
// expect: 42501 — "review and approval require the planner … role"
await getSB().from('drawing_register')
  .update({ status: 'Approved' }).eq('id', '<some row id>');
```
