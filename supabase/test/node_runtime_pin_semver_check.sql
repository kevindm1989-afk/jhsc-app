-- ===========================================================================
-- M3 / G-T18-11 — pgTAP coverage for node_runtime_pin semver-shape CHECK
--
-- Exercises the constraint added by migration
-- 00000000000034_node_runtime_pin_semver_check.sql on both
-- backup_manifests.node_runtime_pin and integrity_check_runs.node_runtime_pin.
-- The constraint enforces:
--   (a) value is valid JSON parseable to an object
--   (b) object has exactly the two keys {node_version, openssl_version}
--   (c) each value matches a semver-shape regex (digit-triple prefix)
--
-- privacy-review-t18.md G-T18-PRIV-10: NOT PI but fingerprintable platform
-- metadata. The CHECK catches accidental hostname / FS path / env content
-- leaks via out-of-band writes.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(12);

-- ---------------------------------------------------------------------------
-- backup_manifests.node_runtime_pin
--
-- The full INSERT shape matches migration #020:
--   (run_id, started_at_ms, object_ref, encryption_kid, blob_sha256,
--    blob_bytes, audit_log_head_id, audit_log_head_ts_ms, audit_log_head_hash,
--    retention_sweep_runs_snapshot_ts_ms, schedule_hash, node_runtime_pin)
-- blob_sha256 must match ^[0-9a-f]{64}$ per the existing CHECK.
-- ---------------------------------------------------------------------------

-- (1) Constraint exists.
SELECT ok(
  EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conname = 'backup_manifests_node_runtime_pin_semver_check'
      AND conrelid = 'public.backup_manifests'::regclass
  ),
  'backup_manifests_node_runtime_pin_semver_check exists');

-- (2) Valid semver-shape pin is accepted.
SELECT lives_ok(
  $$INSERT INTO public.backup_manifests
      (run_id, started_at_ms, object_ref, encryption_kid, blob_sha256,
       blob_bytes, audit_log_head_id, audit_log_head_ts_ms, audit_log_head_hash,
       retention_sweep_runs_snapshot_ts_ms, schedule_hash, node_runtime_pin)
    VALUES (gen_random_uuid(), 1700000000000::bigint,
            'br_test/20231101/test.dump', 'kid_test',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            0::bigint, 1::bigint, 1700000000000::bigint, '\x00'::bytea,
            1700000000000::bigint, 'sh',
            '{"node_version":"20.0.0","openssl_version":"3.0.13"}')$$,
  'backup_manifests accepts valid semver-shape node_runtime_pin');

-- (3) Hostname-shape pin is rejected.
SELECT throws_ok(
  $$INSERT INTO public.backup_manifests
      (run_id, started_at_ms, object_ref, encryption_kid, blob_sha256,
       blob_bytes, audit_log_head_id, audit_log_head_ts_ms, audit_log_head_hash,
       retention_sweep_runs_snapshot_ts_ms, schedule_hash, node_runtime_pin)
    VALUES (gen_random_uuid(), 1700000000001::bigint,
            'br_test/20231101/test.dump', 'kid_test',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            0::bigint, 1::bigint, 1700000000000::bigint, '\x00'::bytea,
            1700000000000::bigint, 'sh',
            '{"node_version":"hostname.example.com","openssl_version":"3.0.13"}')$$,
  '23514', NULL,
  'backup_manifests rejects hostname-shape node_version');

-- (4) FS-path-shape pin is rejected.
SELECT throws_ok(
  $$INSERT INTO public.backup_manifests
      (run_id, started_at_ms, object_ref, encryption_kid, blob_sha256,
       blob_bytes, audit_log_head_id, audit_log_head_ts_ms, audit_log_head_hash,
       retention_sweep_runs_snapshot_ts_ms, schedule_hash, node_runtime_pin)
    VALUES (gen_random_uuid(), 1700000000002::bigint,
            'br_test/20231101/test.dump', 'kid_test',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            0::bigint, 1::bigint, 1700000000000::bigint, '\x00'::bytea,
            1700000000000::bigint, 'sh',
            '{"node_version":"20.0.0","openssl_version":"/usr/bin/openssl"}')$$,
  '23514', NULL,
  'backup_manifests rejects FS-path-shape openssl_version');

-- (5) Extra-key pin is rejected (no fingerprintable third field).
SELECT throws_ok(
  $$INSERT INTO public.backup_manifests
      (run_id, started_at_ms, object_ref, encryption_kid, blob_sha256,
       blob_bytes, audit_log_head_id, audit_log_head_ts_ms, audit_log_head_hash,
       retention_sweep_runs_snapshot_ts_ms, schedule_hash, node_runtime_pin)
    VALUES (gen_random_uuid(), 1700000000003::bigint,
            'br_test/20231101/test.dump', 'kid_test',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            0::bigint, 1::bigint, 1700000000000::bigint, '\x00'::bytea,
            1700000000000::bigint, 'sh',
            '{"node_version":"20.0.0","openssl_version":"3.0.13","hostname":"leaked"}')$$,
  '23514', NULL,
  'backup_manifests rejects extra-key node_runtime_pin');

-- (6) Non-JSON pin is rejected. The text-to-jsonb cast inside
-- is_valid_node_runtime_pin raises 22P02 (invalid_text_representation)
-- which we accept as the rejection mechanism — the value never lands.
SELECT throws_ok(
  $$INSERT INTO public.backup_manifests
      (run_id, started_at_ms, object_ref, encryption_kid, blob_sha256,
       blob_bytes, audit_log_head_id, audit_log_head_ts_ms, audit_log_head_hash,
       retention_sweep_runs_snapshot_ts_ms, schedule_hash, node_runtime_pin)
    VALUES (gen_random_uuid(), 1700000000004::bigint,
            'br_test/20231101/test.dump', 'kid_test',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            0::bigint, 1::bigint, 1700000000000::bigint, '\x00'::bytea,
            1700000000000::bigint, 'sh',
            'just-some-string')$$,
  '22P02', NULL,
  'backup_manifests rejects non-JSON node_runtime_pin');

-- ---------------------------------------------------------------------------
-- integrity_check_runs.node_runtime_pin (mirror constraint)
-- ---------------------------------------------------------------------------

-- (7) Constraint exists.
SELECT ok(
  EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conname = 'integrity_check_runs_node_runtime_pin_semver_check'
      AND conrelid = 'public.integrity_check_runs'::regclass
  ),
  'integrity_check_runs_node_runtime_pin_semver_check exists');

-- (8) Valid semver-shape pin is accepted.
SELECT lives_ok(
  $$INSERT INTO public.integrity_check_runs
      (run_id, trigger, started_at_ms, node_runtime_pin, schedule_hash)
    VALUES (gen_random_uuid(), 'scheduled', 1700000000000::bigint,
            '{"node_version":"20.0.0","openssl_version":"3.0.13"}', 'sh')$$,
  'integrity_check_runs accepts valid semver-shape node_runtime_pin');

-- (9) Pre-release suffix tolerated.
SELECT lives_ok(
  $$INSERT INTO public.integrity_check_runs
      (run_id, trigger, started_at_ms, node_runtime_pin, schedule_hash)
    VALUES (gen_random_uuid(), 'scheduled', 1700000000001::bigint,
            '{"node_version":"21.0.0-nightly20231003abc","openssl_version":"3.0.13+quic"}',
            'sh')$$,
  'integrity_check_runs accepts pre-release / build-metadata suffix');

-- (10) Env-content-shape pin is rejected.
SELECT throws_ok(
  $$INSERT INTO public.integrity_check_runs
      (run_id, trigger, started_at_ms, node_runtime_pin, schedule_hash)
    VALUES (gen_random_uuid(), 'scheduled', 1700000000002::bigint,
            '{"node_version":"PATH=/usr/bin","openssl_version":"3.0.13"}', 'sh')$$,
  '23514', NULL,
  'integrity_check_runs rejects env-content-shape node_version');

-- (11) Missing-key pin is rejected.
SELECT throws_ok(
  $$INSERT INTO public.integrity_check_runs
      (run_id, trigger, started_at_ms, node_runtime_pin, schedule_hash)
    VALUES (gen_random_uuid(), 'scheduled', 1700000000003::bigint,
            '{"node_version":"20.0.0"}', 'sh')$$,
  '23514', NULL,
  'integrity_check_runs rejects missing openssl_version key');

-- (12) Non-object JSON is rejected.
SELECT throws_ok(
  $$INSERT INTO public.integrity_check_runs
      (run_id, trigger, started_at_ms, node_runtime_pin, schedule_hash)
    VALUES (gen_random_uuid(), 'scheduled', 1700000000004::bigint,
            '["20.0.0","3.0.13"]', 'sh')$$,
  '23514', NULL,
  'integrity_check_runs rejects non-object JSON node_runtime_pin');

SELECT * FROM finish();
ROLLBACK;
