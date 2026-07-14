-- ===========================================================================
-- F182-1 — pgTAP: get_all_committee_key_wraps_for_self() + the partial-UNIQUE
-- live-key index  (ADR-0030 Decision 6; threat-model §3.18 Amendment A-8.10,
-- finding F-183 — the anti-lockout keystone).  RED-FIRST (TDD): written
-- against a migration that does NOT exist yet (expected: a new
-- supabase/migrations/000000000000NN_t07_get_all_committee_key_wraps.sql that
-- (a) creates the SETOF RPC and (b) adds the partial-UNIQUE live-key index).
-- Until the implementer lands that migration these tests FAIL — pg_prove
-- BAILS at the first reference to the not-yet-existing function
-- (has_function_privilege on an undefined function raises), exactly as the
-- sibling t07_get_committee_key_wrap_rls.sql documents. The implementer
-- treats this file as READ-ONLY.
--
-- CONTRACT UNDER TEST (mirrors get_committee_key_wrap_for_self, migration
-- 0038, for gating / REVOKE / GRANT / audit-before-return; generalizes the
-- SINGLE live-only row to the MULTI-epoch SETOF):
--
--   CREATE FUNCTION public.get_all_committee_key_wraps_for_self()
--     RETURNS TABLE(key_id uuid, epoch integer,
--                   wrapped_ciphertext bytea, is_live boolean)   -- SETOF
--     SECURITY DEFINER, SET search_path = public, extensions
--     gates on _t07_gate_active_member()   (session_is_live + active member)
--     REVOKE EXECUTE FROM PUBLIC, anon, service_role
--     GRANT  EXECUTE TO   authenticated, supabase_auth_admin
--     reads committee_key_wraps ONLY (NEVER committee_key_wraps_history),
--       WHERE w.user_id = auth.uid()   -- NO parameter, no IDOR (F-183 (i))
--     is_live = true ⇔ the wrap's key is the committee's live key
--       (committee_data_keys.rotated_at IS NULL); retired rows is_live=false
--     emits committee_data_key.unwrap audit-BEFORE-return, one row per DISTINCT
--       key materialized (threat-model F-183 "audit posture pinned"); the meta
--       carries the key_id, NEVER raw key bytes (F-148 carry-forward).
--
-- It takes NO id parameter (own-wrap-only is structural — no IDOR surface),
-- exactly like get_committee_key_wrap_for_self.
--
-- Also under test — the substrate hardening the threat-modeler pinned as
-- re-pass trigger #7: committee_data_keys today carries a NON-UNIQUE partial
-- index (00000000000007_t07.sql:166-167). F182-1 replaces/augments it with a
-- partial UNIQUE index enforcing "exactly one live key" AT THE DB LEVEL
-- (WHERE rotated_at IS NULL) so a second live row is impossible — removing the
-- is_live/seal-target ambiguity F-183 (iv) warns about.
--
-- Run: pg_prove -d <db> supabase/test/committee_key_wraps_all.sql
--   (migrations 0..NN + the test shim).  NOTE: this cannot run locally
--   without Postgres — it runs in CI.
--
-- TEST → FINDING / ASSERTION MAP (threat-model §3.18 F-183)
--   F-183 (i)   own-wrap-only / no-IDOR — NO parameter; A sees only A's wraps,
--               never B's; a caller cannot widen scope (no id to abuse).
--   F-183       all epochs returned, retired INCLUDED — the anti-lockout
--               property (a caller keeps reading pre-rotation data).
--   F-183       exactly-one-is_live — precisely ONE returned row is the live
--               key; retired rows is_live=false; a retired-only holder gets
--               NO is_live row (client → holding state).
--   F-183 (i)   no-history-read — the forensic archive committee_key_wraps_
--               history is NEVER a member-read path (behavioral + source-scan).
--   F-183       gate — a non-live session / inactive member → rls_denied
--               (byte-identical to migration 0038's denial).
--   F-183       grants — REVOKE PUBLIC/anon/service_role; GRANT authenticated
--               + supabase_auth_admin (has_function_privilege matrix).
--   F-148       audit posture — one committee_data_key.unwrap per distinct key
--               materialized (not zero), caller pseudonym, no raw key bytes.
--   F-183 (iv)  partial-UNIQUE live-key index — a SECOND live committee_data_
--               keys row is rejected by the DB (23505), retired rows unbounded.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(24);

-- --------------------------------------------------------------------------
-- Seed:
--   A (a1) — active member; holds wraps under BOTH the retired (epoch 1) and
--            the live (epoch 2) key → the multi-epoch happy path.
--   B (b2) — active member; holds ONLY the live wrap (distinct bytes) → the
--            cross-member no-IDOR probe.
--   X (c3) — active USER but NOT a committee member → the gate-denial probe.
--   E (e5) — active member; holds ONLY a RETIRED-epoch wrap → the "no is_live
--            row / holding state" edge (mid-window before a fresh grant).
--   F (f6) — active member; holds ONLY a committee_key_wraps_HISTORY row (an
--            archived, purged wrap) and NO live-table wrap → the no-history-
--            read probe (the forensic archive must not surface).
-- --------------------------------------------------------------------------
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000a1', true),   -- A (active member)
  ('00000000-0000-0000-0000-0000000000b2', true),   -- B (active member)
  ('00000000-0000-0000-0000-0000000000c3', true),   -- X (NOT a member)
  ('00000000-0000-0000-0000-0000000000e5', true),   -- E (retired-only)
  ('00000000-0000-0000-0000-0000000000f6', true);   -- F (history-only)
INSERT INTO public.committee_membership (user_id, role, active, activated_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1', ARRAY['worker_member'], true, now()),
  ('00000000-0000-0000-0000-0000000000b2', ARRAY['worker_member'], true, now()),
  ('00000000-0000-0000-0000-0000000000e5', ARRAY['worker_member'], true, now()),
  ('00000000-0000-0000-0000-0000000000f6', ARRAY['worker_member'], true, now());
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111a1', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111b2', '00000000-0000-0000-0000-0000000000b2', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111c3', '00000000-0000-0000-0000-0000000000c3', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111e5', '00000000-0000-0000-0000-0000000000e5', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111f6', '00000000-0000-0000-0000-0000000000f6', now() + interval '5 min');

-- One RETIRED key (epoch 1, rotated_at set) and one LIVE key (epoch 2). The
-- SETOF must return retired AND live for a caller who holds both.
INSERT INTO public.committee_data_keys (key_id, epoch, rotated_at) VALUES
  ('22222222-2222-2222-2222-222222222201', 1, now()),     -- retired
  ('22222222-2222-2222-2222-222222222202', 2, NULL);      -- live

-- Wraps in the LIVE table. Recognizable byte patterns so an assertion can tell
-- A's live wrap from A's retired wrap from B's wrap.
INSERT INTO public.committee_key_wraps (user_id, key_id, wrapped_ciphertext) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '22222222-2222-2222-2222-222222222201', '\xAA01'::bytea),  -- A retired
  ('00000000-0000-0000-0000-0000000000a1', '22222222-2222-2222-2222-222222222202', '\xAA02'::bytea),  -- A live
  ('00000000-0000-0000-0000-0000000000b2', '22222222-2222-2222-2222-222222222202', '\xBB02'::bytea),  -- B live
  ('00000000-0000-0000-0000-0000000000e5', '22222222-2222-2222-2222-222222222201', '\xEE01'::bytea);  -- E retired-only

-- F's wrap exists ONLY in the forensic archive (archived+purged), NOT in the
-- live table. A correct implementation reads committee_key_wraps only, so F
-- must get ZERO rows — the archive is never a member-read path.
INSERT INTO public.committee_key_wraps_history (user_id, key_id, wrapped_ciphertext, reason) VALUES
  ('00000000-0000-0000-0000-0000000000f6', '22222222-2222-2222-2222-222222222201', '\xFF01'::bytea, 'member_revoked');

-- ==========================================================================
-- (1)-(2) F-183 (i) structural: NO id parameter + SECURITY DEFINER.
-- Own-wrap-only is STRUCTURAL — a function with zero args has no id to abuse.
-- ==========================================================================
SELECT is(
  (SELECT count(*)::int FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_all_committee_key_wraps_for_self'
      AND p.pronargs = 0),
  1,
  'F-183: get_all_committee_key_wraps_for_self takes NO arguments (own-wrap-only is structural — no IDOR, cannot be widened by a forged/other uid)');
SELECT is(
  (SELECT p.prosecdef FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_all_committee_key_wraps_for_self'),
  true,
  'F-183: get_all_committee_key_wraps_for_self is SECURITY DEFINER (mirrors migration 0038)');

-- ==========================================================================
-- (3)-(4) F-183 grants — REVOKE matrix + GRANT set (mirror migration 0038).
-- has_function_privilege meaningfully resolves the PUBLIC default-grant:
-- anon / service_role must NOT hold EXECUTE (so PUBLIC is not inherited); the
-- two production roles must.
-- ==========================================================================
SELECT ok(
  NOT has_function_privilege('anon', 'public.get_all_committee_key_wraps_for_self()', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.get_all_committee_key_wraps_for_self()', 'EXECUTE'),
  'F-183: EXECUTE is REVOKED from anon + service_role (PUBLIC default not inherited)');
SELECT ok(
  has_function_privilege('authenticated', 'public.get_all_committee_key_wraps_for_self()', 'EXECUTE')
  AND has_function_privilege('supabase_auth_admin', 'public.get_all_committee_key_wraps_for_self()', 'EXECUTE'),
  'F-183: EXECUTE is GRANTED to authenticated + supabase_auth_admin');

-- ==========================================================================
-- (5)-(6) F-183 gate — non-member + no-session → rls_denied (byte-identical to
-- migration 0038's _t07_gate_active_member denial). Defense-in-depth: the gate
-- blocks a removed/inactive member from reading their own retained wrap even
-- BEFORE the purge runs.
-- ==========================================================================
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c3","session_id":"11111111-1111-1111-1111-1111111111c3","role":"authenticated"}';
SELECT throws_like(
  $$SELECT * FROM public.get_all_committee_key_wraps_for_self()$$,
  '%rls_denied%',
  'F-183: a non-member (active user, no committee_membership) call raises rls_denied (_t07_gate_active_member)');
SET request.jwt.claims = '{}';
SELECT throws_like(
  $$SELECT * FROM public.get_all_committee_key_wraps_for_self()$$,
  '%rls_denied%',
  'F-183: no live session → rls_denied (session_is_live gate)');

-- ==========================================================================
-- (7)-(9) F-183 (i) own-wrap-only — A sees ONLY A's wraps; B sees ONLY B's.
-- ==========================================================================
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
SELECT is(
  (SELECT count(*)::int FROM public.get_all_committee_key_wraps_for_self()
     WHERE wrapped_ciphertext = '\xAA02'::bytea),
  1,
  'F-183: A receives A''s OWN live wrap bytes (\xAA02)');
SELECT is(
  (SELECT count(*)::int FROM public.get_all_committee_key_wraps_for_self()
     WHERE wrapped_ciphertext IN ('\xBB02'::bytea)),
  0,
  'F-183 (no-IDOR): A''s result set NEVER contains B''s wrap (\xBB02) — structurally auth.uid()-scoped');
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","session_id":"11111111-1111-1111-1111-1111111111b2","role":"authenticated"}';
SELECT ok(
  (SELECT count(*)::int FROM public.get_all_committee_key_wraps_for_self()
     WHERE wrapped_ciphertext = '\xBB02'::bytea) = 1
  AND
  (SELECT count(*)::int FROM public.get_all_committee_key_wraps_for_self()
     WHERE wrapped_ciphertext IN ('\xAA01'::bytea, '\xAA02'::bytea)) = 0,
  'F-183 (no-IDOR): B receives B''s OWN wrap (\xBB02) and structurally CANNOT receive A''s (\xAA01/\xAA02)');

-- ==========================================================================
-- (10)-(11) F-183 all-epochs / retired INCLUDED — the anti-lockout property.
-- A holds wraps on {retired epoch 1, live epoch 2} → the SETOF returns BOTH.
-- ==========================================================================
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
SELECT is(
  (SELECT count(*)::int FROM public.get_all_committee_key_wraps_for_self()),
  2,
  'F-183 (anti-lockout): A receives BOTH epochs (retired + live) — 2 rows, not just the live key');
SELECT is(
  (SELECT array_agg(epoch ORDER BY epoch)::int[] FROM public.get_all_committee_key_wraps_for_self()),
  ARRAY[1, 2]::int[],
  'F-183 (anti-lockout): A''s rows cover the retired epoch 1 AND the live epoch 2 (retired NOT excluded)');

-- ==========================================================================
-- (12)-(14) F-183 exactly-one-is_live — precisely ONE returned row is live.
-- ==========================================================================
SELECT is(
  (SELECT count(*)::int FROM public.get_all_committee_key_wraps_for_self() WHERE is_live),
  1,
  'F-183: EXACTLY ONE returned row has is_live=true (the committee''s single live key)');
SELECT is(
  (SELECT key_id FROM public.get_all_committee_key_wraps_for_self() WHERE is_live LIMIT 1),
  '22222222-2222-2222-2222-222222222202'::uuid,
  'F-183: the is_live=true row is the LIVE key (rotated_at IS NULL, key2 / epoch 2), never the retired key');
SELECT is(
  (SELECT is_live FROM public.get_all_committee_key_wraps_for_self() WHERE epoch = 1),
  false,
  'F-183: the RETIRED-epoch row (epoch 1) has is_live=false');

-- ==========================================================================
-- (15) F-183 exactly-one-is_live EDGE — a retired-ONLY holder gets NO is_live
-- row (is_live=true appears on no row → client routes to the holding state)
-- yet the retired wrap is still returned (anti-lockout on historical data).
-- ==========================================================================
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000e5","session_id":"11111111-1111-1111-1111-1111111111e5","role":"authenticated"}';
SELECT ok(
  (SELECT count(*)::int FROM public.get_all_committee_key_wraps_for_self() WHERE is_live) = 0
  AND
  (SELECT count(*)::int FROM public.get_all_committee_key_wraps_for_self()) = 1,
  'F-183: a retired-ONLY holder gets NO is_live=true row (holding state) but STILL receives the retired wrap (1 row)');

-- ==========================================================================
-- (16)-(18) F-183 (i) no-history-read — the forensic archive is never a
-- member-read path. (16) behavioral: F holds ONLY a committee_key_wraps_history
-- row → ZERO rows. (17)-(18) source-scan: the function body references NEITHER
-- committee_key_wraps_history NOR any other user's id — only auth.uid().
-- ==========================================================================
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f6","session_id":"11111111-1111-1111-1111-1111111111f6","role":"authenticated"}';
SELECT is(
  (SELECT count(*)::int FROM public.get_all_committee_key_wraps_for_self()),
  0,
  'F-183 (no-history-read): a member whose ONLY wrap is archived in committee_key_wraps_history gets ZERO rows (history is never read)');
SELECT ok(
  (SELECT position('committee_key_wraps_history' IN pg_get_functiondef(p.oid)) = 0
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_all_committee_key_wraps_for_self'),
  'F-183 (no-history-read, source-scan): the function body NEVER references committee_key_wraps_history');
SELECT ok(
  (SELECT position('auth.uid()' IN pg_get_functiondef(p.oid)) > 0
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_all_committee_key_wraps_for_self'),
  'F-183 (own-wrap-only, source-scan): the function body scopes reads to auth.uid()');

-- ==========================================================================
-- (19)-(21) F-148 audit posture — audit-BEFORE-return, ONE committee_data_key.
-- unwrap per DISTINCT key materialized (not zero — a multi-epoch unwrap is
-- still an unwrap event), caller pseudonym, NO raw key bytes in meta.
-- Delta-from-baseline so prior in-txn calls by A do not skew the count.
-- ==========================================================================
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
CREATE TEMP TABLE _audit_base AS
  SELECT count(*)::int AS n FROM public.audit_log
   WHERE event_type = 'committee_data_key.unwrap'
     AND actor_pseudonym = public._committee_pseudonym('00000000-0000-0000-0000-0000000000a1');
-- One measured invocation (materialized once → the body runs once).
CREATE TEMP TABLE _measured AS
  SELECT * FROM public.get_all_committee_key_wraps_for_self();
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
     WHERE event_type = 'committee_data_key.unwrap'
       AND actor_pseudonym = public._committee_pseudonym('00000000-0000-0000-0000-0000000000a1'))
    - (SELECT n FROM _audit_base),
  2,
  'F-148: the single multi-epoch call emits exactly ONE committee_data_key.unwrap per DISTINCT key materialized (2 keys → 2 rows, audit-before-return, not zero)');
SELECT is(
  (SELECT count(DISTINCT meta->>'committee_key_id')::int FROM public.audit_log
     WHERE event_type = 'committee_data_key.unwrap'
       AND actor_pseudonym = public._committee_pseudonym('00000000-0000-0000-0000-0000000000a1')),
  2,
  'F-148: the unwrap rows carry the two DISTINCT committee_key_id uuids in meta (the key ids, never raw wrap bytes)');
SELECT ok(
  NOT EXISTS(
    SELECT 1 FROM public.audit_log
     WHERE event_type = 'committee_data_key.unwrap'
       AND actor_pseudonym = public._committee_pseudonym('00000000-0000-0000-0000-0000000000a1')
       AND (meta::text ILIKE '%aa01%' OR meta::text ILIKE '%aa02%')),
  'F-148: NO raw wrap ciphertext bytes (\xAA01/\xAA02) appear in any unwrap audit meta (no key material in the audit trail)');

-- ==========================================================================
-- (22)-(24) F-183 (iv) partial-UNIQUE live-key index — "exactly one live key"
-- is now DB-ENFORCED, not procedural. (22) structural: a partial UNIQUE index
-- exists on committee_data_keys. (23) behavioral: a SECOND live row
-- (rotated_at IS NULL) is rejected with 23505. (24) the predicate correctly
-- excludes retired rows — multiple retired rows are fine.
-- ==========================================================================
SELECT ok(
  EXISTS(
    SELECT 1 FROM pg_index i
      JOIN pg_class c  ON c.oid  = i.indrelid
    WHERE c.relname = 'committee_data_keys'
      AND i.indisunique          -- UNIQUE (today's committee_data_keys_active_idx is NOT)
      AND i.indpred IS NOT NULL   -- partial (WHERE rotated_at IS NULL)
  ),
  'F-183 (iv): a PARTIAL UNIQUE index exists on committee_data_keys (one-live-key is DB-enforced, not procedural)');
-- The seed already holds exactly one live key (epoch 2). A second live row with
-- a fresh, non-colliding epoch can only fail on the new partial-UNIQUE-live
-- index (epoch 3 does not collide with the epoch UNIQUE constraint).
SELECT throws_ok(
  $$INSERT INTO public.committee_data_keys (key_id, epoch, rotated_at)
      VALUES ('22222222-2222-2222-2222-222222222203', 3, NULL)$$,
  '23505', NULL,
  'F-183 (iv): inserting a SECOND live (rotated_at IS NULL) committee_data_keys row is rejected by the partial-UNIQUE index (23505)');
SELECT lives_ok(
  $$INSERT INTO public.committee_data_keys (key_id, epoch, rotated_at)
      VALUES ('22222222-2222-2222-2222-222222222204', 4, now())$$,
  'F-183 (iv): the index predicate excludes retired rows — a second RETIRED (rotated_at set) row inserts cleanly');

SELECT * FROM finish();
ROLLBACK;
