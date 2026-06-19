-- ===========================================================================
-- M8.A.3b / T17.1 — backup.manifest_written audit event + emit function.
--
--   Closes the ADR-0003 Amendment A six-mirror dance for
--   `backup.manifest_written` (the durable audit anchor every backup
--   pass writes as its LAST step per F-72 step 10 / ADR-0017 §6 step 9
--   mirror). Six mirrors:
--     1. apps/web/src/lib/retention/types.ts (RetentionEventType union)
--     2. apps/web/src/lib/retention/schedule.ts (RETENTION_SCHEDULE +
--        RETENTION_EVENT_TYPES_RUNTIME)
--     3. observability/audit-log.md §1 ("Backup pipeline (T17)")
--     4. scripts/check-audit-enum-coverage.sh (EXPECTED_ENUM)
--     5. retention_class_for() arm below
--     6. pgTAP supabase/test/t17_backup_emit_manifest_written.sql
--   Drift between any two is a CI fail.
--
--   Classification (per ADR-0018 §"Option H"):
--     - retention class: '7y' (mirrors retention.deleted — the manifest
--       is the audit anchor surface; outlives the dump blob it points to).
--     - target_id: NULL (NO PI — structural metadata only; G-T16-PRIV-7).
--     - actor_pseudonym at TOP LEVEL only (F-79; G-T16-PRIV-1).
--     - severity: 'info' (operational; the alert pipeline is separate).
--
--   `backup.hard_deleted` is the sibling enum value the M8.A.3c work
--   will add (mirrors this PR's dance). NOT in this PR.
--
-- Authoritative ADRs: ADR-0018 §"Option H" + §7; ADR-0003 Amendment A
--   six-mirror enum dance; ADR-0015 + Amendment I (per-event retention).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. retention_class_for() — extend with the new arm.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_class_for(p_event_type text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE p_event_type
    WHEN 'auth.passkey.enrolled'                          THEN '90d'
    WHEN 'auth.passkey.revoked'                           THEN '90d'
    WHEN 'session.revoked'                                THEN '90d'
    WHEN 'committee_data_key.unwrap'                      THEN '24mo'
    WHEN 'committee_data_key.rotation.started'            THEN '7y'
    WHEN 'committee_data_key.rotation.completed'          THEN '7y'
    WHEN 'committee_data_key.member_revoked'              THEN '7y'
    WHEN 'committee.key_rotated'                          THEN '7y'
    WHEN 'identity_keypair.created'                       THEN '7y'
    WHEN 'identity_privkey.recovery_blob.written'         THEN 'membership+24mo'
    WHEN 'identity_privkey.recovery_blob.restored'        THEN 'membership+24mo'
    WHEN 'identity_privkey.recovery_blob.viewed'          THEN 'membership+24mo'
    WHEN 'recovery_reset.issued'                          THEN 'membership+24mo'
    WHEN 'panic_wipe.invoked'                             THEN '7y'
    WHEN 'committee_data_key.wrapped_for_member'          THEN '7y_from_rotation'
    WHEN 'export.generated'                               THEN '7y'
    WHEN 'export.contained_concern_derived_items'         THEN '7y'
    WHEN 'retention.deleted'                              THEN '7y'
    WHEN 'member.added'                                   THEN 'membership+7y'
    WHEN 'member.removed'                                 THEN 'membership+7y'
    WHEN 'member.role_changed'                            THEN 'membership+7y'
    WHEN 'alert.fired'                                    THEN '24mo'
    WHEN 'client.cache_policy_violation'                  THEN '90d'
    WHEN 'client.identity_selftest_fail'                  THEN '90d'
    WHEN 'key_parity.mismatch'                            THEN '24mo'  -- ADR-0015 Amendment I (M2 / F-125)
    WHEN 'key_parity.deploy_ok'                           THEN '24mo'  -- ADR-0015 Amendment I (M2 / forensic asymmetry)
    WHEN 'auth.mint.revoked_during_mint'                  THEN '24mo'  -- ADR-0015 Amendment I (M1 / F-128 race detector)
    WHEN 'audit.integrity_check.ran'                      THEN '24mo'  -- ADR-0019 §3 / M8.B.2 (operational telemetry)
    WHEN 'audit.integrity_check.mismatch'                 THEN '7y'    -- ADR-0019 §3 / M8.B.2 (load-bearing forensic)
    WHEN 'audit.chain_anchor.weekly'                      THEN '7y'    -- ADR-0019 §"Optional audit_chain_anchors table" / M8.B.2
    WHEN 'backup.manifest_written'                        THEN '7y'    -- ADR-0018 §"Option H" / M8.A.3b (manifest audit anchor)
    ELSE '24mo'
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.retention_class_for(text) FROM public;
GRANT EXECUTE ON FUNCTION public.retention_class_for(text) TO supabase_auth_admin;

COMMENT ON FUNCTION public.retention_class_for(text) IS
  'ADR-0015 §"The schedule" + Amendment I + ADR-0019 §3 / M8.B.2 + ADR-0018 §"Option H" / M8.A.3b: returns the retention class for an event_type. IMMUTABLE pure function; closed-set arms with safe-ceiling 24mo fallback.';

-- ---------------------------------------------------------------------------
-- 2. backup_emit_manifest_written
--
--    Emits the durable audit anchor for one committed backup pass.
--    Composes the closed-set jsonb meta the library / threat-model
--    G-T16-PRIV-7 / F-83 / G-T16-PRIV-1 require, then calls audit_emit
--    with the synthetic system actor pseudonym (mirrors
--    retention_emit_deleted_and_register_run / mint_emit_revoked_during_mint).
--
--    Closed-set validation up-front:
--      - p_run_id NOT NULL
--      - p_sha256 ~ '^[0-9a-f]{64}$'
--      - p_bytes >= 0
--      - p_committee_data_key_kid non-empty
--    Invalid -> 22023 before any audit emit.
--
--    G-T16-PRIV-1 / F-79: actor_pseudonym at TOP LEVEL ONLY. meta does
--    NOT include an actor_pseudonym key (server-enforced; the caller
--    cannot inject one because meta is composed entirely here).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_emit_manifest_written(
  p_run_id                              uuid,
  p_emitted_at_ms                       bigint,
  p_sha256                              text,
  p_bytes                               bigint,
  p_committee_data_key_kid              text,
  p_audit_log_head_id                   bigint,
  p_audit_log_head_ts_ms                bigint,
  p_audit_log_head_hash                 bytea,
  p_per_event_row_counts                jsonb,
  p_per_table_row_counts                jsonb,
  p_retention_sweep_runs_snapshot_ts_ms bigint,
  p_schedule_hash                       text,
  p_node_runtime_pin                    text
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor_pseudonym varchar(16);
  v_audit_id        bigint;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'p_run_id must not be NULL' USING ERRCODE = '22023';
  END IF;
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'p_sha256 must be 64 lowercase hex chars' USING ERRCODE = '22023';
  END IF;
  IF p_bytes IS NULL OR p_bytes < 0 THEN
    RAISE EXCEPTION 'p_bytes must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF p_committee_data_key_kid IS NULL OR length(p_committee_data_key_kid) = 0 THEN
    RAISE EXCEPTION 'p_committee_data_key_kid must be non-empty' USING ERRCODE = '22023';
  END IF;

  -- Synthetic actor pseudonym: HMAC('system:backup-pass') — mirrors
  -- ADR-0017 §6 systemActorPseudonym + retention_emit_deleted_and_register_run.
  v_actor_pseudonym := LEFT(
    encode(
      hmac('system:backup-pass'::bytea,
           private._hmac_pseudonym_key()::bytea,
           'sha256'),
      'hex'
    ),
    16
  );

  -- G-T16-PRIV-7: structural metadata only; NO pseudonym fields inside
  -- meta (the top-level actor_pseudonym is what audit_emit reads).
  -- target_id intentionally NULL (manifest_written has no_target_id).
  SELECT public.audit_emit(
    p_event_type      => 'backup.manifest_written',
    p_actor_pseudonym => v_actor_pseudonym,
    p_target_class    => 'C0',
    p_severity        => 'info',
    p_request_id      => NULL,
    p_target_id       => NULL,
    p_rotation_id     => NULL,
    p_meta            => jsonb_build_object(
      'run_id', p_run_id::text,
      'emitted_at_ms', p_emitted_at_ms,
      'sha256', p_sha256,
      'bytes', p_bytes,
      'committee_data_key_kid', p_committee_data_key_kid,
      'audit_log_head', CASE
        WHEN p_audit_log_head_id IS NULL THEN NULL
        ELSE jsonb_build_object(
          'id', p_audit_log_head_id,
          'ts_ms', p_audit_log_head_ts_ms,
          'hash', encode(p_audit_log_head_hash, 'hex')
        )
      END,
      'per_event_row_counts', p_per_event_row_counts,
      'per_table_row_counts', p_per_table_row_counts,
      'retention_sweep_runs_snapshot_ts_ms', p_retention_sweep_runs_snapshot_ts_ms,
      'schedule_hash', p_schedule_hash,
      'node_runtime_pin', p_node_runtime_pin,
      'status', 'committed'
    )
  ) INTO v_audit_id;

  RETURN v_audit_id;
END
$$;

REVOKE EXECUTE ON FUNCTION public.backup_emit_manifest_written(
  uuid, bigint, text, bigint, text, bigint, bigint, bytea,
  jsonb, jsonb, bigint, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backup_emit_manifest_written(
  uuid, bigint, text, bigint, text, bigint, bigint, bytea,
  jsonb, jsonb, bigint, text, text
) TO backup_writer_role;

COMMENT ON FUNCTION public.backup_emit_manifest_written(
  uuid, bigint, text, bigint, text, bigint, bigint, bytea,
  jsonb, jsonb, bigint, text, text
) IS
  'ADR-0018 §"Option H" / M8.A.3b: emits backup.manifest_written audit row (F-72 step 10 / ADR-0017 §6 step 9 mirror). target_id=NULL; actor_pseudonym at top level only (F-79); structural meta only (G-T16-PRIV-7). backup_writer_role only.';
