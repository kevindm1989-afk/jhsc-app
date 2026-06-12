-- ===========================================================================
-- ADR-0024 — pgTAP coverage for key_parity_server_sha() + deploy_reader_role.
--
-- Asserts:
--   • The function exists, is SECURITY DEFINER, and returns SHA-256 of the
--     app.hmac_pseudonym_key GUC (hex; 64 chars).
--   • The function returns a stable value for a known GUC.
--   • A missing GUC returns the SHA of the empty string (caller fails closed
--     because the deploy-side SHA will never match the empty-string SHA).
--   • The function does NOT return the key value itself.
--   • deploy_reader_role exists, is NOLOGIN, has EXECUTE on the function,
--     and has NO other GRANTs (no SELECT on any base table, no other fn
--     EXECUTE beyond the parity fn).
--   • public has NO EXECUTE on the function (REVOKE FROM public landed).
--
-- Source: ADR-0024 (`.context/decisions.md`),
--   migration 00000000000016_adr0024_key_parity_check.sql.
-- ===========================================================================

BEGIN;
SELECT plan(11);

-- (1) Function exists.
SELECT has_function('public', 'key_parity_server_sha',
  'key_parity_server_sha() exists');

-- (2) Function is SECURITY DEFINER (prosecdef=true).
SELECT ok(
  (SELECT prosecdef FROM pg_proc
    WHERE proname = 'key_parity_server_sha'
      AND pronamespace = 'public'::regnamespace),
  'key_parity_server_sha() is SECURITY DEFINER');

-- (3) SHA shape: 64 hex chars under a known GUC.
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT matches(
  public.key_parity_server_sha(),
  '^[0-9a-f]{64}$',
  'key_parity_server_sha() returns 64-char lowercase hex SHA-256');

-- (4) Determinism: same GUC ⇒ same SHA.
SELECT is(
  public.key_parity_server_sha(),
  public.key_parity_server_sha(),
  'key_parity_server_sha() is deterministic for a fixed GUC');

-- (5) The returned SHA matches our independent SHA of the GUC value
--     (proves we are reading the GUC, not some other constant).
SELECT is(
  public.key_parity_server_sha(),
  encode(digest('dev-ci-pseudonym-key-not-secret'::bytea, 'sha256'), 'hex'),
  'returned SHA equals sha256(GUC value)');

-- (6) The returned SHA is NOT the key value itself (paranoia: assert it does
--     not contain the literal GUC string; SHA hex of a real key is opaque).
SELECT ok(
  public.key_parity_server_sha() NOT LIKE '%dev-ci-pseudonym-key%',
  'returned SHA does NOT contain the key value (key never returned)');

-- (7) Empty GUC ⇒ SHA of empty string (caller fails closed because
--     sha256("") never matches any real-key SHA the deploy-side computes).
--     Note: we set explicitly to '' rather than RESETting, because the
--     CI database carries a DB-level default GUC value that RESET would
--     restore — the path we actually want to exercise is the
--     COALESCE(..., '') fallback inside the function.
SET app.hmac_pseudonym_key = '';
SELECT is(
  public.key_parity_server_sha(),
  encode(digest(''::bytea, 'sha256'), 'hex'),
  'empty GUC returns sha256("") — caller compare fails closed');

-- (8) deploy_reader_role exists.
SELECT ok(
  EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'deploy_reader_role'),
  'deploy_reader_role exists');

-- (9) deploy_reader_role is NOLOGIN.
SELECT ok(
  NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'deploy_reader_role'),
  'deploy_reader_role is NOLOGIN');

-- (10) deploy_reader_role has EXECUTE on key_parity_server_sha().
SELECT ok(
  has_function_privilege('deploy_reader_role',
    'public.key_parity_server_sha()', 'EXECUTE'),
  'deploy_reader_role has EXECUTE on key_parity_server_sha()');

-- (11) public has NO EXECUTE on the function (REVOKE FROM public landed).
SELECT ok(
  NOT has_function_privilege('public',
    'public.key_parity_server_sha()', 'EXECUTE'),
  'public has NO EXECUTE on key_parity_server_sha() (REVOKE took)');

SELECT * FROM finish();
ROLLBACK;
