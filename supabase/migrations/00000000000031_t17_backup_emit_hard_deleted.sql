-- ===========================================================================
-- M8.A.3d / T17.1 — backup.hard_deleted audit event + emit function.
--
--   Closes the ADR-0003 Amendment A six-mirror dance for
--   `backup.hard_deleted` — the audit anchor every committed →
--   hard_deleted manifest transition writes (ADR-0018 §J 42-day
--   hard-delete pass). Sibling event to backup.manifest_written
--   (#226 / M8.A.3b).
--
--   Six mirrors:
--     1. apps/web/src/lib/retention/types.ts (RetentionEventType union)
--     2. apps/web/src/lib/retention/schedule.ts (RETENTION_SCHEDULE +
--        RETENTION_EVENT_TYPES_RUNTIME)
--     3. observability/audit-log.md §1 ("Backup pipeline (T17)")
--     4. scripts/check-audit-enum-coverage.sh (EXPECTED_ENUM)
--     5. retention_class_for() arm below
--     6. pgTAP supabase/test/t17_backup_emit_hard_deleted.sql
--
--   Classification (mirrors backup.manifest_written):
--     - retention class: '7y' (audit anchor of a now-purged manifest;
--       the manifest row itself stays as a hard_deleted tombstone
--       per the M8.A.1 DELETE-revoked-from-every-role posture).
--     - target_id: NULL (NO PI — structural metadata only).
--     - actor_pseudonym at TOP LEVEL only (F-79; G-T16-PRIV-1).
--     - severity: 'info' (operational; alerting is separate).
--
--   No TS-side caller wires this RPC today — the library's
--   runBackupRetentionPass that drives the 42d hard-delete pass is
--   deferred to M8.A.3c (it needs the Supabase Storage SDK to
--   actually delete the bucket object first). This PR ships the
--   surface so M8.A.3c can call it directly.
--
-- Authoritative ADRs: ADR-0018 §J (42-day hard-delete) + §"Option H"
--   (manifest as audit anchor); ADR-0003 Amendment A six-mirror
--   enum dance; ADR-0015 + Amendment I (per-event retention).
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
    WHEN 'key_parity.mismatch'                            THEN '24mo'  -- M2 / F-125
    WHEN 'key_parity.deploy_ok'                           THEN '24mo'  -- M2 / forensic asymmetry
    WHEN 'auth.mint.revoked_during_mint'                  THEN '24mo'  -- M1 / F-128 race detector
    WHEN 'audit.integrity_check.ran'                      THEN '24mo'  -- M8.B.2
    WHEN 'audit.integrity_check.mismatch'                 THEN '7y'    -- M8.B.2
    WHEN 'audit.chain_anchor.weekly'                      THEN '7y'    -- M8.B.2
    WHEN 'backup.manifest_written'                        THEN '7y'    -- M8.A.3b
    WHEN 'backup.hard_deleted'                            THEN '7y'    -- ADR-0018 §J / M8.A.3d
    ELSE '24mo'
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.retention_class_for(text) FROM public;
GRANT EXECUTE ON FUNCTION public.retention_class_for(text) TO supabase_auth_admin;

COMMENT ON FUNCTION public.retention_class_for(text) IS
  'ADR-0015 §"The schedule" + Amendment I + ADR-0019 §3 (M8.B.2) + ADR-0018 §"Option H" (M8.A.3b) + §J (M8.A.3d): returns the retention class for an event_type. IMMUTABLE pure function; closed-set arms with safe-ceiling 24mo fallback.';

-- ---------------------------------------------------------------------------
-- 2. backup_emit_hard_deleted
--
--    Emits the durable audit anchor for one manifest's hard-delete.
--    Composes the structural jsonb meta the library asks for, then
--    calls audit_emit with the synthetic system actor pseudonym
--    (HMAC('system:backup-pass') — SAME pseudonym as
--    backup_emit_manifest_written; the two rows belong to the same
--    actor identity from a forensic-join perspective).
--
--    Closed-set validation up-front:
--      - p_run_id NOT NULL
--      - p_object_ref non-empty
--      - p_hard_deleted_at_ms >= 0
--      - p_original_committed_at_ms >= 0
--      - hard_deleted_at_ms >= original_committed_at_ms
--    Invalid -> 22023 BEFORE audit_emit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_emit_hard_deleted(
  p_run_id                    uuid,
  p_object_ref                text,
  p_hard_deleted_at_ms        bigint,
  p_original_committed_at_ms  bigint
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
  IF p_object_ref IS NULL OR length(p_object_ref) = 0 THEN
    RAISE EXCEPTION 'p_object_ref must be non-empty' USING ERRCODE = '22023';
  END IF;
  IF p_hard_deleted_at_ms IS NULL OR p_hard_deleted_at_ms < 0 THEN
    RAISE EXCEPTION 'p_hard_deleted_at_ms must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF p_original_committed_at_ms IS NULL OR p_original_committed_at_ms < 0 THEN
    RAISE EXCEPTION 'p_original_committed_at_ms must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF p_hard_deleted_at_ms < p_original_committed_at_ms THEN
    RAISE EXCEPTION 'p_hard_deleted_at_ms < p_original_committed_at_ms'
      USING ERRCODE = '22023';
  END IF;

  v_actor_pseudonym := LEFT(
    encode(
      hmac('system:backup-pass'::bytea,
           current_setting('app.hmac_pseudonym_key')::bytea,
           'sha256'),
      'hex'
    ),
    16
  );

  -- G-T16-PRIV-7 / F-79: structural meta only; pseudonym top-level only.
  -- target_id NULL (no_target_id classification — same as manifest_written).
  SELECT public.audit_emit(
    p_event_type      => 'backup.hard_deleted',
    p_actor_pseudonym => v_actor_pseudonym,
    p_target_class    => 'C0',
    p_severity        => 'info',
    p_request_id      => NULL,
    p_target_id       => NULL,
    p_rotation_id     => NULL,
    p_meta            => jsonb_build_object(
      'run_id', p_run_id::text,
      'object_ref', p_object_ref,
      'hard_deleted_at_ms', p_hard_deleted_at_ms,
      'original_committed_at_ms', p_original_committed_at_ms,
      'manifest_age_ms', p_hard_deleted_at_ms - p_original_committed_at_ms
    )
  ) INTO v_audit_id;

  RETURN v_audit_id;
END
$$;

REVOKE EXECUTE ON FUNCTION public.backup_emit_hard_deleted(uuid, text, bigint, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backup_emit_hard_deleted(uuid, text, bigint, bigint)
  TO backup_writer_role;

COMMENT ON FUNCTION public.backup_emit_hard_deleted(uuid, text, bigint, bigint) IS
  'ADR-0018 §J / M8.A.3d: emits backup.hard_deleted audit row. target_id=NULL; actor_pseudonym at top level only (F-79); structural meta only (G-T16-PRIV-7). backup_writer_role only.';
