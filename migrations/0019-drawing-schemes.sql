-- ============================================================================
-- 0019 — SCHEMES: a per-project design variant the Technical Officer maintains
-- ----------------------------------------------------------------------------
-- Answers "should the technical officer be able to add schemes at level 1?".
--
-- ⚠️ NO — AND THIS MIGRATION IS THE ALTERNATIVE, NOT A STEP TOWARDS IT.
--   The SLN101 workbook writes its blocks as
--       SCHEMATIC DESIGN 1 (Scheme 1)
--       SCHEMATIC DESIGN 2 (Scheme 1)
--       SCHEMATIC DESIGN 2 (Scheme 2)
--   The scheme is a PARENTHETICAL QUALIFIER ON a drawing type, not a sibling of
--   one. Three things break if it becomes a level-1 node:
--
--   1. The top level is a CLOSED SET OF FIVE (0017 + 0018). phaseIdx(), the
--      Overview's five-lane Gantt, groupAgg('phase'), TRACK_MODE and this
--      migration series' own classifier all key off that closure. An
--      open-ended level 1 makes every one of them wrong.
--   2. A scheme CUTS ACROSS drawing types. SLN101's Scheme 2 happens to touch
--      only Schematic Design today, but a change-order redesign produces FCD,
--      TWD and ISD in Scheme 2 as well. Scheme-as-level-1 duplicates the whole
--      five-type tree per scheme, and "Schematic Design progress" stops being
--      one number.
--   3. The importer dedupes level nodes BY PATH KEY. Putting the scheme in that
--      key re-splits SLN101's three Schematic Design blocks into three level-1
--      rows — the exact regression the dedupe was written to prevent (measured:
--      three "Schematic Design" roots, two of them permanently empty).
--
--   So a scheme sits ABOVE level 1, as a LENS over the whole tree, and the tree
--   itself is untouched by this migration.
--
-- ⚠️ WHAT WAS ACTUALLY MISSING is the half of the request that is real: there
--   was no way to CREATE a scheme at all. Schemes only ever arrived from an
--   import, which read "(Scheme 2)" into the two-valued `scope` column. A third
--   scheme therefore had nowhere to go — it collapsed into the same
--   "Change Order" bucket as Scheme 2 and became indistinguishable from it.
--
-- ⚠️ `scope` IS NOT REPLACED. Scheme (which design variant) and scope (its
--   commercial standing: Main Contract vs Change Order) are two different facts
--   that happen to be 1:1 in SLN101. The transmittal top sheet, the Excel export
--   and the existing filter all read `scope`, so it stays, and the app keeps it
--   in agreement with the scheme's own scope rather than letting the two drift.
--
-- ⚠️ STRUCTURAL NODES CARRY NO SCHEME (enforced below). A level belongs to every
--   scheme; only a drawing belongs to one. Writing a scheme onto a level node
--   would make the three folded Schematic Design blocks disagree about which
--   scheme "the" Schematic Design level is in — first-occurrence would win and
--   silently label the merged node "Scheme 1".
--
-- IDEMPOTENT: every statement is guarded, so re-running changes nothing.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — the per-project scheme list
-- ----------------------------------------------------------------------------
-- Mirrors drawing_level_defs (0017) deliberately: same shape, same RLS, same
-- deploy-order tolerance. A project with no rows here has no scheme dimension
-- at all, and the module hides every scheme control — which is the correct
-- state for the majority of registers, where there is only one design.
-- ============================================================================

create table if not exists drawing_scheme_defs (
  id          uuid primary key default gen_random_uuid(),
  project_id  text not null references projects(id) on delete cascade,
  name        text not null,
  -- The commercial standing of this scheme. Same two values the `scope` column
  -- has always had; the scheme is what says WHICH change order.
  scope       text not null default 'Main Contract'
              check (scope in ('Main Contract','Change Order')),
  -- Superseded by a later scheme but NOT abandoned. Engineering must finish a
  -- superseded set because it is the baseline a change order's cost and time
  -- impact is measured against (see 0017's note) — so this is a label, never a
  -- filter that hides rows.
  superseded  boolean not null default false,
  notes       text,
  sort_order  int default 0,
  created_by  uuid references users(id),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  unique (project_id, name)
);

create index if not exists drawing_scheme_defs_project_idx
  on drawing_scheme_defs (project_id, sort_order);

comment on table drawing_scheme_defs is
  'Per-project design schemes (variants) for the drawing register. A scheme is a '
  'LENS OVER the level tree, never a level in it — the top level is a closed set '
  'of five (0017/0018). No rows for a project => that project has one design and '
  'the scheme controls are hidden.';

alter table drawing_scheme_defs enable row level security;

drop policy if exists drawing_scheme_defs_read on drawing_scheme_defs;
create policy drawing_scheme_defs_read on drawing_scheme_defs for select
  using (can_access_project(project_id));

drop policy if exists drawing_scheme_defs_ins on drawing_scheme_defs;
create policy drawing_scheme_defs_ins on drawing_scheme_defs for insert with check (
  is_writer() and created_by = auth.uid() and can_access_project(project_id));

drop policy if exists drawing_scheme_defs_upd on drawing_scheme_defs;
create policy drawing_scheme_defs_upd on drawing_scheme_defs for update
  using (is_writer() and can_access_project(project_id)
         and (created_by = auth.uid() or is_planner()))
  with check (is_writer() and can_access_project(project_id));

drop policy if exists drawing_scheme_defs_del on drawing_scheme_defs;
create policy drawing_scheme_defs_del on drawing_scheme_defs for delete
  using (is_writer() and can_access_project(project_id)
         and (created_by = auth.uid() or is_planner()));

grant select, insert, update, delete on drawing_scheme_defs to authenticated;

drop trigger if exists audit_drawing_scheme_defs on drawing_scheme_defs;
create trigger audit_drawing_scheme_defs after insert or update or delete
  on drawing_scheme_defs
  for each row execute function engineering_audit_trg();


-- ============================================================================
-- SECTION 2 — the scheme a drawing belongs to
-- ----------------------------------------------------------------------------
-- Denormalised text, exactly like `phase`, because the filter bar, the Excel
-- export and the grid all read a row without walking anything.
-- ============================================================================

alter table drawing_register add column if not exists scheme text;

create index if not exists drawing_register_scheme_idx
  on drawing_register (project_id, scheme);

comment on column drawing_register.scheme is
  'Design scheme this drawing belongs to, matching drawing_scheme_defs.name for '
  'the same project. NULL on structural level nodes (a level belongs to every '
  'scheme) and on registers with no scheme dimension.';


-- ============================================================================
-- SECTION 3 — backfill, ONLY where a scheme dimension actually exists
-- ----------------------------------------------------------------------------
-- ⚠️ DELIBERATELY NARROW. Stamping "Scheme 1" onto every register in the
-- database would invent a dimension for the ~all of them that have exactly one
-- design, and every one of those would grow a scheme filter and a scheme column
-- that never has a second value. A project qualifies only if it already holds a
-- 'Change Order' row — i.e. an import already found a "(Scheme 2)" block.
-- ============================================================================

do $$
declare
  n_defs int := 0;
  n_rows int := 0;
  n_clr  int := 0;
begin

  ------------------------------------------------------------ 3a. the defs ---
  -- 'Scheme 1' / 'Scheme 2' are the names SLN101's own workbook uses. A project
  -- that calls them something else renames them in the app; the rename carries
  -- the drawings' denormalised text with it.
  with qualifying as (
    select distinct project_id
      from drawing_register
     where scope = 'Change Order'
  ), wanted as (
    select q.project_id, v.name, v.scope, v.sort_order
      from qualifying q
      cross join (values ('Scheme 1','Main Contract',1),
                         ('Scheme 2','Change Order',2)) as v(name, scope, sort_order)
  )
  insert into drawing_scheme_defs (project_id, name, scope, sort_order, superseded, notes)
  select w.project_id, w.name, w.scope, w.sort_order,
         -- Scheme 1 is superseded BY Scheme 2 wherever both exist, which is
         -- exactly the qualifying condition above.
         (w.name = 'Scheme 1'),
         'Created by migration 0019 from the imported "(Scheme n)" block headers.'
    from wanted w
   on conflict (project_id, name) do nothing;
  get diagnostics n_defs = row_count;

  ------------------------------------------------- 3b. stamp the drawings ---
  -- Only rows that are drawings or sheets (node_kind 'drawing' / null), and only
  -- in a project that got defs above. Guarded on `scheme is null` so a second run
  -- cannot overwrite a scheme the user has since reassigned by hand.
  update drawing_register r
     set scheme = case when r.scope = 'Change Order' then 'Scheme 2' else 'Scheme 1' end
   where coalesce(r.node_kind, 'drawing') = 'drawing'
     and r.scheme is null
     and exists (select 1 from drawing_scheme_defs d where d.project_id = r.project_id);
  get diagnostics n_rows = row_count;

  ------------------------------------------- 3c. levels never hold a scheme ---
  -- Not merely tidiness: buildModel() merges same-named roots, so a scheme on a
  -- level node would label the ONE merged Schematic Design node with whichever
  -- block happened to be imported first.
  update drawing_register
     set scheme = null
   where coalesce(node_kind, 'drawing') <> 'drawing'
     and scheme is not null;
  get diagnostics n_clr = row_count;

  raise notice '0019: % scheme defs created, % drawings stamped, % level nodes cleared',
               n_defs, n_rows, n_clr;
end $$;


-- ============================================================================
-- VERIFY
-- ----------------------------------------------------------------------------
--   select project_id, name, scope, superseded, sort_order
--     from drawing_scheme_defs order by project_id, sort_order;
--
--   select project_id, scheme, scope, count(*)
--     from drawing_register
--    where coalesce(node_kind,'drawing') = 'drawing'
--    group by 1,2,3 order by 1,2,3;
--
-- Healthy for SLN101: two defs (Scheme 1 / Main Contract / superseded,
-- Scheme 2 / Change Order), every drawing carrying exactly one of them, and
-- scheme agreeing with scope on every row. No level node carries a scheme.
--
-- ⚠️ NOT A ROLLBACK POINT. Dropping drawing_scheme_defs loses any scheme the
-- Technical Officer added by hand after this ran; the `scheme` text on the
-- drawings survives, but nothing then defines its commercial scope.
-- ============================================================================
