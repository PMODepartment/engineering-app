-- ============================================================================
-- Engineering App — 0017: drawing_register generic levels + tracking units
-- ----------------------------------------------------------------------------
-- Idempotent. Rollback at the bottom.
--
-- Built against "SLN101. TEC. Drawing Register" sheet `Dwg Registry` (1,500 rows,
-- 4PH Bacoor - Salinas). That sheet's own subtotals are the spec — see
-- modules/drawing-register/CLAUDE.md for the transcription.
--
-- WHY THIS EXISTS ------------------------------------------------------------
-- The register was a tree of exactly THREE named levels, carried as TEXT columns
-- (`phase` › `discipline` › `category`) with `parent_id` used only for per-sheet
-- rows. SLN101 needs FOUR grouping levels and they do not mean what the column
-- names say:
--
--   For Construction Drawings  (level 1 — one of four FIXED top levels)
--     › TOWER / PARKING BUILDING / SITE DEVELOPMENT   (level 2 — "Building")
--         › ARCHITECTURAL / STRUCTURAL / …            (level 3 — "Trade")
--             › A-100 Floor Plan                      (level 4 — "Category")
--                 › Ground Floor Plan                 (the drawing)
--                     › sheets                        (optional break-out)
--
-- Another project will want different sublevels, so levels 2..N become GENERIC:
-- depth comes from `parent_id`, and each project NAMES its own levels in the new
-- `drawing_level_defs` table. Only level 1 is fixed.
--
-- ⚠️ THE TOP LEVEL IS NOW A CLOSED SET OF FOUR:
--       Concept Design | Schematic Design
--       For Construction Drawings | Individual Services Drawings
--   • Schematic Design 1 and 2 (LOD 100 / LOD 200) MERGE COMPLETELY — the
--     distinction is dropped, by explicit decision. Do not reintroduce it.
--   • Temporary Works is NO LONGER a top level. It folds in as a level-2 child of
--     For Construction Drawings (this migration converts its node in place, so its
--     own sub-tree survives one level deeper).
--
-- ⚠️ "(Scheme 1)" / "(Scheme 2)" WERE NEVER PHASES — they are `scope`
--   (Main Contract / Change Order), which already exists and is unchanged. Scheme 1
--   is the superseded set: Engineering must finish it because it is the baseline
--   the cost and time impact of a change order is measured against. Those rows are
--   RETAINED, never deleted, and the fold below preserves them by moving the
--   distinction onto `scope` BEFORE it rewrites `phase`.
--
-- ⚠️ TWO PROGRESS SEMANTICS, and they cannot share a percentage.
--   • Individual Services Drawings → `track_mode='sheets'`. A leaf carries many
--     sheets with partial credit (real example: "Rebar Cutting List" = 83 sheets,
--     50 approved).
--   • The other three → `track_mode='binary'`. A leaf is 1 sheet, approved or not.
--     The 0/100 unit is a NODE the Technical Officer flags `is_tracking_unit`,
--     typically the level-3 trade ("Architectural Drawings 0 → 100"). A parent's
--     percent is approved units ÷ total units, EQUAL WEIGHT — not sheet-weighted.
--     This is why per-sheet break-out is refused on a binary branch: partial credit
--     there is not a display choice, it is a contradiction.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — per-project level names ("the user defines the sublevels")
-- ----------------------------------------------------------------------------
-- Level 1 is NEVER stored here: it is the fixed four-value top level. Rows start
-- at level_no = 2. A level with no row here falls back to "Level N" in the UI, so
-- an unconfigured project still works.
-- ============================================================================

create table if not exists drawing_level_defs (
  id          uuid primary key default gen_random_uuid(),
  project_id  text not null references projects(id) on delete cascade,
  level_no    int  not null check (level_no between 2 and 12),
  label       text not null,
  sort_order  int  default 0,
  created_by  uuid references users(id),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  unique (project_id, level_no)
);

alter table drawing_level_defs add column if not exists sort_order int default 0;
alter table drawing_level_defs add column if not exists updated_at timestamptz default now();

create index if not exists drawing_level_defs_project_idx
  on drawing_level_defs (project_id, level_no);

comment on table drawing_level_defs is
  'Per-project names for drawing_register sublevels 2..N. Level 1 is the fixed '
  'four-value top level and is deliberately absent. Missing row => "Level N".';

alter table drawing_level_defs enable row level security;

drop policy if exists drawing_level_defs_read on drawing_level_defs;
create policy drawing_level_defs_read on drawing_level_defs for select
  using (can_access_project(project_id));

drop policy if exists drawing_level_defs_ins on drawing_level_defs;
create policy drawing_level_defs_ins on drawing_level_defs for insert with check (
  is_writer() and created_by = auth.uid() and can_access_project(project_id));

drop policy if exists drawing_level_defs_upd on drawing_level_defs;
create policy drawing_level_defs_upd on drawing_level_defs for update
  using (is_writer() and can_access_project(project_id)
         and (created_by = auth.uid() or is_planner()))
  with check (is_writer() and can_access_project(project_id));

drop policy if exists drawing_level_defs_del on drawing_level_defs;
create policy drawing_level_defs_del on drawing_level_defs for delete
  using (is_writer() and can_access_project(project_id)
         and (created_by = auth.uid() or is_planner()));

grant select, insert, update, delete on drawing_level_defs to authenticated;

drop trigger if exists audit_drawing_level_defs on drawing_level_defs;
create trigger audit_drawing_level_defs after insert or update or delete
  on drawing_level_defs
  for each row execute function engineering_audit_trg();


-- ============================================================================
-- SECTION 2 — drawing_register columns (additive; nothing is dropped)
-- ============================================================================

-- Depth of a STRUCTURAL row. NULL for a drawing and for a sheet — their depth is
-- their parent's + 1, so it can never disagree with the tree.
alter table drawing_register add column if not exists level            int;

-- The Technical Officer's 0/100 breakdown node. See the header note.
alter table drawing_register add column if not exists is_tracking_unit boolean not null default false;

-- 'binary' | 'sheets'. Authoritative on the level-1 node; inherited downward.
alter table drawing_register add column if not exists track_mode       text;

comment on column drawing_register.level is
  'Depth of a structural (node_kind <> ''drawing'') row: 1 = the fixed top level, '
  '2..N = user-defined sublevels named in drawing_level_defs. NULL for drawings '
  'and sheets — their depth is derived from parent_id.';
comment on column drawing_register.is_tracking_unit is
  'Binary branches only: this node is one 0-or-100 unit of progress. Typically the '
  'level-3 trade node. A parent''s percent = approved units / total units, equal weight.';
comment on column drawing_register.track_mode is
  '''binary'' (Concept / Schematic / For Construction — a leaf is approved or not) or '
  '''sheets'' (Individual Services Drawings — partial sheet credit). Set on the '
  'level-1 node, inherited by everything beneath it.';

-- ⚠️ `parent_id` now carries GROUP and DRAWING parentage, not just sheets. It was
-- already `references drawing_register(id) on delete cascade`, so deleting a level
-- removes its sub-tree — which is what replaced the old delete-by-matching-text.
-- A row is a SHEET only when its parent is itself a drawing; the client asserts the
-- same thing (isSheet / indexSheets), so a drawing parented to a node is not
-- mistaken for a sheet of it.
create index if not exists drawing_register_parent_level_idx
  on drawing_register (project_id, parent_id, sort_order);
create index if not exists drawing_register_level_idx
  on drawing_register (project_id, level);


-- ============================================================================
-- SECTION 3 — BACKFILL. Guarded throughout, safe to re-run.
-- ----------------------------------------------------------------------------
-- ORDER IS LOAD-BEARING: the Scheme-2 scope and the Temporary-Works membership are
-- both read out of the ORIGINAL `phase` text, so they must be captured before the
-- fold rewrites it. Re-running after the fold is a no-op because the patterns no
-- longer match anything.
-- ============================================================================

do $mig$
declare
  n_scope   int := 0;
  n_fold    int := 0;
  n_twd     int := 0;
  leftover  text;
begin

  ------------------------------------------------------------------ 3a. scope
  -- "(Scheme 2)" is a change order, not a design stage.
  update drawing_register
     set scope = 'Change Order'
   where phase ~* 'scheme[[:space:]]*2'
     and coalesce(scope, '') <> 'Change Order';
  get diagnostics n_scope = row_count;

  update drawing_register set scope = 'Main Contract'
   where coalesce(scope, '') = '';

  ------------------------------------- 3b. remember the Temporary Works sub-tree
  -- Captured BEFORE the fold, because the fold erases the only evidence.
  create temporary table _dr_twd on commit drop as
    select id, project_id, node_kind
      from drawing_register
     where phase ~* 'temporary[[:space:]]*works|(^|[^a-z])tw[dg]([^a-z]|$)';
  select count(*) into n_twd from _dr_twd;

  ------------------------------------------------- 3c. fold to the four top levels
  -- ISD is tested first so its trailing "(ISD)" can never be read as an SD stage.
  update drawing_register
     set phase = case
       when phase ~* 'concept|(^|[^a-z])ecd([^a-z]|$)'                then 'Concept Design'
       when phase ~* 'individual[[:space:]]*service|(^|[^a-z])isd([^a-z]|$)'
                                                                      then 'Individual Services Drawings'
       -- Temporary Works becomes a CHILD of For Construction (re-parented in 3e).
       when phase ~* 'temporary[[:space:]]*works|(^|[^a-z])tw[dg]([^a-z]|$)'
                                                                      then 'For Construction Drawings'
       -- SD1 and SD2 merge completely. "Scheme n" is already on `scope` (3a).
       when phase ~* 'schematic|scheme|(^|[^a-z])sd[12]?([^a-z]|$)'    then 'Schematic Design'
       when phase ~* 'construction|contract|(^|[^a-z])fcd([^a-z]|$)'   then 'For Construction Drawings'
       else phase
     end
   where coalesce(phase, '') <> '';
  get diagnostics n_fold = row_count;

  -- Anything that matched nothing is REPORTED, not silently rewritten — a value we
  -- cannot classify is a data question, and guessing it would lose real rows.
  select string_agg(distinct phase, ', ') into leftover
    from drawing_register
   where coalesce(phase, '') <> ''
     and phase not in ('Concept Design', 'Schematic Design',
                       'For Construction Drawings', 'Individual Services Drawings');
  if leftover is not null then
    raise notice '0017: unclassified top level(s) left as-is: %', leftover;
  end if;

  ------------------------------------------------- 3d. levels from the old kinds
  update drawing_register set level = 1 where node_kind = 'phase'      and level is distinct from 1;
  update drawing_register set level = 2 where node_kind = 'discipline' and level is distinct from 2;
  update drawing_register set level = 3 where node_kind = 'category'   and level is distinct from 3;
  -- A drawing/sheet derives its depth from the tree, never from a stored number.
  update drawing_register set level = null
   where coalesce(node_kind, 'drawing') = 'drawing' and level is not null;

  --------------------------------------- 3e. one level-1 node per (project, phase)
  -- The tree needs a real root per top level; older projects only have nodes for
  -- the levels someone happened to create.
  -- ⚠️ A Temporary Works phase node now CARRIES the name 'For Construction Drawings'
  -- (3c rewrote it) but is about to become a level-2 child in 3g. It must not be
  -- mistaken for the real FCD root: if it were, 3g would join it to itself and set
  -- its own id as its parent — a self-referencing cycle that makes the recursive
  -- CTE in 3h drop the whole sub-tree. So every existence/survivor test below
  -- deliberately ignores the rows captured in _dr_twd.
  insert into drawing_register (project_id, node_kind, level, phase, title, sort_order)
  select d.project_id, 'phase', 1, d.phase, d.phase,
         coalesce(min(d.sort_order), 0)
    from drawing_register d
   where coalesce(d.phase, '') <> ''
     and not exists (
       select 1 from drawing_register p
        where p.project_id = d.project_id
          and p.node_kind  = 'phase'
          and p.phase      = d.phase
          and p.id not in (select id from _dr_twd))
   group by d.project_id, d.phase;

  -- Deduplicate: the fold can collapse two phase nodes (SD1 + SD2) onto one name.
  -- Keep the earliest and let 3f re-point everything at the survivor. A TWD node is
  -- never a candidate for deletion here — 3g repurposes it as a level-2 node.
  delete from drawing_register d
   using drawing_register k
   where d.node_kind = 'phase' and k.node_kind = 'phase'
     and d.project_id = k.project_id and d.phase = k.phase
     and d.id not in (select id from _dr_twd)
     and k.id not in (select id from _dr_twd)
     and (k.sort_order, k.id) < (d.sort_order, d.id);

  ------------------------------------- 3f. fold Temporary Works under FCD, in place
  -- ⚠️ THIS RUNS BEFORE THE GENERIC LINKING, and the order is load-bearing. Its own
  -- phase node BECOMES the level-2 "Temporary Works" node, so the whole sub-tree
  -- beneath it survives one level deeper; creating a new node instead would orphan it.
  -- Doing it first also removes an ambiguity: while the ex-TWD row is still
  -- node_kind='phase' AND carries the name 'For Construction Drawings', the
  -- discipline->phase lookup in 3h has TWO candidate roots and picks one at random.
  -- Converting it to a 'discipline' here leaves exactly one real root to find.
  update drawing_register d
     set node_kind  = 'discipline',
         level      = 2,
         discipline = 'Temporary Works',
         title      = 'Temporary Works',
         parent_id  = fcd.id
    from _dr_twd t
    join drawing_register fcd
      on fcd.project_id = t.project_id
     and fcd.node_kind  = 'phase'
     and fcd.phase      = 'For Construction Drawings'
   where d.id = t.id
     and t.node_kind = 'phase'
     -- never adopt yourself as your own parent (see the note in 3e)
     and fcd.id <> d.id
     and fcd.id not in (select id from _dr_twd)
     and d.parent_id is distinct from fcd.id;

  -- Everything that was under Temporary Works inherits the new phase text.
  update drawing_register set phase = 'For Construction Drawings'
   where id in (select id from _dr_twd)
     and phase is distinct from 'For Construction Drawings';

  ---------------------------------------------------------- 3g. link the tree up
  -- ⚠️ EVERY LINK BELOW IS GUARDED ON `parent_id is null`, i.e. it INITIALISES an
  -- unlinked row and never re-asserts a link that already exists. Without that guard
  -- a second run re-derives parentage from the TEXT columns and flattens the extra
  -- Temporary Works rung 3f just created (measured: `Structural` was yanked from
  -- level 3 back up to level 2). Once the tree has real parent_id edges, THOSE are
  -- the truth and the text must never override them.
  --
  -- ⚠️ The Temporary Works sub-tree is a separate MEMBERSHIP CLASS. Its disciplines
  -- are textually indistinguishable from For Construction's own, so a text join
  -- would hoist them to the wrong parent. `_dr_twd` is the partition: a TW row may
  -- only ever be parented inside the TW sub-tree, and a non-TW row only outside it.

  -- level 1 is a root.
  update drawing_register set parent_id = null
   where node_kind = 'phase' and parent_id is not null;

  -- Temporary Works' own disciplines -> the Temporary Works node.
  update drawing_register d
     set parent_id = tw.id
    from drawing_register tw
   where d.parent_id is null
     and d.id in (select id from _dr_twd where coalesce(node_kind,'drawing') <> 'phase')
     and d.node_kind = 'discipline'
     and tw.id in (select id from _dr_twd where node_kind = 'phase')
     and tw.project_id = d.project_id
     and tw.id <> d.id;

  -- level 2 (old 'discipline') -> its phase node. Non-TW rows only.
  update drawing_register d
     set parent_id = p.id
    from drawing_register p
   where d.parent_id is null
     and d.node_kind = 'discipline'
     and d.id not in (select id from _dr_twd)
     and p.node_kind = 'phase'
     and p.project_id = d.project_id
     and p.phase = d.phase;

  -- level 3 (old 'category') -> its discipline node, matched within the same class.
  update drawing_register d
     set parent_id = p.id
    from drawing_register p
   where d.parent_id is null
     and d.node_kind = 'category'
     and p.node_kind = 'discipline'
     and p.project_id = d.project_id
     and p.phase = d.phase
     and coalesce(p.discipline, '') = coalesce(d.discipline, '')
     and (d.id in (select id from _dr_twd)) = (p.id in (select id from _dr_twd));

  -- Drawings -> the DEEPEST node that matches their text, within the same class.
  -- Sheets are left alone: their parent is already the drawing they belong to.
  update drawing_register d
     set parent_id = best.id
    from (
      select x.id as row_id, n.id, n.level,
             row_number() over (partition by x.id order by n.level desc, n.id) as rk
        from drawing_register x
        join drawing_register n
          on n.project_id = x.project_id
         and n.node_kind is not null and n.node_kind <> 'drawing'
         and n.phase = x.phase
         and (n.level < 2 or coalesce(n.discipline, '') = coalesce(x.discipline, ''))
         and (n.level < 3 or coalesce(n.category,   '') = coalesce(x.category,   ''))
         and (x.id in (select id from _dr_twd)) = (n.id in (select id from _dr_twd))
       where coalesce(x.node_kind, 'drawing') = 'drawing'
         and coalesce(x.phase, '') <> ''
         and x.parent_id is null
    ) best
   where best.rk = 1
     and d.id = best.row_id;

  -- Derive depth from the linked tree so `level` can never disagree with parent_id.
  with recursive tree as (
    select id, 1 as lvl
      from drawing_register
     where parent_id is null
       and node_kind is not null and node_kind <> 'drawing'
    union all
    select c.id, t.lvl + 1
      from drawing_register c
      join tree t on c.parent_id = t.id
     where c.node_kind is not null and c.node_kind <> 'drawing'
  )
  update drawing_register d
     set level = t.lvl
    from tree t
   where d.id = t.id and d.level is distinct from t.lvl;

  ----------------------------------------------------------- 3i. track_mode
  -- Authoritative on level 1; every descendant carries a copy so a client that
  -- loads a filtered slice still knows which rule applies.
  update drawing_register
     set track_mode = case when phase = 'Individual Services Drawings'
                           then 'sheets' else 'binary' end
   where coalesce(phase, '') <> ''
     and track_mode is distinct from
         (case when phase = 'Individual Services Drawings' then 'sheets' else 'binary' end);

  ------------------------------------------ 3j. canonical titles on the level-1 rows
  -- The SD1/SD2 survivor still carries its old title ("SD1", "FCD"), which would
  -- display as the very stage name the merge just abolished. The four roots are
  -- named by the closed set, not by whichever node happened to survive.
  update drawing_register
     set title = phase
   where node_kind = 'phase' and level = 1
     and coalesce(phase, '') <> ''
     and title is distinct from phase;

  -------------------------------------------------------- 3k. seed tracking units
  -- Default to the trade node, which is the case the Technical Officers described
  -- ("Architectural Drawings 0 → 100"). That is level 3 in the SLN101 shape, but a
  -- legacy project may only be two levels deep — so seed the DEEPEST group level a
  -- binary branch actually has, rather than insisting on level 3 and leaving the
  -- project with no unit at all. Seeded ONLY where a project has none yet, so a
  -- deliberate choice is never overwritten on re-run.
  update drawing_register d
     set is_tracking_unit = true
    from (
      select project_id, max(level) as deepest
        from drawing_register
       where node_kind is not null and node_kind <> 'drawing'
         and coalesce(track_mode, 'binary') = 'binary'
         and level > 1
       group by project_id
    ) x
   where d.project_id = x.project_id
     and d.level = least(x.deepest, 3)
     and d.node_kind is not null and d.node_kind <> 'drawing'
     and coalesce(d.track_mode, 'binary') = 'binary'
     and not d.is_tracking_unit
     and not exists (
       select 1 from drawing_register u
        where u.project_id = d.project_id
          and u.is_tracking_unit
          and coalesce(u.track_mode, 'binary') = 'binary');

  -------------------------------------------------- 3l. binary leaves are 1 sheet
  -- Makes "0 or 100 only" true in the data, not just in the UI. ⚠️ `approved_sheets`
  -- must be clamped in the SAME statement: a row imported as 7-of-12 would otherwise
  -- keep 7 against a denominator of 1 and report 700%.
  update drawing_register
     set no_of_sheets    = 1,
         approved_sheets = case when status in ('Approved', 'Approved w/ comments',
                                               'Approved w/o comments') then 1 else 0 end,
         approved_pct    = case when status in ('Approved', 'Approved w/ comments',
                                               'Approved w/o comments') then 1 else 0 end
   where coalesce(node_kind, 'drawing') = 'drawing'
     and coalesce(track_mode, 'binary') = 'binary'
     and (coalesce(no_of_sheets, 1) <> 1 or coalesce(approved_sheets, 0) > 1)
     and not exists (select 1 from drawing_register s where s.parent_id = drawing_register.id);

  raise notice '0017 backfill: % scoped Change Order, % phases folded, % Temporary Works rows re-parented',
               n_scope, n_fold, n_twd;
end
$mig$;


-- ============================================================================
-- SECTION 4 — seed the SLN101 level names (the workbook's own structure)
-- ----------------------------------------------------------------------------
-- Only if the project exists here and has not been configured already, so this
-- never overwrites a name someone has since edited.
-- ============================================================================

insert into drawing_level_defs (project_id, level_no, label, sort_order)
select p.id, v.level_no, v.label, v.level_no
  from projects p
  cross join (values (2, 'Building'), (3, 'Trade'), (4, 'Category')) as v(level_no, label)
 where p.id = 'SLN101'
on conflict (project_id, level_no) do nothing;


-- ============================================================================
-- ROLLBACK
-- ----------------------------------------------------------------------------
-- The backfill is NOT reversible: the fold overwrites the original `phase` text
-- (SD1/SD2 and the "(Scheme n)" suffixes), by design. Restore from a snapshot if
-- the old top-level names are needed again.
--
-- drop trigger if exists audit_drawing_level_defs on drawing_level_defs;
-- drop table if exists drawing_level_defs;
-- drop index if exists drawing_register_parent_level_idx;
-- drop index if exists drawing_register_level_idx;
-- alter table drawing_register drop column if exists level;
-- alter table drawing_register drop column if exists is_tracking_unit;
-- alter table drawing_register drop column if exists track_mode;
-- ============================================================================
