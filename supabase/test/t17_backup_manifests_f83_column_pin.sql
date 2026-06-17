-- ===========================================================================
-- M3 / G-T17-PRIV-8 — formal F-83 column-name pin for backup_manifests.
--
-- The library has F-83 snapshot-pin on the BackupManifest field shape
-- (audit_log_head_{id,ts_ms,hash}, per_event_row_counts,
-- retention_sweep_runs_snapshot_ts_ms, schedule_hash, node_runtime_pin).
-- T17.1's SQL backup_manifests table mirrors those names; the IMPLICIT
-- pin is the existing pgTAP suite's INSERTs (t17_backup_writer_role.sql
-- :34-60, t17_backup_read_functions.sql:119, t18_integrity_check_*.sql
-- — a rename in the DDL fails every INSERT in CI).
--
-- This file adds the EXPLICIT pin: `has_column` + `col_type_is` for
-- every column on backup_manifests, anchored on the exact migration
-- (`#020` t17_backup_writer_role.sql:60-90) that creates the table.
-- The privacy reviewer's load-bearing concern is the F-83 anchor
-- subset (the 7 names above) — those get the strongest assertion
-- shape (`columns_are` on the full set + per-column `col_type_is`).
-- The other 7 columns also pin (run_id PK, status state-machine,
-- timestamps, blob bytes/sha256, etc.) so an unintended schema-shape
-- drift is caught at lint time, not at runtime.
--
-- Source: privacy-review-t17.md G-T17-PRIV-8; ADR-0018 §7 (manifest
-- field-set is the audit anchor for T18's reconciliation join).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(16);

-- ---------------------------------------------------------------------------
-- columns_are — assert the EXACT column set, no surprise additions.
-- A new column landing on backup_manifests without updating this test +
-- the privacy review is a structural change that wants explicit ratification.
-- ---------------------------------------------------------------------------
SELECT columns_are(
  'public', 'backup_manifests',
  ARRAY[
    'run_id',
    'started_at_ms',
    'committed_at_ms',
    'object_ref',
    'blob_sha256',
    'blob_bytes',
    'encryption_kid',
    'audit_log_head_id',
    'audit_log_head_ts_ms',
    'audit_log_head_hash',
    'per_event_row_counts',
    'per_table_row_counts',
    'retention_sweep_runs_snapshot_ts_ms',
    'schedule_hash',
    'node_runtime_pin',
    'manifest_status',
    'object_lock_until_ms',
    'hard_deleted_at_ms',
    'created_at'
  ],
  'G-T17-PRIV-8: backup_manifests columns_are pinned (any addition/rename/removal trips this)');

-- ---------------------------------------------------------------------------
-- col_type_is — per-column type pin for the F-83 anchor subset (the 7
-- field names the library snapshot-pins). A type drift on any one of
-- these would silently break T18's reconciliation join semantics.
-- ---------------------------------------------------------------------------
SELECT col_type_is('public', 'backup_manifests', 'audit_log_head_id', 'bigint',
  'G-T17-PRIV-8 F-83 anchor: audit_log_head_id is bigint');
SELECT col_type_is('public', 'backup_manifests', 'audit_log_head_ts_ms', 'bigint',
  'G-T17-PRIV-8 F-83 anchor: audit_log_head_ts_ms is bigint');
SELECT col_type_is('public', 'backup_manifests', 'audit_log_head_hash', 'bytea',
  'G-T17-PRIV-8 F-83 anchor: audit_log_head_hash is bytea');
SELECT col_type_is('public', 'backup_manifests', 'per_event_row_counts', 'jsonb',
  'G-T17-PRIV-8 F-83 anchor: per_event_row_counts is jsonb');
SELECT col_type_is('public', 'backup_manifests', 'retention_sweep_runs_snapshot_ts_ms', 'bigint',
  'G-T17-PRIV-8 F-83 anchor: retention_sweep_runs_snapshot_ts_ms is bigint');
SELECT col_type_is('public', 'backup_manifests', 'schedule_hash', 'text',
  'G-T17-PRIV-8 F-83 anchor: schedule_hash is text');
SELECT col_type_is('public', 'backup_manifests', 'node_runtime_pin', 'text',
  'G-T17-PRIV-8 F-83 anchor: node_runtime_pin is text');

-- ---------------------------------------------------------------------------
-- col_type_is — per-column type pin for the surrounding structural
-- fields (state machine, key/object refs, timestamps). Strictly stronger
-- than the F-83 subset; catches drift on the surrounding shape too.
-- ---------------------------------------------------------------------------
SELECT col_type_is('public', 'backup_manifests', 'run_id', 'uuid',
  'G-T17-PRIV-8: run_id is uuid');
SELECT col_type_is('public', 'backup_manifests', 'started_at_ms', 'bigint',
  'G-T17-PRIV-8: started_at_ms is bigint');
SELECT col_type_is('public', 'backup_manifests', 'committed_at_ms', 'bigint',
  'G-T17-PRIV-8: committed_at_ms is bigint (nullable)');
SELECT col_type_is('public', 'backup_manifests', 'object_ref', 'text',
  'G-T17-PRIV-8: object_ref is text');
SELECT col_type_is('public', 'backup_manifests', 'blob_sha256', 'text',
  'G-T17-PRIV-8: blob_sha256 is text (CHECK enforces ^[0-9a-f]{64}$)');
SELECT col_type_is('public', 'backup_manifests', 'blob_bytes', 'bigint',
  'G-T17-PRIV-8: blob_bytes is bigint');
SELECT col_type_is('public', 'backup_manifests', 'encryption_kid', 'text',
  'G-T17-PRIV-8: encryption_kid is text');
SELECT col_type_is('public', 'backup_manifests', 'manifest_status', 'text',
  'G-T17-PRIV-8: manifest_status is text (state machine: pending/committed/aborted/hard_deleted)');

SELECT * FROM finish();
ROLLBACK;
