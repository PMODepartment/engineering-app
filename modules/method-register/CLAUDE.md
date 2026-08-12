# Method Register

Placeholder only — no table, no CRUD yet. Registered in `config.js` with
`enabled: true` so it shows up in the sidebar and dashboard launcher as
"coming soon," matching how the other two modules first landed.

`index.html` is a bare shell (topbar + `.pd-empty` notice), reusing
`config.js` / `auth.js` / `db.js` / `ui.js` / `icons.js` — no `perm.js` or
`nav.js` needed until there's data and write actions to gate.

When building it out for real, follow `docs/MODULE_GUIDE.md` from step 2
(migration) onward — copy `modules/material-submittal/index.html` as the
skeleton, since the guide calls it out as the smaller of the two existing
modules.
