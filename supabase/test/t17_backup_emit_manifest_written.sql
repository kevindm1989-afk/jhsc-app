-- ===========================================================================
-- M8.A.3b / T17.1 — pgTAP coverage for backup.manifest_written event
-- type + backup_emit_manifest_written SECURITY DEFINER fn.
--
-- Source: migration 00000000000029_t17_backup_emit_manifest_written.sql.
-- Authority: ADR-0018 §"Option H"; ADR-0003 Amendment A; ADR-0015 + Amendment I.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(14);

-- (1) retention_class_for() arm.
SELECT is(public.retention_class_for('backup.manifest_written'),
  '7y', 'retention_class_for(backup.manifest_written) = 7y');

-- (2) function exists.
SELECT has_function('public', 'backup_emit_manifest_written',
  ARRAY['uuid','bigint','text','bigint','text','bigint','bigint','bytea',
        'jsonb','jsonb','bigint','text','text'],
  'backup_emit_manifest_written(...) exists');

-- (3) SECURITY DEFINER.
SELECT ok(
  (SELECT prosecdef FROM pg_proc
    WHERE proname = 'backup_emit_manifest_written'
      AND pronamespace = 'public'::regnamespace),
  'backup_emit_manifest_written is SECURITY DEFINER');

-- ---------------------------------------------------------------------------
-- Input validation — invalid inputs raise 22023.
-- ---------------------------------------------------------------------------

-- (4) invalid sha256 (wrong length).
SELECT throws_ok(
  $$SELECT public.backup_emit_manifest_written(
      '11111111-1111-1111-1111-111111111111'::uuid,
      1700000000000::bigint,
      'too_short',
      100::bigint, 'kid-v1',
      7::bigint, 1700000000000::bigint, '\xdeadbeef'::bytea,
      '{}'::jsonb, '{}'::jsonb,
      1700000000000::bigint, 'sh', 'pin')$$,
  '22023', NULL,
  'invalid sha256 raises 22023');

-- (5) negative bytes.
SELECT throws_ok(
  $$SELECT public.backup_emit_manifest_written(
      '11111111-1111-1111-1111-111111111111'::uuid,
      1700000000000::bigint,
      repeat('a', 64),
      -1::bigint, 'kid-v1',
      7::bigint, 1700000000000::bigint, '\xdeadbeef'::bytea,
      '{}'::jsonb, '{}'::jsonb,
      1700000000000::bigint, 'sh', 'pin')$$,
  '22023', NULL,
  'negative bytes raises 22023');

-- (6) empty kid.
SELECT throws_ok(
  $$SELECT public.backup_emit_manifest_written(
      '11111111-1111-1111-1111-111111111111'::uuid,
      1700000000000::bigint,
      repeat('a', 64),
      100::bigint, '',
      7::bigint, 1700000000000::bigint, '\xdeadbeef'::bytea,
      '{}'::jsonb, '{}'::jsonb,
      1700000000000::bigint, 'sh', 'pin')$$,
  '22023', NULL,
  'empty committee_data_key_kid raises 22023');

-- ---------------------------------------------------------------------------
-- Happy path — emit a valid row.
-- ---------------------------------------------------------------------------
SELECT public.backup_emit_manifest_written(
  '22222222-2222-2222-2222-222222222222'::uuid,
  1700001000000::bigint,
  repeat('a', 64),
  4096::bigint, 'kid-v1',
  7::bigint, 1700000000000::bigint, '\xdeadbeef'::bytea,
  jsonb_build_object('session.revoked', 2),
  jsonb_build_object('audit_log', 42),
  1700000000000::bigint, 'sch-hash-abc', 'node@v20'
);

-- (7) audit row exists.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE event_type = 'backup.manifest_written'
      AND meta->>'run_id' = '22222222-2222-2222-2222-222222222222'),
  1,
  'backup.manifest_written row emitted exactly once');

-- (8) retention_class is 7y on the emitted row.
SELECT is(
  (SELECT retention_class FROM public.audit_log
    WHERE event_type = 'backup.manifest_written'
      AND meta->>'run_id' = '22222222-2222-2222-2222-222222222222'),
  '7y',
  'emitted row has retention_class = 7y');

-- (9) target_id is NULL (no_target_id).
SELECT is(
  (SELECT target_id FROM public.audit_log
    WHERE event_type = 'backup.manifest_written'
      AND meta->>'run_id' = '22222222-2222-2222-2222-222222222222'),
  NULL::uuid,
  'emitted row has target_id = NULL');

-- (10) meta does NOT contain an actor_pseudonym key (G-T16-PRIV-1 / F-79).
SELECT ok(
  (SELECT NOT (meta ? 'actor_pseudonym') FROM public.audit_log
    WHERE event_type = 'backup.manifest_written'
      AND meta->>'run_id' = '22222222-2222-2222-2222-222222222222'),
  'emitted row meta does NOT contain actor_pseudonym key (F-79)');

-- (11) top-level actor_pseudonym is 16 hex chars.
SELECT ok(
  (SELECT actor_pseudonym ~ '^[0-9a-f]{16}$' FROM public.audit_log
    WHERE event_type = 'backup.manifest_written'
      AND meta->>'run_id' = '22222222-2222-2222-2222-222222222222'),
  'top-level actor_pseudonym is 16 hex chars');

-- (12) audit_log_head was composed as a structured sub-object.
SELECT is(
  (SELECT (meta->'audit_log_head'->>'id')::int FROM public.audit_log
    WHERE event_type = 'backup.manifest_written'
      AND meta->>'run_id' = '22222222-2222-2222-2222-222222222222'),
  7,
  'audit_log_head.id encoded into meta');

-- ---------------------------------------------------------------------------
-- (13)-(14) GRANT chain.
-- ---------------------------------------------------------------------------
SELECT ok(
  has_function_privilege('backup_writer_role',
    'public.backup_emit_manifest_written(uuid,bigint,text,bigint,text,bigint,bigint,bytea,jsonb,jsonb,bigint,text,text)',
    'EXECUTE'),
  'backup_writer_role has EXECUTE on backup_emit_manifest_written');

SELECT ok(
  NOT has_function_privilege('authenticated',
    'public.backup_emit_manifest_written(uuid,bigint,text,bigint,text,bigint,bigint,bytea,jsonb,jsonb,bigint,text,text)',
    'EXECUTE'),
  'authenticated has NO EXECUTE on backup_emit_manifest_written');

SELECT * FROM finish();
ROLLBACK;
