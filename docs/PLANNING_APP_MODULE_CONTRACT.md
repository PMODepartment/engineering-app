# Module Contract — Planners Dashboard

**Read this before writing any code.** Every Phase-1 module is built by a different
developer but must plug into one shared shell. Follow this contract so the
modules consolidate cleanly. The main app owner (Planning team) reviews and
merges your module.

---

## 1. Where your module lives

```
planning-app/
  modules/<your-module-key>/
    index.html        ← entry page (required, name must be index.html)
    module.js         ← your module's logic
    module.css        ← (optional) styles specific to your module
    CLAUDE.md         ← your own change log for this module
```

Your module key (folder name) is fixed — use exactly the one assigned in
`assets/js/config.js → APP_CONFIG.MODULES`:

| Module | key |
|---|---|
| Progress Photos | `progress-photos` |
| Issues, Concerns & Lessons Learned | `issues-lessons` |
| Contracts & Claims Register | `contracts-claims` |
| Risk Register | `risk-register` |
| Stakeholder Map | `stakeholder-map` |
| Drawing Register | `drawing-register` |
| Material Submittal Log | `material-submittal` |

**Do not edit files outside your folder** except `supabase-schema.sql` (only to
add your own table) and `assets/js/config.js` (only to flip your module's
`enabled: true`). If you need a change to a shared file, ask the main app owner.

---

## 2. Stack — no build step

Vanilla **HTML + CSS + JS** only. No React, no bundler, no npm build. Files are
served as-is by GitHub Pages. Use the Supabase UMD CDN bundle (already loaded
by the shell pattern below).

---

## 3. Required boilerplate for your `index.html`

Your page is **one level deeper** than the shell, so shared assets load with a
`../../` prefix. Copy this head/script skeleton exactly:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" type="image/png" href="../../assets/img/favicon.png" />
  <link rel="apple-touch-icon" href="../../assets/img/icon.png" />
  <script src="../../assets/js/theme.js"></script>   <!-- dark mode; load in <head> -->
  <title>Risk Register · Planners Dashboard</title>
  <link rel="stylesheet" href="../../assets/css/dashboard.css" />
  <link rel="stylesheet" href="module.css" />
</head>
<body>
  <!-- use the shared shell layout: .pd-app > .pd-sidebar + .pd-content -->
  <!-- sidebar brand block: logo + your module name as the caption -->
  <div class="pd-brand">
    <img class="pd-brand-logo" src="../../assets/img/logo-white.png" alt="Megawide Construction">
    Planners Dashboard<small>Risk Register</small>
  </div>
  ...
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script src="../../assets/js/config.js"></script>
  <script src="../../assets/js/auth.js"></script>
  <script src="../../assets/js/db.js"></script>
  <script src="../../assets/js/ui.js"></script>
  <script src="module.js"></script>
  <script>
    AppAuth.requireLogin(function (user, profile) {
      UI.renderUserBar(profile);          // top-right user + logout
      MyModule.init(user, profile);       // your entry point
    });
  </script>
</body>
</html>
```

`AppAuth.requireLogin` handles the session check and redirects unauthenticated
users to login automatically — you never roll your own auth.

---

## 4. Shared APIs you must use (don't reinvent)

**Auth — `AppAuth`** (`auth.js`)
- `AppAuth.requireLogin(cb)` / `requireRole(['admin'], cb)` / `requireAdmin(cb)`
- `AppAuth.getSB()` → the Supabase client (use this for your queries)
- `AppAuth.canAccessProject(profile, projectId)`
- `AppAuth.logout()`
- Current user/profile available as `window.__profile`, `window.__role`

**Data — `PDb` + `Fmt`** (`db.js`)
- `PDb.getProjects()`, `PDb.getProject(id)` — the shared project list
- `Fmt.money`, `Fmt.moneyShort`, `Fmt.date`, `Fmt.esc(html)` — use `Fmt.esc`
  on ALL user-supplied text you inject into HTML

**UI — `UI`** (`ui.js`)
- `UI.toast(msg, 'ok'|'error'|'warn')`
- `UI.renderUserBar(profile)`
- `UI.modal(html, opts)`
- `UI.enhanceProjectSelect(selectEl)` — **use this for the project picker.** Populate a
  native `<option>` list as usual, set the current value, then call it once: it upgrades
  the `<select>` into the shared **OPC folder browser** (drill Workspace → Program → Group
  with a breadcrumb + search that flattens across the tree; scales to 100s of projects)
  while keeping the `<select>` as the source of truth, so your existing `onchange` still
  fires. It builds the tree from `PDb.getProjects` + `PDb.getWorkspaces`, filtered to the
  ids in your options (so any access filtering you applied is respected). Safe to call
  again to refresh after repopulating.

**Uniform top bar (required).** Every module uses the sidebar-less shell with the same
top-bar order: a 36×36 back button (`data-ico="arrowLeft"` → `dashboard.html`), then an
`<h1>` whose title is **preceded by the module's brand-red icon** (the `icon` from
`config.js`, e.g. `<span data-ico="camera" style="color:var(--pd-red)"></span>`), then the
project selector (enhanced per above), then a tool cluster beside the profile, then
`#user-bar`. Copy Progress Photos / Drawing Register for the exact markup.

**Styles** — use the shared classes/tokens in `dashboard.css`: `.pd-card`,
`.pd-btn`, `.pd-btn-primary`, `.pd-input`, `.pd-select`, `.pd-table`,
`.pd-field`, and the CSS variables (`--pd-red`, `--pd-ink`, …). Put anything
truly module-specific in your own `module.css`, prefixed `.<key>-…`.

**Dark mode is automatic** — `theme.js` (in your `<head>`) handles the toggle
and persistence; the toggle button auto-appears in the top bar. For your module
to adapt correctly, **use the shared tokens** for surfaces/text/borders
(`--pd-bg`, `--pd-card`, `--pd-ink`, `--pd-muted`, `--pd-line`) and **never
hard-code** `#fff`/`#000`/light backgrounds in `module.css`. Semantic data
colors (status greens/ambers/reds) are fine to keep fixed.

---

## 5. Database rules

- Your module owns its own table(s). The Phase-1 starter tables are already in
  `supabase-schema.sql`. To add a column, append an idempotent statement:
  `alter table risk_register add column if not exists xxx text;`
- **Every row must set `created_by = user.id` and `project_id`.** RLS depends on
  `created_by` for update/delete permission.
- Don't query other modules' tables directly in Phase 1. Cross-module data
  comes later (Phase 2 integrations) through the main app owner.
- File uploads → Supabase **Storage** bucket named after your module key
  (`progress-photos`, `drawing-register`, etc.). Store the path in your table's
  `*_url` column.

---

## 6. Project context

The selected project id is shared via `sessionStorage` key **`pd_project`**.
Read it on load; if empty, show a project picker using `PDb.getProjects()` and
write the chosen id back to `pd_project`. Always scope your queries with
`.eq('project_id', pid)`.

---

## 7. Git workflow

- One shared GitHub repo, multiple developers. **Work on a branch named
  `module/<your-key>`**, never commit straight to `main`.
- Commit per logical change with a clear message prefixed by your module key,
  e.g. `risk-register: add edit modal`.
- Open a Pull Request into `main`; the main app owner reviews and merges.
- Keep your module's `CLAUDE.md` updated each PR.

---

## 8. Definition of done (Phase 1)

- [ ] Full CRUD: add, edit, view, list, delete records (per module needs)
- [ ] Project-scoped (uses `pd_project`)
- [ ] Uses shared auth, styles, `Fmt.esc` on all injected user text
- [ ] Works on desktop and mobile (the shared CSS is responsive)
- [ ] Table/columns added to `supabase-schema.sql` (idempotent)
- [ ] `enabled: true` flipped in `config.js` and module `CLAUDE.md` updated
- [ ] PR opened into `main`

Questions about shared code or the contract → main app owner (Planning team).
