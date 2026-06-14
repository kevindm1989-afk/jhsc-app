-- ===========================================================================
-- M8.A.1 / T17.1 — pgTAP coverage for backup pipeline SECURITY DEFINER fns.
--
-- Source: migration 00000000000024_t17_backup_functions.sql.
-- Authority: ADR-0018 §4 (T17 backup library function set).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
-- 18 named asserts + 1 RETURNS-record row from backup_extract_head_pointer
-- + 1 RETURNS-row from backup_count_rows_in_allowlist + emit chain rows
-- counted by pg_prove. Set plan to actual run count.
-- pg_prove counts RETURNS-record / RETURNS-row from extracted-record
-- functions invoked elsewhere; plan budget set to actual run count.
SELECT plan(19);

-- (1)-(6) functions exist + SECURITY DEFINER.
SELECT has_function('public', 'backup_extract_head_pointer', ARRAY[]::name[],
  'backup_extract_head_pointer() exists');
SELECT has_function('public', 'backup_count_rows_in_allowlist',
  ARRAY['text[]'], 'backup_count_rows_in_allowlist(text[]) exists');
SELECT has_function('public', 'backup_write_manifest_pending',
  ARRAY['uuid','bigint','text','text','bigint','text','bigint','bigint','bytea',
        'jsonb','jsonb','bigint','text','text'],
  'backup_write_manifest_pending(...) exists');
SELECT has_function('public', 'backup_transition_manifest_status',
  ARRAY['uuid','text','bigint'],
  'backup_transition_manifest_status(uuid, text, bigint) exists');
SELECT has_function('public', 'backup_list_manifests_older_than_ms',
  ARRAY['bigint'],
  'backup_list_manifests_older_than_ms(bigint) exists');
SELECT has_function('public', 'backup_has_open_run_within_window',
  ARRAY['bigint','bigint'],
  'backup_has_open_run_within_window(bigint, bigint) exists');

-- (7) all 6 are SECURITY DEFINER.
SELECT ok(
  (SELECT bool_and(prosecdef) FROM pg_proc
    WHERE proname IN ('backup_extract_head_pointer',
                      'backup_count_rows_in_allowlist',
                      'backup_write_manifest_pending',
                      'backup_transition_manifest_status',
                      'backup_list_manifests_older_than_ms',
                      'backup_has_open_run_within_window')
      AND pronamespace = 'public'::regnamespace),
  'all 6 backup functions are SECURITY DEFINER');

-- (8) backup_count_rows_in_allowlist returns a jsonb shape with the
--     expected keys when given a known table list.
INSERT INTO public.audit_log
  (event_type, actor_pseudonym, target_class, severity, retention_class, ts)
VALUES ('session.revoked', 'p0000000000000a1', 'C0', 'info', '90d', now());

SELECT is(
  (public.backup_count_rows_in_allowlist(
    ARRAY['audit_log','retention_sweep_runs']::text[]
  ) ->> 'audit_log')::int,
  1,
  'count_rows_in_allowlist returns audit_log row count = 1');

-- (9) Unknown table name raises 22023.
SELECT throws_ok(
  $$SELECT public.backup_count_rows_in_allowlist(ARRAY['not_on_allowlist']::text[])$$,
  '22023', NULL,
  'unknown table name in p_tables raises 22023');

-- (10) write_manifest_pending followed by a SELECT shows the row.
SELECT public.backup_write_manifest_pending(
  '11111111-1111-1111-1111-111111111111'::uuid,
  1700000000000::bigint,
  'bucket://backups-ca-central-1/run-11111111.tar.gz.enc',
  repeat('a', 64),
  4096::bigint,
  'cdk_kid_42',
  100::bigint, 1700000000000::bigint, '\x00'::bytea,
  '{}'::jsonb, '{}'::jsonb,
  1699999900000::bigint, 'sha256:hh', 'node@v20'
);

SELECT is(
  (SELECT manifest_status FROM public.backup_manifests
    WHERE run_id = '11111111-1111-1111-1111-111111111111'::uuid),
  'pending',
  'write_manifest_pending sets manifest_status = pending');

-- (11) transition pending -> committed succeeds; committed_at_ms +
--      object_lock_until_ms are set.
SELECT public.backup_transition_manifest_status(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'committed',
  1700000200000::bigint
);

SELECT is(
  (SELECT manifest_status FROM public.backup_manifests
    WHERE run_id = '11111111-1111-1111-1111-111111111111'::uuid),
  'committed',
  'transition pending -> committed succeeds');

SELECT is(
  (SELECT object_lock_until_ms FROM public.backup_manifests
    WHERE run_id = '11111111-1111-1111-1111-111111111111'::uuid),
  (1700000200000::bigint + 42::bigint * 24 * 60 * 60 * 1000),
  'object_lock_until_ms = committed_at_ms + 42 days');

-- (12) transition pending -> hard_deleted is rejected (invalid).
SELECT public.backup_write_manifest_pending(
  '22222222-2222-2222-2222-222222222222'::uuid,
  1700001000000::bigint, 'b', repeat('b', 64), 1::bigint, 'k',
  1::bigint, 1::bigint, '\x00'::bytea, '{}'::jsonb, '{}'::jsonb,
  1::bigint, 'h', '{"node_version":"20.0.0","openssl_version":"3.0.13"}'
);

SELECT throws_ok(
  $$SELECT public.backup_transition_manifest_status(
      '22222222-2222-2222-2222-222222222222'::uuid,
      'hard_deleted', 1700001200000::bigint)$$,
  '22023', NULL,
  'invalid transition pending -> hard_deleted raises 22023');

-- (13) transition committed -> hard_deleted succeeds (uses row 1).
SELECT public.backup_transition_manifest_status(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'hard_deleted',
  1700000500000::bigint
);

SELECT is(
  (SELECT manifest_status FROM public.backup_manifests
    WHERE run_id = '11111111-1111-1111-1111-111111111111'::uuid),
  'hard_deleted',
  'transition committed -> hard_deleted succeeds');

-- (14) transition for unknown run_id raises 22023.
SELECT throws_ok(
  $$SELECT public.backup_transition_manifest_status(
      gen_random_uuid(), 'committed', 0::bigint)$$,
  '22023', NULL,
  'transition for unknown run_id raises 22023');

-- (15) list_manifests_older_than_ms: we expect 0 because the only
--      committed row was already moved to hard_deleted above.
SELECT is(
  (SELECT count(*)::int FROM public.backup_list_manifests_older_than_ms(99999999999999::bigint)),
  0,
  'list_manifests_older_than_ms returns 0 (no rows remain in committed state)');

-- (16) has_open_run_within_window: row 1's started_at_ms = 1700000000000.
--      now=1700000100000, window=1000000 → started_at_ms > now - window
--      = 1699999100000. 1700000000000 > that → true.
SELECT ok(
  public.backup_has_open_run_within_window(1700000100000::bigint, 1000000::bigint),
  'has_open_run_within_window returns true when a recent run exists');

-- (17) has_open_run_within_window: now=1800000000000, window=1000 →
--      threshold ≈ 1799999999000; no row has started_at_ms > that → false.
SELECT ok(
  NOT public.backup_has_open_run_within_window(1800000000000::bigint, 1000::bigint),
  'has_open_run_within_window returns false when no recent run');

-- (18) GRANT chain — backup_writer_role has EXECUTE on the head-pointer fn;
--      authenticated does NOT.
SELECT ok(
  has_function_privilege('backup_writer_role',
    'public.backup_extract_head_pointer()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.backup_extract_head_pointer()', 'EXECUTE'),
  'GRANT chain: backup_writer_role has EXECUTE, authenticated does not');

SELECT * FROM finish();
ROLLBACK;
