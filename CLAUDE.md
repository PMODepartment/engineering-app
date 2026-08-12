# Engineering App

Megawide's Engineering App — sibling to the Planners Dashboard, own Supabase
project (see `assets/js/config.js`). Config-driven shell: modules are
registered once in `assets/js/config.js` and the sidebar/dashboard pick them
up automatically (`docs/MODULE_GUIDE.md`).

## Workflow

- **Commit and push after every change**, without waiting to be asked each
  time. Use a normal `git add` of the touched files (never `-A`/`.`), a
  commit message describing the change, then `git push origin main`.

## Modules

- `modules/drawing-register/` — live
- `modules/material-submittal/` — live
- `modules/method-register/` — placeholder only (`enabled: true`, no table/CRUD
  yet); see `modules/method-register/CLAUDE.md`

See `docs/MODULE_GUIDE.md` before adding or building out a module.
