-- ===========================================================================
-- M8.A.3d / T17.1 — pgTAP coverage for backup.hard_deleted event type +
-- backup_emit_hard_deleted SECURITY DEFINER fn.
--
-- Source: migration 00000000000031_t17_backup_emit_hard_deleted.sql.
-- Authority: ADR-0018 §J + §"Option H"; ADR-0003 Amendment A.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(12);

-- (1) retention_class_for arm.
SELECT is(public.retention_class_for('backup.hard_deleted'),
  '7y', 'retention_class_for(backup.hard_deleted) = 7y');

-- (2) function exists.
SELECT has_function('public', 'backup_emit_hard_deleted',
  ARRAY['uuid','text','bigint','bigint'],
  'backup_emit_hard_deleted(uuid,text,bigint,bigint) exists');

-- (3) SECURITY DEFINER.
SELECT ok(
  (SELECT prosecdef FROM pg_proc
    WHERE proname = 'backup_emit_hard_deleted'
      AND pronamespace = 'public'::regnamespace),
  'backup_emit_hard_deleted is SECURITY DEFINER');

-- (4) empty object_ref raises 22023.
SELECT throws_ok(
  $$SELECT public.backup_emit_hard_deleted(
      '11111111-1111-1111-1111-111111111111'::uuid,
      '', 1700000000000::bigint, 1699000000000::bigint)$$,
  '22023', NULL,
  'empty object_ref raises 22023');

-- (5) negative hard_deleted_at_ms raises 22023.
SELECT throws_ok(
  $$SELECT public.backup_emit_hard_deleted(
      '11111111-1111-1111-1111-111111111111'::uuid,
      'backups/x', -1::bigint, 1699000000000::bigint)$$,
  '22023', NULL,
  'negative hard_deleted_at_ms raises 22023');

-- (6) hard_deleted_at_ms < original_committed_at_ms raises 22023.
SELECT throws_ok(
  $$SELECT public.backup_emit_hard_deleted(
      '11111111-1111-1111-1111-111111111111'::uuid,
      'backups/x', 1699000000000::bigint, 1700000000000::bigint)$$,
  '22023', NULL,
  'hard_deleted_at_ms < original_committed_at_ms raises 22023');

-- Happy path.
SELECT public.backup_emit_hard_deleted(
  '22222222-2222-2222-2222-222222222222'::uuid,
  'backups/2026/06/13/run-2.bin',
  1700000000000::bigint + 42::bigint * 86400000,
  1700000000000::bigint
);

-- (7) audit row exists.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE event_type = 'backup.hard_deleted'
      AND meta->>'run_id' = '22222222-2222-2222-2222-222222222222'),
  1,
  'backup.hard_deleted row emitted exactly once');

-- (8) retention_class = 7y.
SELECT is(
  (SELECT retention_class FROM public.audit_log
    WHERE event_type = 'backup.hard_deleted'
      AND meta->>'run_id' = '22222222-2222-2222-2222-222222222222'),
  '7y',
  'emitted row retention_class = 7y');

-- (9) target_id NULL.
SELECT is(
  (SELECT target_id FROM public.audit_log
    WHERE event_type = 'backup.hard_deleted'
      AND meta->>'run_id' = '22222222-2222-2222-2222-222222222222'),
  NULL::uuid,
  'emitted row target_id = NULL');

-- (10) F-79: meta does NOT contain actor_pseudonym.
SELECT ok(
  (SELECT NOT (meta ? 'actor_pseudonym') FROM public.audit_log
    WHERE event_type = 'backup.hard_deleted'
      AND meta->>'run_id' = '22222222-2222-2222-2222-222222222222'),
  'emitted row meta does NOT contain actor_pseudonym (F-79)');

-- (11) GRANT chain — backup_writer_role.
SELECT ok(
  has_function_privilege('backup_writer_role',
    'public.backup_emit_hard_deleted(uuid,text,bigint,bigint)', 'EXECUTE'),
  'backup_writer_role has EXECUTE on backup_emit_hard_deleted');

-- (12) authenticated has NO EXECUTE.
SELECT ok(
  NOT has_function_privilege('authenticated',
    'public.backup_emit_hard_deleted(uuid,text,bigint,bigint)', 'EXECUTE'),
  'authenticated has NO EXECUTE on backup_emit_hard_deleted');

SELECT * FROM finish();
ROLLBACK;
