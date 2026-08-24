-- ============================================================================
-- Engineering App — 0020: request_for_approval (RFA register)
-- ----------------------------------------------------------------------------
-- Idempotent. Rollback at the bottom.
--
-- WHY THIS TABLE EXISTS
-- `assets/js/topsheet.js` has rendered the F-GEN011 RFA sheet since 0012, but the
-- RFA was opened BLANK from the Material Submittal toolbar — there was no record
-- behind it. So an RFA could be printed and never tracked: nothing knew it had
-- been issued, what it covered, or whether the consultant had answered. That also
-- made "auto-generate and email the top sheet" impossible for RFAs, because there
-- was nothing to generate one FROM.
--
-- This is the register. Modelled on material_submittal, which is the same shape:
-- a numbered log of outward submissions, each carrying a document, each waiting
-- on somebody else's decision.
--
-- ⚠️ RFI IS DELIBERATELY NOT HERE. Decided with the owner: an RFA carries a
-- document for approval and therefore needs a log; an RFI is a question-and-answer
-- sheet and stays an on-demand blank form. Do not "complete the set" by cloning
-- this for RFIs without asking — an empty register nobody fills is worse than no
-- register.
--
-- ⚠️⚠️ THE STATUS VOCABULARY REUSES NAMES THAT ARE ALREADY GATED, ON PURPOSE.
-- 'Approved', 'Approved w/ comments', 'Resubmit' and 'Rejected' all already appear
-- in engineering_decision_statuses() (0002, extended by 0014), so this migration
-- does NOT redefine that function. That matters: the function is SHARED, every
-- migration that touches it must reproduce the whole list verbatim, and dropping
-- one name would silently un-gate approval on drawing_register or
-- material_submittal. Inventing an RFA-specific synonym like 'Endorsed by
-- Consultant' would have forced a redefinition for no benefit. If a future status
-- genuinely needs gating, add it there and reproduce the full list.
-- ============================================================================

create table if not exists request_for_approval (
  id             uuid primary key default gen_random_uuid(),
  project_id     text not null references projects(id) on delete cascade,
  created_by     uuid references users(id),

  -- identity ------------------------------------------------------------------
  rfa_no         text,                 -- the RFA ID printed on the sheet, e.g. RFA-014
  revision       text,                 -- resubmissions keep the number and bump this
  title          text,
  description    text,
  category       text,                 -- RFA Category on the form
  sub_category   text,                 -- RFA Sub-category
  discipline     text,

  -- ⚠️ The issued F-GEN011 states the submission as a 3x4 CHECKBOX GRID of document
  -- types (Schedules, Method Statement, Shop Drawings, As-Built, O&M Manuals, …),
  -- not as free text. Stored as an array so the printed sheet can tick exactly what
  -- was ticked, and so the register can be filtered by what kind of thing was sent.
  -- The canonical list lives in topsheet.js (RFA_TYPES) — it is form content, not
  -- schema, so it is NOT constrained here; a form revision must not need a migration.
  doc_types      text[] default '{}',

  -- ⚠️ The form's document table is Document No. / Rev / Description / Pages, and it
  -- is a LIST. jsonb, not four columns: it is only ever read and written whole, with
  -- the RFA, and it is printed rather than queried.
  --   [{ doc_no, rev, description, pages }]
  --
  -- ⚠️⚠️ THIS IS FOR DOCUMENTS THAT ARE NOT IN THE DRAWING REGISTER — a method
  -- statement, a schedule, a test report. DRAWINGS ARE LINKED PROPERLY, through
  -- rfa_drawings below, and must NOT be typed in here as loose text: an RFA exists
  -- to get specific drawings approved, and a hand-typed "A-1204" cannot tell you
  -- whether A-1204 is still waiting. Both lists print on the sheet.
  documents      jsonb default '[]'::jsonb,

  -- routing (the TO / FROM block on the sheet) ---------------------------------
  to_name        text,
  to_company     text,
  from_name      text,
  from_company   text,

  -- dates ---------------------------------------------------------------------
  rfa_date       date,                 -- date issued, as printed
  date_required  date,                 -- the date the answer is needed by
  date_submitted date,
  date_returned  date,                 -- when the client/consultant sent it back

  -- the attached document -----------------------------------------------------
  -- ⚠️ Stores the object PATH in the private `material-submittal` bucket, never a
  -- URL — the URL is signed on demand, exactly as material_submittal does it. A
  -- stored URL would expire and would also be a way to read the object without RLS.
  -- Reusing that module's bucket rather than making a second one: same project
  -- scoping, same lifecycle, same cleanup code.
  file_url       text,

  -- decision ------------------------------------------------------------------
  -- Draft | Submitted | Under Review | Approved w/ comments | Approved | Resubmit
  -- | Rejected | Cancelled   (see the banner: four of these are already gated)
  status         text,
  review_status  text,                 -- the reviewer's own words off the returned sheet
  decision_by    text,
  decision_date  date,

  consultant_comments text,            -- CONSULTANT'S REVIEW AND APPROVAL block
  client_comments     text,            -- CLIENT / OWNER'S REVIEW AND APPROVAL block

  -- the Megawide signature band (Prepared / Checked / Approved) ---------------
  prepared_by    text,
  checked_by     text,
  approved_by    text,

  responsible    text,
  remarks        text,

  sort_order     int default 0,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- Re-assert every column so a partially-created table converges.
alter table request_for_approval add column if not exists rfa_no              text;
alter table request_for_approval add column if not exists revision            text;
alter table request_for_approval add column if not exists title               text;
alter table request_for_approval add column if not exists description         text;
alter table request_for_approval add column if not exists category            text;
alter table request_for_approval add column if not exists sub_category        text;
alter table request_for_approval add column if not exists discipline          text;
alter table request_for_approval add column if not exists doc_types           text[] default '{}';
alter table request_for_approval add column if not exists documents           jsonb default '[]'::jsonb;
alter table request_for_approval add column if not exists to_name             text;
alter table request_for_approval add column if not exists to_company          text;
alter table request_for_approval add column if not exists from_name           text;
alter table request_for_approval add column if not exists from_company        text;
alter table request_for_approval add column if not exists rfa_date            date;
alter table request_for_approval add column if not exists date_required       date;
alter table request_for_approval add column if not exists date_submitted      date;
alter table request_for_approval add column if not exists date_returned       date;
alter table request_for_approval add column if not exists file_url            text;
alter table request_for_approval add column if not exists status              text;
alter table request_for_approval add column if not exists review_status       text;
alter table request_for_approval add column if not exists decision_by         text;
alter table request_for_approval add column if not exists decision_date       date;
alter table request_for_approval add column if not exists consultant_comments text;
alter table request_for_approval add column if not exists client_comments     text;
alter table request_for_approval add column if not exists prepared_by         text;
alter table request_for_approval add column if not exists checked_by          text;
alter table request_for_approval add column if not exists approved_by         text;
alter table request_for_approval add column if not exists responsible         text;
alter table request_for_approval add column if not exists remarks             text;
alter table request_for_approval add column if not exists sort_order          int default 0;

create index if not exists rfa_project_idx    on request_for_approval (project_id);
create index if not exists rfa_status_idx     on request_for_approval (project_id, status);
create index if not exists rfa_discipline_idx on request_for_approval (project_id, discipline);
-- The register's default sort and the "overdue" query both run on this.
create index if not exists rfa_required_idx   on request_for_approval (project_id, date_required);

comment on table request_for_approval is
  'Request for Approval register (F-GEN011). One row per RFA issued to the '
  'consultant/client, from draft through their decision. The printed top sheet is '
  'generated from this row by assets/js/topsheet.js.';
comment on column request_for_approval.doc_types is
  'Which of the form''s 3x4 document-type checkboxes were ticked. The canonical '
  'list lives in topsheet.js (RFA_TYPES) — form content, not schema, so a form '
  'revision does not need a migration.';
comment on column request_for_approval.documents is
  'The form''s document table, whole: [{doc_no, rev, description, pages}]. One RFA '
  'routinely transmits several drawings. Read and written whole, and printed rather '
  'than queried, which is why it is jsonb and not a child table.';
comment on column request_for_approval.file_url is
  'Object PATH in the private material-submittal bucket, never a URL — signed on '
  'demand. A stored URL would expire and would bypass RLS.';
comment on column request_for_approval.status is
  'Draft | Submitted | Under Review | Approved w/ comments | Approved | Resubmit | '
  'Rejected | Cancelled. Four of these are gated by '
  'engineering_decision_statuses() — see the migration banner before renaming any.';
comment on column request_for_approval.date_required is
  'The date the answer is needed by. This is what makes an RFA overdue, and it is '
  'the register''s reason for existing: an unanswered RFA blocks work.';

-- ============================================================================
-- rfa_drawings — WHICH DRAWINGS THIS RFA IS SEEKING APPROVAL FOR
-- ----------------------------------------------------------------------------
-- ⚠️ THIS IS THE POINT OF THE RFA, not a nicety. An RFA is the vehicle that
-- carries specific drawings to the consultant for approval, so the register has to
-- answer BOTH directions:
--     forward  "what is RFA-014 asking approval for?"
--     reverse  "which RFA is drawing A-1204 waiting on, and how late is it?"
-- The reverse question is the one the Drawing Register needs, and it is why this is
-- a real table with real foreign keys rather than a list of ids inside the
-- `documents` jsonb. Ids in jsonb cannot be joined, cannot cascade, and go stale
-- silently when a drawing is deleted.
--
-- ⚠️ MANY-TO-MANY, deliberately. One RFA transmits several drawings, AND one drawing
-- is carried by several RFAs over its life — every resubmission is a new RFA for the
-- same drawing. A `rfa_id` column on drawing_register would model neither, and
-- drawing_register is also written by the importer, which knows nothing about RFAs.
--
-- ⚠️ THE ROW STORES THE REVISION IT TRANSMITTED. `drawing_register.revision` moves on;
-- what this RFA actually sent does not. Without this, a reissued drawing would make
-- every historic RFA appear to have transmitted the latest revision.
create table if not exists rfa_drawings (
  rfa_id      uuid not null references request_for_approval(id) on delete cascade,
  drawing_id  uuid not null references drawing_register(id) on delete cascade,
  revision    text,                 -- the revision AS TRANSMITTED (see above)
  pages       int,                  -- sheet count as declared on the form
  sort_order  int default 0,
  created_at  timestamptz default now(),
  primary key (rfa_id, drawing_id)
);

alter table rfa_drawings add column if not exists revision   text;
alter table rfa_drawings add column if not exists pages      int;
alter table rfa_drawings add column if not exists sort_order int default 0;

-- The reverse lookup ("which RFAs cover this drawing?") runs on this one.
create index if not exists rfa_drawings_drawing_idx on rfa_drawings (drawing_id);
create index if not exists rfa_drawings_rfa_idx     on rfa_drawings (rfa_id);

comment on table rfa_drawings is
  'Which drawings each RFA seeks approval for. Many-to-many, because one RFA '
  'transmits several drawings and every resubmission of a drawing is a new RFA. '
  'Both foreign keys cascade, so deleting either side cannot leave a dangling link.';
comment on column rfa_drawings.revision is
  'The revision AS TRANSMITTED by this RFA. drawing_register.revision moves on; what '
  'this RFA actually sent does not, so it is captured here rather than read live.';

-- ---- RLS on the link -------------------------------------------------------
-- ⚠️ THE LINK HAS NO project_id OF ITS OWN, so it cannot use can_access_project()
-- directly. Access is derived from the PARENT RFA via EXISTS — which is correct and
-- also the only option, but note it is a subquery on every row: that is why both
-- indexes above exist. Adding a denormalised project_id here would be a second
-- source of truth for which project a link belongs to, and it could disagree with
-- the RFA it points at.
alter table rfa_drawings enable row level security;

drop policy if exists rfa_drawings_read on rfa_drawings;
create policy rfa_drawings_read on rfa_drawings for select using (
  exists (select 1 from request_for_approval r
          where r.id = rfa_drawings.rfa_id and can_access_project(r.project_id)));

drop policy if exists rfa_drawings_ins on rfa_drawings;
create policy rfa_drawings_ins on rfa_drawings for insert with check (
  is_writer() and exists (select 1 from request_for_approval r
          where r.id = rfa_drawings.rfa_id and can_access_project(r.project_id)));

drop policy if exists rfa_drawings_upd on rfa_drawings;
create policy rfa_drawings_upd on rfa_drawings for update using (
  is_writer() and exists (select 1 from request_for_approval r
          where r.id = rfa_drawings.rfa_id and can_access_project(r.project_id)));

drop policy if exists rfa_drawings_del on rfa_drawings;
create policy rfa_drawings_del on rfa_drawings for delete using (
  is_writer() and exists (select 1 from request_for_approval r
          where r.id = rfa_drawings.rfa_id and can_access_project(r.project_id)));

grant select, insert, update, delete on rfa_drawings to authenticated;

-- ⚠️ NO audit trigger on the link, deliberately. engineering_audit_trg() records
-- `record_id` against a single-column primary key; this table's key is composite, so
-- the trigger would log a null id and the audit row would name nothing. The RFA
-- itself is audited, and a link change is always part of saving an RFA.

-- ---- RLS: the standard 4-policy pattern ------------------------------------
alter table request_for_approval enable row level security;

drop policy if exists rfa_read on request_for_approval;
create policy rfa_read on request_for_approval for select
  using (can_access_project(project_id));

drop policy if exists rfa_ins on request_for_approval;
create policy rfa_ins on request_for_approval for insert with check (
  is_writer() and created_by = auth.uid() and can_access_project(project_id));

drop policy if exists rfa_upd on request_for_approval;
create policy rfa_upd on request_for_approval for update
  using (is_writer() and can_access_project(project_id)
         and (created_by = auth.uid() or is_planner()))
  with check (is_writer() and can_access_project(project_id));

drop policy if exists rfa_del on request_for_approval;
create policy rfa_del on request_for_approval for delete
  using (is_writer() and can_access_project(project_id)
         and (created_by = auth.uid() or is_planner()));

grant select, insert, update, delete on request_for_approval to authenticated;

-- ---- audit trail -----------------------------------------------------------
drop trigger if exists audit_request_for_approval on request_for_approval;
create trigger audit_request_for_approval after insert or update or delete
  on request_for_approval
  for each row execute function engineering_audit_trg();

-- ---- approval authority ----------------------------------------------------
-- ⚠️ Recording that the consultant approved an RFA is a DECISION, so moving a row
-- into one of the gated statuses is restricted to is_planner() server-side, not
-- merely hidden in the UI — same reasoning as drawing_register and
-- material_submittal. No redefinition of engineering_decision_statuses() is needed
-- here; see the banner at the top of this file for why that is deliberate.
drop trigger if exists guard_decision_request_for_approval on request_for_approval;
create trigger guard_decision_request_for_approval before update of status
  on request_for_approval
  for each row execute function engineering_guard_decision();

-- ============================================================================
-- ROLLBACK
-- ----------------------------------------------------------------------------
-- drop trigger if exists guard_decision_request_for_approval on request_for_approval;
-- drop trigger if exists audit_request_for_approval on request_for_approval;
-- drop table if exists rfa_drawings;          -- before its parent
-- drop table if exists request_for_approval;
-- (engineering_decision_statuses() is untouched by this migration — nothing to restore.)
-- ============================================================================
