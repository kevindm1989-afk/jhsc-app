-- ===========================================================================
-- M8.A.3c (partial) / T17.1 — pgTAP coverage for backup_dump_table_rows.
--
-- Source: migration 00000000000032_t17_backup_dump_table_rows.sql.
-- Authority: ADR-0018 §"BACKUP_TABLES allowlist" + §4; threat-model §6 B6.1.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(10);

-- (1) function exists.
SELECT has_function('public', 'backup_dump_table_rows', ARRAY['text'],
  'backup_dump_table_rows(text) exists');

-- (2) SECURITY DEFINER.
SELECT ok(
  (SELECT prosecdef FROM pg_proc
    WHERE proname = 'backup_dump_table_rows'
      AND pronamespace = 'public'::regnamespace),
  'backup_dump_table_rows is SECURITY DEFINER');

-- (3) STABLE.
SELECT is(
  (SELECT provolatile FROM pg_proc
    WHERE proname = 'backup_dump_table_rows'
      AND pronamespace = 'public'::regnamespace),
  's'::"char",
  'backup_dump_table_rows is STABLE');

-- (4) Unknown table -> 22023.
SELECT throws_ok(
  $$SELECT public.backup_dump_table_rows('not_an_allowed_table')$$,
  '22023', NULL,
  'unknown table raises 22023');

-- (5) Empty table returns []::jsonb.
SELECT is(
  public.backup_dump_table_rows('audit_log_retention_schedule'),
  (SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb)
     FROM public.audit_log_retention_schedule t),
  'audit_log_retention_schedule dump matches direct SELECT');

-- Seed an audit_log row.
INSERT INTO public.audit_log
  (event_type, actor_pseudonym, target_class, severity, retention_class, ts)
VALUES
  ('session.revoked', 'p0000000000099a1', 'C0', 'info', '90d', now());

-- (6) audit_log dump is a non-empty array.
SELECT ok(
  jsonb_typeof(public.backup_dump_table_rows('audit_log')) = 'array',
  'audit_log dump is a jsonb array');

SELECT ok(
  jsonb_array_length(public.backup_dump_table_rows('audit_log')) = 1,
  'audit_log dump has 1 element after the seed insert');

-- (7) Round-trip: every row in audit_log is in the dump.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log),
  jsonb_array_length(public.backup_dump_table_rows('audit_log')),
  'audit_log dump length matches table row count');

-- (8)-(9) GRANT chain.
SELECT ok(
  has_function_privilege('backup_writer_role',
    'public.backup_dump_table_rows(text)', 'EXECUTE'),
  'backup_writer_role has EXECUTE on backup_dump_table_rows');

SELECT ok(
  NOT has_function_privilege('authenticated',
    'public.backup_dump_table_rows(text)', 'EXECUTE'),
  'authenticated has NO EXECUTE on backup_dump_table_rows');

SELECT * FROM finish();
ROLLBACK;
