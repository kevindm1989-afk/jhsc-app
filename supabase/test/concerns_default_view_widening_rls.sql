-- ===========================================================================
-- Phase 2a PR2 / P2a-6 — pgTAP: concerns_default_view widening (ADR-0027
-- Decision 5; threat-model §3.16 F-149 PI projection change).
--
-- RED-FIRST (TDD). Written against a migration that does NOT exist yet —
-- the implementer adds a NEW migration (next number after 0038, expected
-- 00000000000039_*.sql) that REDEFINES `public.concerns_default_view`:
--
--   ADD     public._committee_pseudonym(c.actor_id) AS actor_pseudonym
--   ADD     (c.source_name_ct IS NULL) AS anonymous_default_kept
--   DROP    raw c.actor_id from the projection (the PI fix)
--   KEEP    has_named_source, the existing C1 metadata columns, and the
--           session_is_live + is_active_member(auth.uid()) gate
--   KEEP    source_name_ct EXCLUDED from the default view (F-18 carry-forward)
--   KEEP    grants matrix (REVOKE PUBLIC/anon; GRANT authenticated + supabase_auth_admin)
--
-- The implementer treats this file as READ-ONLY.
--
-- Conventions: mirrors `supabase/test/concerns_rls.sql` (the existing pgTAP
-- harness for `concerns`) for seeding + JWT-claims shape. Uses
-- `_committee_pseudonym` (the canonical HMAC pseudonym helper used at
-- `00000000000004_concerns.sql:189,253`, `00000000000007_t07.sql:277,513`).
--
-- Run: pg_prove -d <db> supabase/test/concerns_default_view_widening_rls.sql
--   (migrations 0..39 + the test shim). CI-only.
--
-- TEST → AC / FINDING MAP
--   F-149 (AC-2)   — column set: actor_id ABSENT; actor_pseudonym +
--                    anonymous_default_kept + has_named_source PRESENT;
--                    source_name_ct still ABSENT (F-18 carry-forward).
--   F-149 (AC-2)   — actor_pseudonym EQUALS _committee_pseudonym(actor_id)
--                    (no cross-surface correlation regression vs the audit
--                    feed).
--   F-149          — anonymous_default_kept derives from source_name_ct IS NULL
--                    (true for anonymous, false for named).
--   F-18           — direct SELECT on `concerns` still denied to
--                    authenticated/anon (reads go via the view).
--   F-15 / F-30    — a second active member can read the widened view
--                    (still gated on session_is_live + is_active_member).
--   F-149          — grants matrix preserved: REVOKE PUBLIC/anon;
--                    GRANT authenticated, supabase_auth_admin.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(13);

-- Two active members (A, B) + one removed member (C) + synthetic sessions.
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000a1', true),   -- A (active)
  ('00000000-0000-0000-0000-0000000000b2', true),   -- B (active)
  ('00000000-0000-0000-0000-0000000000c3', true);   -- C (removed)
INSERT INTO public.committee_membership (user_id, role, active, activated_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1', ARRAY['worker_member'], true,  now()),
  ('00000000-0000-0000-0000-0000000000b2', ARRAY['worker_member'], true,  now()),
  ('00000000-0000-0000-0000-0000000000c3', ARRAY['worker_member'], false, now());
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111a1', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111b2', '00000000-0000-0000-0000-0000000000b2', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111c3', '00000000-0000-0000-0000-0000000000c3', now() + interval '5 min');

-- Seed two concerns as A: one anonymous, one named (with passphrase).
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
CREATE TEMP TABLE _c AS
  SELECT 'anon'::text AS tag,
         public.concern_submit('\x01'::bytea, '\x02'::bytea, 'physical', 'low',  'L-1', true) AS id;
INSERT INTO _c SELECT 'named',
  public.concern_submit('\x0A'::bytea, '\xAA'::bytea, 'chemical', 'high', 'L-2', false,
                        '\xCAFEBABE'::bytea, 'open-sesame');

-- --------------------------------------------------------------------------
-- (1) F-149 — raw actor_id is STRUCTURALLY ABSENT from the widened view.
-- --------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.columns
     WHERE table_schema='public' AND table_name='concerns_default_view'
       AND column_name='actor_id'$$,
  $$VALUES (0)$$,
  'F-149: raw actor_id is DROPPED from concerns_default_view (PI projection change)');

-- --------------------------------------------------------------------------
-- (2) F-149 — actor_pseudonym is present on the projection.
-- --------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.columns
     WHERE table_schema='public' AND table_name='concerns_default_view'
       AND column_name='actor_pseudonym'$$,
  $$VALUES (1)$$,
  'F-149: actor_pseudonym column is present in concerns_default_view');

-- --------------------------------------------------------------------------
-- (3) F-149 — anonymous_default_kept is present on the projection.
-- --------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.columns
     WHERE table_schema='public' AND table_name='concerns_default_view'
       AND column_name='anonymous_default_kept'$$,
  $$VALUES (1)$$,
  'F-149: anonymous_default_kept column is present in concerns_default_view');

-- --------------------------------------------------------------------------
-- (4) F-18 carry-forward — source_name_ct is STILL absent.
-- --------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.columns
     WHERE table_schema='public' AND table_name='concerns_default_view'
       AND column_name='source_name_ct'$$,
  $$VALUES (0)$$,
  'F-18 carry-forward: source_name_ct is still ABSENT from the default view');

-- --------------------------------------------------------------------------
-- (5) F-18 carry-forward — has_named_source is still present.
-- --------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.columns
     WHERE table_schema='public' AND table_name='concerns_default_view'
       AND column_name='has_named_source'$$,
  $$VALUES (1)$$,
  'F-18 carry-forward: has_named_source remains in the projection');

-- --------------------------------------------------------------------------
-- (6) F-149 — the pseudonym in the view EQUALS _committee_pseudonym(actor_id)
-- (no cross-surface correlation regression vs the audit feed at :189).
-- --------------------------------------------------------------------------
SELECT is(
  (SELECT actor_pseudonym FROM public.concerns_default_view WHERE id=(SELECT id FROM _c WHERE tag='anon')),
  public._committee_pseudonym('00000000-0000-0000-0000-0000000000a1'::uuid),
  'F-149: actor_pseudonym = _committee_pseudonym(actor_id) on the anonymous row (matches the audit feed)');

SELECT is(
  (SELECT actor_pseudonym FROM public.concerns_default_view WHERE id=(SELECT id FROM _c WHERE tag='named')),
  public._committee_pseudonym('00000000-0000-0000-0000-0000000000a1'::uuid),
  'F-149: actor_pseudonym = _committee_pseudonym(actor_id) on the named row');

-- --------------------------------------------------------------------------
-- (7) F-149 — anonymous_default_kept derives from source_name_ct IS NULL.
-- --------------------------------------------------------------------------
SELECT ok(
  (SELECT anonymous_default_kept FROM public.concerns_default_view WHERE id=(SELECT id FROM _c WHERE tag='anon')),
  'F-149: anonymous concern (source_name_ct IS NULL) → anonymous_default_kept TRUE');

SELECT ok(
  NOT (SELECT anonymous_default_kept FROM public.concerns_default_view WHERE id=(SELECT id FROM _c WHERE tag='named')),
  'F-149: named concern (source_name_ct IS NOT NULL) → anonymous_default_kept FALSE');

-- --------------------------------------------------------------------------
-- (8) F-15 carry-forward — a second active member (B) can read the widened
-- view and sees rows submitted by A.
-- --------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","session_id":"11111111-1111-1111-1111-1111111111b2","role":"authenticated"}';
SELECT cmp_ok(
  (SELECT count(*)::int FROM public.concerns_default_view),
  '>=',
  2,
  'F-15 carry-forward: a second active member can read the widened concerns_default_view');

-- --------------------------------------------------------------------------
-- (9) F-15 / F-30 carry-forward — a removed member (C) sees NO rows.
-- The view's WHERE clause gates on is_active_member(auth.uid()).
-- --------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c3","session_id":"11111111-1111-1111-1111-1111111111c3","role":"authenticated"}';
SELECT is(
  (SELECT count(*)::int FROM public.concerns_default_view),
  0,
  'F-30 carry-forward: a removed member sees zero rows through the widened view');

-- --------------------------------------------------------------------------
-- (10) F-18 — direct SELECT on the base `concerns` table is STILL denied
-- to authenticated/anon (reads continue to go through the view).
-- --------------------------------------------------------------------------
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.role_table_grants
     WHERE table_name='concerns' AND grantee IN ('authenticated','anon')
       AND privilege_type='SELECT'$$,
  $$VALUES (0)$$,
  'F-18: direct SELECT on `concerns` still denied to authenticated/anon');

-- --------------------------------------------------------------------------
-- (11) F-149 — view grants matrix preserved on the redefined view:
-- REVOKE PUBLIC/anon; GRANT authenticated + supabase_auth_admin.
-- --------------------------------------------------------------------------
SELECT ok(
  has_table_privilege('authenticated', 'public.concerns_default_view', 'SELECT')
  AND has_table_privilege('supabase_auth_admin', 'public.concerns_default_view', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.concerns_default_view', 'SELECT'),
  'F-149: grants matrix preserved (authenticated + supabase_auth_admin SELECT; anon denied)');

SELECT * FROM finish();
ROLLBACK;
