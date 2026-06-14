-- ===========================================================================
-- M8.B.2 / T18.1 — pgTAP coverage for the three new audit-log event
-- types + emit_run_and_mismatches + emit_chain_anchor_weekly.
--
-- Source: migration 00000000000027_t18_integrity_check_event_types.sql.
-- Authority: ADR-0019 §3 + §"Optional audit_chain_anchors table";
--   ADR-0003 Amendment A six-mirror enum dance; ADR-0015 + Amendment I.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(20);

-- ---------------------------------------------------------------------------
-- (1)-(3) retention_class_for() arms for the 3 new event_types.
-- ---------------------------------------------------------------------------
SELECT is(public.retention_class_for('audit.integrity_check.ran'),
  '24mo', 'retention_class_for(audit.integrity_check.ran) = 24mo');
SELECT is(public.retention_class_for('audit.integrity_check.mismatch'),
  '7y',   'retention_class_for(audit.integrity_check.mismatch) = 7y');
SELECT is(public.retention_class_for('audit.chain_anchor.weekly'),
  '7y',   'retention_class_for(audit.chain_anchor.weekly) = 7y');

-- ---------------------------------------------------------------------------
-- (4)-(5) Both new SECURITY DEFINER functions exist.
-- ---------------------------------------------------------------------------
SELECT has_function('public', 'integrity_check_emit_run_and_mismatches',
  ARRAY['uuid','bigint','text','bigint','bigint','bigint','boolean','bigint','jsonb'],
  'integrity_check_emit_run_and_mismatches(...) exists');

SELECT has_function('public', 'integrity_check_emit_chain_anchor_weekly',
  ARRAY['bigint','bigint','bigint','bytea','text'],
  'integrity_check_emit_chain_anchor_weekly(bigint,bigint,bigint,bytea,text) exists');

-- (6) Both are SECURITY DEFINER.
SELECT ok(
  (SELECT bool_and(prosecdef) FROM pg_proc
    WHERE proname IN ('integrity_check_emit_run_and_mismatches',
                      'integrity_check_emit_chain_anchor_weekly')
      AND pronamespace = 'public'::regnamespace),
  'both new emit fns are SECURITY DEFINER');

-- ---------------------------------------------------------------------------
-- emit_run_and_mismatches happy path: record_run_started + emit.
-- ---------------------------------------------------------------------------
SELECT public.integrity_check_record_run_started(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'scheduled',
  1700000000000::bigint,
  '{"node_version":"20.0.0","openssl_version":"3.0.13"}',
  'sched_hash_1'
);

-- (7) Invalid status raises 22023.
SELECT throws_ok(
  $$SELECT public.integrity_check_emit_run_and_mismatches(
      '11111111-1111-1111-1111-111111111111'::uuid,
      1700000100000::bigint,
      'not_a_status',
      100::bigint, 0::bigint, 0::bigint, false, NULL::bigint,
      '[]'::jsonb)$$,
  '22023', NULL,
  'invalid status raises 22023');

-- (8) Invalid mismatch_kind raises 22023.
SELECT throws_ok(
  $$SELECT public.integrity_check_emit_run_and_mismatches(
      '11111111-1111-1111-1111-111111111111'::uuid,
      1700000100000::bigint,
      'ok',
      100::bigint, 0::bigint, 0::bigint, false, NULL::bigint,
      jsonb_build_array(jsonb_build_object(
        'audit_log_id', 1,
        'mismatch_kind', 'not_on_set',
        'attributable', false)))$$,
  '22023', NULL,
  'invalid mismatch_kind raises 22023');

-- (9) Happy path with zero mismatches — returns bigint audit_id.
SELECT public.integrity_check_emit_run_and_mismatches(
  '11111111-1111-1111-1111-111111111111'::uuid,
  1700000100000::bigint,
  'ok',
  100::bigint, 0::bigint, 0::bigint, false, NULL::bigint,
  '[]'::jsonb
);

-- (10) integrity_check_runs row was UPDATEd to status='ok'.
SELECT is(
  (SELECT status FROM public.integrity_check_runs
    WHERE run_id = '11111111-1111-1111-1111-111111111111'::uuid),
  'ok',
  'integrity_check_runs row updated to status=ok');

-- (11) audit.integrity_check.ran row exists with matching run_id.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE event_type = 'audit.integrity_check.ran'
      AND meta->>'run_id' = '11111111-1111-1111-1111-111111111111'),
  1,
  'audit.integrity_check.ran emitted exactly once');

-- (12) That row's retention_class = '24mo' (no_target_id; safe-ceiling
-- carve-out doesn't rewrite to match_underlying because target_id is NULL).
SELECT is(
  (SELECT retention_class FROM public.audit_log
    WHERE event_type = 'audit.integrity_check.ran'
      AND meta->>'run_id' = '11111111-1111-1111-1111-111111111111'),
  '24mo',
  'audit.integrity_check.ran row written with retention_class = 24mo');

-- Happy path with two mismatches.
SELECT public.integrity_check_record_run_started(
  '22222222-2222-2222-2222-222222222222'::uuid,
  'weekly_anchor',
  1700001000000::bigint,
  '{"node_version":"20.0.0","openssl_version":"3.0.13"}',
  'sched_hash_2'
);

SELECT public.integrity_check_emit_run_and_mismatches(
  '22222222-2222-2222-2222-222222222222'::uuid,
  1700001100000::bigint,
  'mismatch_found',
  500::bigint, 1::bigint, 1::bigint, true, NULL::bigint,
  jsonb_build_array(
    jsonb_build_object(
      'audit_log_id', 42, 'mismatch_kind', 'hash_mismatch',
      'attributable', true,
      'attribution_run_id', '33333333-3333-3333-3333-333333333333'),
    jsonb_build_object(
      'audit_log_id', 43, 'mismatch_kind', 'row_missing',
      'attributable', false))
);

-- (13) mismatches_count on the run row reflects the array length.
SELECT is(
  (SELECT mismatches_count FROM public.integrity_check_runs
    WHERE run_id = '22222222-2222-2222-2222-222222222222'::uuid),
  2::bigint,
  'mismatches_count = 2 on the run row');

-- (14) Two audit.integrity_check.mismatch rows written for this run.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE event_type = 'audit.integrity_check.mismatch'
      AND meta->>'run_id' = '22222222-2222-2222-2222-222222222222'),
  2,
  'two audit.integrity_check.mismatch rows written for run 2222...');

-- (15) The mismatch retention class is 7y.
SELECT is(
  (SELECT retention_class FROM public.audit_log
    WHERE event_type = 'audit.integrity_check.mismatch'
      AND meta->>'run_id' = '22222222-2222-2222-2222-222222222222'
    LIMIT 1),
  '7y',
  'audit.integrity_check.mismatch retention_class = 7y');

-- ---------------------------------------------------------------------------
-- emit_chain_anchor_weekly happy path.
-- ---------------------------------------------------------------------------

-- (16) invalid head_hash (empty) raises 22023.
SELECT throws_ok(
  $$SELECT public.integrity_check_emit_chain_anchor_weekly(
      1700002000000::bigint, 7::bigint, 1700002000000::bigint,
      ''::bytea, 'pseudo-aaaaaaaaa')$$,
  '22023', NULL,
  'empty head_hash raises 22023');

SELECT public.integrity_check_emit_chain_anchor_weekly(
  1700002000000::bigint,
  7::bigint,
  1700002000000::bigint,
  '\x deadbeef'::bytea,
  'pseudo-aaaaaaaaa'
);

-- (17) audit_chain_anchors row inserted.
SELECT is(
  (SELECT count(*)::int FROM public.audit_chain_anchors
    WHERE head_audit_log_id = 7),
  1,
  'audit_chain_anchors row inserted for head_audit_log_id=7');

-- (18) audit.chain_anchor.weekly audit row written.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE event_type = 'audit.chain_anchor.weekly'
      AND meta->>'head_audit_log_id' = '7'),
  1,
  'audit.chain_anchor.weekly emitted for head_audit_log_id=7');

-- (19) retention_class on the chain_anchor.weekly row = 7y.
SELECT is(
  (SELECT retention_class FROM public.audit_log
    WHERE event_type = 'audit.chain_anchor.weekly'
      AND meta->>'head_audit_log_id' = '7'),
  '7y',
  'audit.chain_anchor.weekly retention_class = 7y');

-- ---------------------------------------------------------------------------
-- GRANT chain — integrity_check_role has EXECUTE on both.
-- ---------------------------------------------------------------------------
SELECT ok(
  has_function_privilege('integrity_check_role',
    'public.integrity_check_emit_run_and_mismatches(uuid,bigint,text,bigint,bigint,bigint,boolean,bigint,jsonb)',
    'EXECUTE'),
  'integrity_check_role has EXECUTE on emit_run_and_mismatches');

SELECT ok(
  has_function_privilege('integrity_check_role',
    'public.integrity_check_emit_chain_anchor_weekly(bigint,bigint,bigint,bytea,text)',
    'EXECUTE'),
  'integrity_check_role has EXECUTE on emit_chain_anchor_weekly');

SELECT * FROM finish();
ROLLBACK;
