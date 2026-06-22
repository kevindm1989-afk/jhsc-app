-- ===========================================================================
-- Phase 2a PR2 / ADR-0027 Decision 5 + P2a-6 — widen `concerns_default_view`
-- (threat-model §3.16 F-149 PI projection change).
--
-- The shape mismatch fixed here:
--   - The shipped view (migration 0004:270-279) exposes the raw `actor_id`
--     uuid to every active member — a re-identification vector (cross-
--     reference with `committee_membership`), and the production client's
--     `ConcernListRow` (apps/web/src/lib/concerns/supabase-concern-client.ts
--     :96-106) does not consume it anyway.
--   - The same shipped view does NOT expose the `actor_pseudonym` or
--     `anonymous_default_kept` projections the rendered shape needs (the
--     audit feed already carries the same pseudonym via
--     `_committee_pseudonym(actor_id)`).
--
-- This migration ADD/DROP/KEEP:
--   ADD    public._committee_pseudonym(c.actor_id) AS actor_pseudonym
--          (the canonical HMAC pseudonym used at 0004:189 + 0007:277,513).
--   ADD    (c.source_name_ct IS NULL) AS anonymous_default_kept
--          (derives from existing data; no new column on `concerns`).
--   DROP   c.actor_id from the projection — the PI fix. The raw uuid no
--          longer crosses the trust boundary; readers see ONLY the
--          pseudonym (same posture as the audit feed).
--   KEEP   has_named_source, the C1 metadata columns, the
--          session_is_live + is_active_member(auth.uid()) gate,
--          source_name_ct EXCLUDED (F-18 carry-forward).
--   KEEP   grants matrix: REVOKE PUBLIC/anon; GRANT authenticated +
--          supabase_auth_admin (mirror sibling views).
--
-- View-redefinition mechanics: PostgreSQL's `CREATE OR REPLACE VIEW` rejects
-- a column-list change (drop/rename/reorder). So this migration DROPs the
-- view first, then re-creates it with the new column set. There are no
-- other views or functions depending on this view (the production client
-- is the sole consumer, and it does NOT read `actor_id` anyway), so
-- CASCADE is unnecessary; we use plain DROP for safety.
--
-- PI-projection change (Decision 5 + threat-modeler MANDATED handoff):
-- this REDUCES PI exposure (raw uuid → pseudonym), so it is a privacy
-- improvement, not a regression. No new field is COLLECTED; a derived
-- projection changes shape. constraints.md hard rule 6 N/A.
-- ===========================================================================

DROP VIEW IF EXISTS public.concerns_default_view;

CREATE VIEW public.concerns_default_view AS
  SELECT
    c.id,
    c.title_ct,
    c.body_ct,
    c.hazard_class,
    c.severity,
    c.location_id,
    c.created_at,
    c.updated_at,
    public._committee_pseudonym(c.actor_id) AS actor_pseudonym,
    (c.source_name_ct IS NULL) AS anonymous_default_kept,
    (c.source_name_ct IS NOT NULL) AS has_named_source
  FROM public.concerns c
  WHERE public.session_is_live() AND public.is_active_member(auth.uid());

-- Grants matrix preserved (mirror migration 0004:278-279).
REVOKE ALL ON public.concerns_default_view FROM PUBLIC, anon;
GRANT SELECT ON public.concerns_default_view TO authenticated, supabase_auth_admin;

COMMENT ON VIEW public.concerns_default_view IS
  'Phase 2a PR2 (ADR-0027 Decision 5 / migration 0039): exposes actor_pseudonym '
  'and anonymous_default_kept; raw actor_id DROPPED from the projection '
  '(F-149 PI fix). source_name_ct remains EXCLUDED (F-18 reveal-only).';
