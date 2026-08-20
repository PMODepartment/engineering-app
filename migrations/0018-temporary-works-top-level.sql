-- ============================================================================
-- Engineering App — 0018: Temporary Works Drawings becomes a TOP LEVEL again
-- ----------------------------------------------------------------------------
-- Idempotent. Rollback at the bottom. Run AFTER 0017.
--
-- WHY THIS EXISTS ------------------------------------------------------------
-- 0017 folded Temporary Works IN as a level-2 child of For Construction Drawings,
-- on the reasoning that it is "produced FOR construction". That was reversed by
-- explicit instruction (2026-08-20): temporary works are a distinct engineering
-- deliverable with their own designer, review cycle and programme, and burying
-- them a rung down inside FCD hid that on every roll-up and every Gantt lane.
--
-- The closed top-level set is therefore FIVE, not four:
--     Concept Design | Schematic Design | For Construction Drawings
--     Temporary Works Drawings | Individual Services Drawings
--
-- ⚠️ ONLY TEMPORARY WORKS IS PROMOTED. Combined Services and As-Built STAY folded
--   as level-2 children of For Construction Drawings — they are coordination and
--   record artefacts OF the FCD set, which temporary works are not. Do not
--   generalise this migration into "unfold everything 0017 folded".
--
-- ⚠️ THE FOLD NODE IS PROMOTED IN PLACE, never recreated. 0017 converted the
--   original Temporary Works *phase* node into the level-2 node (its 3f), so that
--   one row still carries the whole sub-tree. Creating a fresh level-1 node and
--   re-parenting would orphan everything hanging off it — the same trap 0017
--   documents in the other direction.
--
-- ⚠️ `phase` IS DENORMALISED ONTO EVERY DESCENDANT and must be rewritten with the
--   promotion. The client's modeOf()/topLevelOf() walk parent_id, but groupAgg(),
--   the filter bar, the importer's dedupe and the export all still read the text
--   column. Leaving the sub-tree saying 'For Construction Drawings' would put the
--   drawings in the FCD bucket on every one of those surfaces while the tree drew
--   them under Temporary Works — exactly the two-sources-of-truth split 0017's own
--   notes keep warning about.
-- ============================================================================

do $mig$
declare
  n_promoted int := 0;
  n_subtree  int := 0;
  n_text     int := 0;
  n_roots    int := 0;
begin

  ---------------------------------------------------- 1. the fold nodes to promote
  -- A level-2 node named "Temporary Works" whose parent is a real For Construction
  -- level-1 root. Matched on the TITLE/DISCIPLINE text 0017 wrote in its 3f, which is
  -- the only marker the fold left behind.
  -- ⚠️ Guarded on `d.level = 2 and p.parent_id is null` so this can never grab a
  --   genuinely deeper node that a project happens to have called "Temporary Works"
  --   (a trade or category), which would yank a sub-tree to the root.
  create temporary table _dr_unfold on commit drop as
    select d.id, d.project_id
      from drawing_register d
      join drawing_register p on p.id = d.parent_id
     where d.node_kind is not null and d.node_kind <> 'drawing'
       and d.level = 2
       and lower(coalesce(nullif(d.title, ''), d.discipline, '')) = 'temporary works'
       and p.node_kind = 'phase'
       and p.level = 1
       and p.parent_id is null
       and p.phase = 'For Construction Drawings';
  get diagnostics n_promoted = row_count;

  -- Everything at or below those nodes, BEFORE anything is rewritten — the walk has
  -- to happen while the sub-tree is still attached where 0017 left it.
  create temporary table _dr_unfold_tree on commit drop as
    with recursive t as (
      select id from _dr_unfold
      union all
      select c.id
        from drawing_register c
        join t on c.parent_id = t.id
    )
    select id from t;
  select count(*) into n_subtree from _dr_unfold_tree;

  ------------------------------------------------------------- 2. promote in place
  update drawing_register d
     set node_kind  = 'phase',
         level      = 1,
         parent_id  = null,
         phase      = 'Temporary Works Drawings',
         title      = 'Temporary Works Drawings',
         discipline = null
    from _dr_unfold u
   where d.id = u.id;

  ------------------------------------------- 3. the sub-tree follows its new top level
  update drawing_register
     set phase = 'Temporary Works Drawings'
   where id in (select id from _dr_unfold_tree)
     and phase is distinct from 'Temporary Works Drawings';

  -- 0017's 3f gave fold-member DRAWINGS the discipline 'Temporary Works' so they had a
  -- natural parent inside the fold. That node is now the top level itself, so the text
  -- would render as a phantom trade called "Temporary Works" in Progress-by-Trade and
  -- in the discipline filter. Cleared — but only on rows inside this sub-tree.
  update drawing_register
     set discipline = null
   where id in (select id from _dr_unfold_tree)
     and id not in (select id from _dr_unfold)
     and lower(coalesce(discipline, '')) = 'temporary works';

  ------------------------------ 4. registers that never folded (pre-0017, or unclassified)
  -- A project imported before 0017, or one whose block name 0017 could not classify,
  -- may still carry the temporary-works wording in `phase`. Bring it onto the canonical
  -- spelling so every register speaks the same five-value vocabulary.
  -- ⚠️ Deliberately does NOT touch rows already inside a folded FCD sub-tree — those
  --   were handled above and re-matching them here would be a no-op at best and, on a
  --   half-applied run, could rename a Combined Services row that merely mentions the
  --   words.
  update drawing_register
     set phase = 'Temporary Works Drawings'
   where coalesce(phase, '') <> ''
     and phase <> 'Temporary Works Drawings'
     and phase ~* 'temporary[[:space:]]*works|(^|[^a-z])tw[dg]([^a-z]|$)'
     and id not in (select id from _dr_unfold_tree);
  get diagnostics n_text = row_count;

  ---------------------------------------- 5. one level-1 node per (project, top level)
  -- Mirrors 0017's 3e. Step 4 can leave a project holding Temporary Works DRAWINGS with
  -- no root node to hang them from.
  insert into drawing_register (project_id, node_kind, level, phase, title, sort_order)
  select d.project_id, 'phase', 1, 'Temporary Works Drawings', 'Temporary Works Drawings',
         coalesce(min(d.sort_order), 0)
    from drawing_register d
   where d.phase = 'Temporary Works Drawings'
     and not exists (
       select 1 from drawing_register p
        where p.project_id = d.project_id
          and p.node_kind  = 'phase'
          and p.level      = 1
          and p.phase      = 'Temporary Works Drawings')
   group by d.project_id;
  get diagnostics n_roots = row_count;

  -- Deduplicate: a project could now hold two Temporary Works roots (a promoted fold
  -- node plus one step 5 inserted on an earlier partial run). Keep the earliest and
  -- re-point the rest's children at it, exactly as 0017's 3e does for SD1+SD2.
  update drawing_register d
     set parent_id = k.id
    from drawing_register o
    join drawing_register k
      on k.project_id = o.project_id and k.node_kind = 'phase' and k.level = 1
     and k.phase = 'Temporary Works Drawings'
     and (k.sort_order, k.id) < (o.sort_order, o.id)
   where o.node_kind = 'phase' and o.level = 1
     and o.phase = 'Temporary Works Drawings'
     and d.parent_id = o.id;

  delete from drawing_register d
   using drawing_register k
   where d.node_kind = 'phase' and k.node_kind = 'phase'
     and d.level = 1 and k.level = 1
     and d.project_id = k.project_id
     and d.phase = 'Temporary Works Drawings' and k.phase = 'Temporary Works Drawings'
     and (k.sort_order, k.id) < (d.sort_order, d.id);

  ------------------------------------------------- 6. re-derive depth from the tree
  -- Same recursion as 0017's 3h. The promoted sub-tree is one rung shallower now, and
  -- `level` must never be allowed to disagree with parent_id.
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

  ------------------------------------------------------------------ 7. track_mode
  -- 0017's 3i rule, unchanged and re-asserted: only Individual Services Drawings is
  -- sheet-weighted. Temporary Works is BINARY — a temporary-works drawing is approved
  -- or it is not, same as every other design deliverable. Re-run because the promoted
  -- rows changed `phase`.
  update drawing_register
     set track_mode = case when phase = 'Individual Services Drawings'
                           then 'sheets' else 'binary' end
   where coalesce(phase, '') <> ''
     and track_mode is distinct from
         (case when phase = 'Individual Services Drawings' then 'sheets' else 'binary' end);

  ------------------------------------------------- 8. canonical titles on the roots
  update drawing_register
     set title = phase
   where node_kind = 'phase' and level = 1
     and coalesce(phase, '') <> ''
     and title is distinct from phase;

  raise notice '0018: promoted % fold node(s), % sub-tree row(s); % row(s) renamed by text; % root(s) created',
    n_promoted, n_subtree, n_text, n_roots;
end
$mig$;

-- ============================================================================
-- VERIFY — expect Temporary Works Drawings to appear as a level-1 root with no
-- parent, and NO level-2 node called "Temporary Works" left under For Construction.
-- ============================================================================
-- select project_id, phase, node_kind, level, parent_id is null as is_root, count(*)
--   from drawing_register
--  where phase = 'Temporary Works Drawings'
--  group by 1,2,3,4,5 order by 1,4;
--
-- select count(*) as should_be_zero
--   from drawing_register d join drawing_register p on p.id = d.parent_id
--  where d.level = 2 and lower(coalesce(d.title,'')) = 'temporary works'
--    and p.phase = 'For Construction Drawings';

-- ============================================================================
-- ROLLBACK — re-folds Temporary Works under For Construction Drawings (i.e. puts
-- the register back into the shape 0017 left it in).
-- ⚠️ Only run this if the promotion is being abandoned; the CLIENT must be reverted
--   in the same breath (TOP_LEVELS and foldTopLevel() in modules/drawing-register/
--   module.js), or the next import will promote it straight back.
-- ============================================================================
-- do $rb$
-- begin
--   update drawing_register d
--      set node_kind  = 'discipline',
--          level      = 2,
--          discipline = 'Temporary Works',
--          title      = 'Temporary Works',
--          parent_id  = fcd.id
--     from drawing_register fcd
--    where d.node_kind = 'phase' and d.level = 1
--      and d.phase = 'Temporary Works Drawings'
--      and fcd.project_id = d.project_id
--      and fcd.node_kind = 'phase' and fcd.level = 1
--      and fcd.phase = 'For Construction Drawings'
--      and fcd.id <> d.id;
--
--   with recursive t as (
--     select id from drawing_register
--      where node_kind = 'discipline' and title = 'Temporary Works'
--     union all
--     select c.id from drawing_register c join t on c.parent_id = t.id
--   )
--   update drawing_register set phase = 'For Construction Drawings'
--    where id in (select id from t);
--
--   with recursive tree as (
--     select id, 1 as lvl from drawing_register
--      where parent_id is null and node_kind is not null and node_kind <> 'drawing'
--     union all
--     select c.id, t.lvl + 1 from drawing_register c join tree t on c.parent_id = t.id
--      where c.node_kind is not null and c.node_kind <> 'drawing'
--   )
--   update drawing_register d set level = t.lvl from tree t
--    where d.id = t.id and d.level is distinct from t.lvl;
-- end
-- $rb$;
