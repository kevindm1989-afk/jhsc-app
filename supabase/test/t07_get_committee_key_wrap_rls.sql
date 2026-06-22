-- ===========================================================================
-- Phase 2a PR1 — pgTAP: get_committee_key_wrap_for_self()  (ADR-0027
-- Decision 2; threat-model §3.16 F-142 + F-151).  RED-FIRST (TDD): written
-- against a migration that does NOT exist yet (expected:
-- supabase/migrations/00000000000038_t07_get_committee_key_wrap.sql).
-- Until the implementer lands that migration these tests FAIL at the first
-- reference to the function (undefined function). The implementer treats
-- this file as READ-ONLY.
--
-- The function under test is the FIRST production RPC that returns committee
-- key material (a sealed wrap) across the browser ↔ t07-op trust boundary,
-- shared by Phase 2b/2c/2d. Its contract (mirroring committee_key_state_for_self
-- at migration 0037 for gating, and reveal_concern_source at migration
-- 0004:317-330 for audit-before-return):
--
--   CREATE FUNCTION public.get_committee_key_wrap_for_self()
--     RETURNS TABLE(key_id uuid, epoch integer, wrapped_ciphertext bytea)
--     SECURITY DEFINER, SET search_path=public, extensions
--     gates on _t07_gate_active_member()
--     REVOKE EXECUTE FROM PUBLIC, anon, service_role
--     GRANT  EXECUTE TO   authenticated, supabase_auth_admin
--     reads ONLY  WHERE user_id = auth.uid() AND <live key (rotated_at IS NULL)>
--     emits committee_data_key.unwrap (audit-BEFORE-return, one txn) BEFORE
--     the RETURN QUERY of the ciphertext.
--
-- It takes NO id parameter (own-wrap-only is structural — no IDOR surface).
--
-- Run: pg_prove -d <db> supabase/test/t07_get_committee_key_wrap_rls.sql
--   (migrations 0..38 + the test shim).  NOTE: this cannot run locally
--   without Postgres — it runs in CI.
--
-- TEST → AC / FINDING MAP
--   F-142 (AC-10) — own-wrap-only: A gets A's wrap, NEVER B's (structural).
--   F-142 (AC-10) — no id parameter (own-wrap-only is structural, not a check).
--   F-142 (AC-10) — REVOKE matrix: PUBLIC/anon/service_role denied; GRANT
--                   authenticated + supabase_auth_admin.
--   F-142 (AC-10) — active-member gate: a non-member call raises rls_denied.
--   F-142         — live-key-only: with a retired + a live wrap, returns ONLY
--                   the live (rotated_at IS NULL) wrap, never the retired one.
--   F-151 (AC-10) — audit-before-return: committee_data_key.unwrap committed
--                   (present in-txn) when the ciphertext returns; exactly one
--                   row per call (fused emit, no double-count).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(16);

-- --------------------------------------------------------------------------
-- Seed: two active members (A, B), one non-member (X), synthetic sessions.
-- --------------------------------------------------------------------------
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000a1', true),   -- A (active member)
  ('00000000-0000-0000-0000-0000000000b2', true),   -- B (active member)
  ('00000000-0000-0000-0000-0000000000c3', true);   -- X (NOT a member)
INSERT INTO public.committee_membership (user_id, role, active, activated_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1', ARRAY['worker_member'], true, now()),
  ('00000000-0000-0000-0000-0000000000b2', ARRAY['worker_member'], true, now());
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111a1', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111b2', '00000000-0000-0000-0000-0000000000b2', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111c3', '00000000-0000-0000-0000-0000000000c3', now() + interval '5 min');

-- A live key (epoch 2) and a RETIRED key (epoch 1, rotated_at set). The
-- function must return ONLY the live-key wrap.
INSERT INTO public.committee_data_keys (key_id, epoch, rotated_at) VALUES
  ('22222222-2222-2222-2222-222222222201', 1, now()),     -- retired
  ('22222222-2222-2222-2222-222222222202', 2, NULL);      -- live

-- Wraps:
--   A holds a wrap under BOTH the retired and the live key.
--   B holds a wrap under the live key (distinct bytes → distinguishable).
-- The wrap bytes are opaque sealed ciphertext; we use recognizable byte
-- patterns so the assertions can tell A's live wrap from A's retired wrap and
-- from B's wrap.
INSERT INTO public.committee_key_wraps (user_id, key_id, wrapped_ciphertext) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '22222222-2222-2222-2222-222222222201', '\xAA01'::bytea),  -- A retired
  ('00000000-0000-0000-0000-0000000000a1', '22222222-2222-2222-2222-222222222202', '\xAA02'::bytea),  -- A live
  ('00000000-0000-0000-0000-0000000000b2', '22222222-2222-2222-2222-222222222202', '\xBB02'::bytea);  -- B live

-- --------------------------------------------------------------------------
-- (1)-(2) F-142 structural: NO id parameter (own-wrap-only is structural).
-- The function exists, is SECURITY DEFINER, and takes zero arguments.
-- --------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_committee_key_wrap_for_self'
      AND p.pronargs = 0),
  1,
  'F-142: get_committee_key_wrap_for_self takes NO arguments (own-wrap-only is structural — no IDOR)');
SELECT is(
  (SELECT p.prosecdef FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_committee_key_wrap_for_self'),
  true,
  'F-142: get_committee_key_wrap_for_self is SECURITY DEFINER');

-- --------------------------------------------------------------------------
-- (3)-(4) F-142 REVOKE matrix + grants (mirror committee_key_state_for_self).
-- Uses has_function_privilege (the canonical codebase idiom, e.g.
-- t18_watchdog_read_fn.sql:90, t16_retention_ceiling_rule.sql:127) which —
-- unlike information_schema.role_routine_grants — meaningfully resolves the
-- PUBLIC default-grant. anon / service_role must NOT hold EXECUTE; the two
-- production roles must.
-- --------------------------------------------------------------------------
SELECT ok(
  NOT has_function_privilege('anon', 'public.get_committee_key_wrap_for_self()', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.get_committee_key_wrap_for_self()', 'EXECUTE'),
  'F-142: EXECUTE is REVOKED from anon + service_role (PUBLIC default not inherited)');
SELECT ok(
  has_function_privilege('authenticated', 'public.get_committee_key_wrap_for_self()', 'EXECUTE')
  AND has_function_privilege('supabase_auth_admin', 'public.get_committee_key_wrap_for_self()', 'EXECUTE'),
  'F-142: EXECUTE is GRANTED to authenticated + supabase_auth_admin');

-- --------------------------------------------------------------------------
-- (5) F-142 active-member gate — a non-member (X) call raises rls_denied.
-- --------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c3","session_id":"11111111-1111-1111-1111-1111111111c3","role":"authenticated"}';
SELECT throws_like(
  $$SELECT * FROM public.get_committee_key_wrap_for_self()$$,
  '%rls_denied%',
  'F-142: a non-member call raises rls_denied (_t07_gate_active_member)');

-- --------------------------------------------------------------------------
-- (6) F-116 carry-forward — no session → rls_denied.
-- --------------------------------------------------------------------------
SET request.jwt.claims = '{}';
SELECT throws_like(
  $$SELECT * FROM public.get_committee_key_wrap_for_self()$$,
  '%rls_denied%',
  'F-116: no session → rls_denied');

-- --------------------------------------------------------------------------
-- (7)-(10) F-142 own-wrap-only + live-key-only — A gets A's LIVE wrap.
-- --------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
SELECT is(
  (SELECT key_id FROM public.get_committee_key_wrap_for_self() LIMIT 1),
  '22222222-2222-2222-2222-222222222202'::uuid,
  'F-142: A receives the LIVE key_id (rotated_at IS NULL), never the retired one');
SELECT is(
  (SELECT epoch FROM public.get_committee_key_wrap_for_self() LIMIT 1),
  2,
  'F-142: A receives the live epoch (2), not the retired epoch (1)');
SELECT is(
  (SELECT wrapped_ciphertext FROM public.get_committee_key_wrap_for_self() LIMIT 1),
  '\xAA02'::bytea,
  'F-142: A receives A''s OWN live wrap bytes (\xAA02), never B''s (\xBB02) and never A''s retired (\xAA01)');
SELECT is(
  (SELECT count(*)::int FROM public.get_committee_key_wrap_for_self()),
  1,
  'F-142: exactly ONE row returned — the live wrap only (not the retired one too)');

-- --------------------------------------------------------------------------
-- (11) F-142 own-wrap-only — B's call returns B's wrap, NEVER A's.
-- --------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","session_id":"11111111-1111-1111-1111-1111111111b2","role":"authenticated"}';
SELECT is(
  (SELECT wrapped_ciphertext FROM public.get_committee_key_wrap_for_self() LIMIT 1),
  '\xBB02'::bytea,
  'F-142: B receives B''s OWN live wrap (\xBB02), structurally CANNOT receive A''s (\xAA02)');

-- --------------------------------------------------------------------------
-- (12) F-142 no-wrap actor — a live key exists but a member without a wrap
-- gets ZERO rows (not an error). Add member D with no wrap.
-- --------------------------------------------------------------------------
INSERT INTO public.users (id, active) VALUES ('00000000-0000-0000-0000-0000000000d4', true);
INSERT INTO public.committee_membership (user_id, role, active, activated_at) VALUES
  ('00000000-0000-0000-0000-0000000000d4', ARRAY['worker_member'], true, now());
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111d4', '00000000-0000-0000-0000-0000000000d4', now() + interval '5 min');
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d4","session_id":"11111111-1111-1111-1111-1111111111d4","role":"authenticated"}';
SELECT is(
  (SELECT count(*)::int FROM public.get_committee_key_wrap_for_self()),
  0,
  'F-142/F-144: a member with no wrap gets ZERO rows (no error → client maps to no_wrap)');

-- --------------------------------------------------------------------------
-- (13)-(16) F-151 audit-BEFORE-return — the committee_data_key.unwrap row is
-- committed in the SAME txn as (before) the ciphertext returns. Mirror the
-- reveal_concern_source audit-before-return pgTAP pattern (concerns_rls.sql
-- :124-126). The key encoding of "before return, one txn": after a single
-- call, the audit row for the caller is ALREADY present with EXACTLY one row;
-- a second call emits a SECOND row (fused per-call emit, no suppression).
-- --------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
-- Establish the pre-call baseline for A.
CREATE TEMP TABLE _unwrap_base AS
  SELECT count(*)::int AS n FROM public.audit_log
   WHERE event_type = 'committee_data_key.unwrap'
     AND meta->>'committee_key_id' = '22222222-2222-2222-2222-222222222202';

-- Drain the function (force the RETURN QUERY to execute) and assert the
-- ciphertext came back …
SELECT is(
  (SELECT wrapped_ciphertext FROM public.get_committee_key_wrap_for_self() LIMIT 1),
  '\xAA02'::bytea,
  'F-151: the call returns A''s live wrap ciphertext');
-- … AND in the SAME transaction the audit row is already present (committed
-- before the bytes left the function — there is no path that returns the
-- ciphertext without first emitting the audit row).
SELECT ok(
  EXISTS(SELECT 1 FROM public.audit_log
          WHERE event_type = 'committee_data_key.unwrap'
            AND meta->>'committee_key_id' = '22222222-2222-2222-2222-222222222202'),
  'F-151: committee_data_key.unwrap audit row is present once the ciphertext has returned (audit-before-return, one txn)');
-- Exactly ONE new row was emitted by the single call (fused emit — not zero,
-- not double-counted by a legacy second record_unwrap call).
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE event_type = 'committee_data_key.unwrap'
      AND meta->>'committee_key_id' = '22222222-2222-2222-2222-222222222202')
    - (SELECT n FROM _unwrap_base),
  1,
  'F-151: exactly ONE committee_data_key.unwrap row per call (the fused RPC, no double-count)');
-- The audit row carries the caller's pseudonym, NEVER raw key material.
SELECT is(
  (SELECT actor_pseudonym FROM public.audit_log
    WHERE event_type = 'committee_data_key.unwrap'
      AND meta->>'committee_key_id' = '22222222-2222-2222-2222-222222222202'
    ORDER BY id DESC LIMIT 1),
  public._committee_pseudonym('00000000-0000-0000-0000-0000000000a1'),
  'F-151: the unwrap audit row carries the caller pseudonym (no raw key bytes / raw actor_id)');

SELECT * FROM finish();
ROLLBACK;
