-- ===========================================================================
-- ADR-0025 — pgTAP coverage for the bootstrap-first-co-chair surface.
--
-- (1) Six-mirror dance: retention_class_for arm for the NEW
--     `auth.passkey.enroll_failed` event (90d, sibling of enrolled/revoked).
-- (2) Bootstrap-challenges table + issue/consume single-use + binding.
-- (3) Bootstrap_first_co_chair one-shot guard race + reachability invariants.
-- (4) Cross-action isolation: a mint-issued challenge does NOT satisfy
--     bootstrap_consume_challenge, and vice versa.
--
-- Source: ADR-0025 (`.context/decisions.md`),
--   migration 00000000000035_bootstrap_first_co_chair.sql,
--   migration 00000000000036_bootstrap_challenges.sql.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(14);

-- ---------------------------------------------------------------------------
-- (1) Six-mirror dance — retention_class_for arm.
-- ---------------------------------------------------------------------------
SELECT is(public.retention_class_for('auth.passkey.enroll_failed'),
          '90d',
          'ADR-0025 C11: auth.passkey.enroll_failed → 90d (sibling of enrolled/revoked)');

-- Regression: sibling arms still as before.
SELECT is(public.retention_class_for('auth.passkey.enrolled'),
          '90d',
          'regression: auth.passkey.enrolled → 90d (sibling spot-check)');

SELECT is(public.retention_class_for('auth.passkey.revoked'),
          '90d',
          'regression: auth.passkey.revoked → 90d (sibling spot-check)');

-- ---------------------------------------------------------------------------
-- (2) Bootstrap-challenges single-use + binding.
-- ---------------------------------------------------------------------------

-- TTL clamp: pass an absurd ttl, table must store ≤ 120s window.
SELECT lives_ok(
  $$ SELECT public.bootstrap_issue_challenge('example.com', 'https://example.com', 99999) $$,
  'bootstrap_issue_challenge: TTL clamp accepts large input'
);

SELECT is(
  (SELECT max(expires_at) <= now() + interval '121 seconds' FROM public.bootstrap_challenges),
  true,
  'bootstrap_issue_challenge: clamps TTL to ≤120s even when caller passes more'
);

-- Single-use: consume returns the rp_id+origin once, then nothing.
DO $$
DECLARE c text;
BEGIN
  c := public.bootstrap_issue_challenge('example.com', 'https://example.com', 60);
  PERFORM set_config('test.ch', c, false);
END $$;

SELECT results_eq(
  $$ SELECT rp_id, origin FROM public.bootstrap_consume_challenge(current_setting('test.ch')) $$,
  $$ VALUES ('example.com'::text, 'https://example.com'::text) $$,
  'bootstrap_consume_challenge: first consume returns the issuance (rp_id, origin)'
);

SELECT is(
  (SELECT count(*)::int FROM public.bootstrap_consume_challenge(current_setting('test.ch'))),
  0,
  'bootstrap_consume_challenge: second consume of the same challenge returns no row (single-use)'
);

-- Expired challenge: same posture as consumed. NOTE: pgTAP wraps the file in
-- a single transaction, which freezes `now()` at txn-start; `pg_sleep` does
-- NOT move the `expires_at > now()` comparison window, so we backdate
-- `expires_at` directly. (In production each RPC is its own statement and the
-- TTL clamp suffices.)
DO $$
DECLARE c text;
BEGIN
  c := public.bootstrap_issue_challenge('example.com', 'https://example.com', 60);
  UPDATE public.bootstrap_challenges
     SET expires_at = now() - interval '1 second'
   WHERE challenge = c;
  PERFORM set_config('test.expired', c, false);
END $$;
SELECT is(
  (SELECT count(*)::int FROM public.bootstrap_consume_challenge(current_setting('test.expired'))),
  0,
  'bootstrap_consume_challenge: expired challenge returns no row'
);

-- ---------------------------------------------------------------------------
-- (3) Cross-action isolation — register-challenges and mint-challenges live in
--     DIFFERENT tables (C2), so neither path can consume the other's row.
-- ---------------------------------------------------------------------------
DO $$
DECLARE c text;
BEGIN
  c := public.mint_issue_challenge('example.com', 'https://example.com', 60);
  PERFORM set_config('test.mint_ch', c, false);
END $$;

SELECT is(
  (SELECT count(*)::int FROM public.bootstrap_consume_challenge(current_setting('test.mint_ch'))),
  0,
  'C2: a mint-issued challenge does NOT satisfy bootstrap_consume_challenge'
);

DO $$
DECLARE c text;
BEGIN
  c := public.bootstrap_issue_challenge('example.com', 'https://example.com', 60);
  PERFORM set_config('test.boot_ch', c, false);
END $$;

SELECT is(
  public.mint_consume_challenge(current_setting('test.boot_ch')),
  false,
  'C2: a bootstrap-issued challenge does NOT satisfy mint_consume_challenge'
);

-- ---------------------------------------------------------------------------
-- (4) Reachability invariants — bootstrap_first_co_chair + bootstrap_*_challenge
--     are mint_writer-only; UNREACHABLE by anon/authenticated/service_role.
-- ---------------------------------------------------------------------------
SELECT is(
  has_function_privilege('anon', 'public.bootstrap_first_co_chair(text, bytea, uuid, text[], text, text)', 'EXECUTE'),
  false,
  'C2: anon cannot EXECUTE bootstrap_first_co_chair (REST-unreachable)'
);

SELECT is(
  has_function_privilege('authenticated', 'public.bootstrap_first_co_chair(text, bytea, uuid, text[], text, text)', 'EXECUTE'),
  false,
  'C2: authenticated cannot EXECUTE bootstrap_first_co_chair (REST-unreachable)'
);

SELECT is(
  has_function_privilege('service_role', 'public.bootstrap_first_co_chair(text, bytea, uuid, text[], text, text)', 'EXECUTE'),
  false,
  'C2: service_role cannot EXECUTE bootstrap_first_co_chair (closed-set guarantee)'
);

SELECT is(
  has_function_privilege('mint_writer', 'public.bootstrap_first_co_chair(text, bytea, uuid, text[], text, text)', 'EXECUTE'),
  true,
  'C2: mint_writer CAN EXECUTE bootstrap_first_co_chair (the sole grant target)'
);

SELECT * FROM finish();
ROLLBACK;
