-- ===========================================================================
-- M8.B.2 / T18.1 — three new audit-log event types + two emit
--                  SECURITY DEFINER functions for the integrity-check
--                  pipeline.
--
--   ADR-0003 Amendment A six-mirror enum-extension dance — verified
--   simultaneously across:
--     1. apps/web/src/lib/retention/types.ts (RetentionEventType union)
--     2. apps/web/src/lib/retention/schedule.ts (RETENTION_SCHEDULE)
--     3. observability/audit-log.md §1 ("Alerting infra echoes (T18)")
--     4. scripts/check-audit-enum-coverage.sh (EXPECTED_ENUM)
--     5. retention_class_for() arms below
--     6. pgTAP supabase/test/t18_integrity_check_event_types.sql
--   Drift between any two mirrors is a CI fail.
--
--   New event types:
--     - audit.integrity_check.ran  — 24mo (operational telemetry;
--       mirrors retention.deleted)
--     - audit.integrity_check.mismatch — 7y (load-bearing forensic)
--     - audit.chain_anchor.weekly — 7y (off-app weekly-email anchor;
--       G-T18-12 backstop)
--
--   New SECURITY DEFINER functions (B6.2 / integrity_check_role):
--     - integrity_check_emit_run_and_mismatches — finalizes the
--       integrity_check_runs row (status, completed_at_ms, rows_walked,
--       mismatches_count) AND emits one audit.integrity_check.ran +
--       one audit.integrity_check.mismatch per element in
--       p_mismatches jsonb.
--     - integrity_check_emit_chain_anchor_weekly — INSERTs the
--       audit_chain_anchors row AND emits one
--       audit.chain_anchor.weekly.
--
--   Walk + read-by-ids functions remain deferred (carry the prev_hash
--   chain work which is its own ADR).
--
-- Authoritative ADRs: ADR-0019 §3 (T18 function set), ADR-0019
--   §"Optional audit_chain_anchors table" (weekly anchor),
--   ADR-0003 Amendment A (six-mirror enum dance), ADR-0015 + Amendment
--   I (per-event-type retention).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. retention_class_for() — extend with the three new event types.
--
--    audit.integrity_check.ran        => '24mo'
--    audit.integrity_check.mismatch   => '7y'
--    audit.chain_anchor.weekly        => '7y'
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
    ELSE '24mo'
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.retention_class_for(text) FROM public;
GRANT EXECUTE ON FUNCTION public.retention_class_for(text) TO supabase_auth_admin;

COMMENT ON FUNCTION public.retention_class_for(text) IS
  'ADR-0015 §"The schedule" + Amendment I + ADR-0019 §3 / M8.B.2: returns the retention class for an event_type. IMMUTABLE pure function; closed-set arms with safe-ceiling 24mo fallback.';

-- ---------------------------------------------------------------------------
-- 2. integrity_check_emit_run_and_mismatches
--
--    Finalizes one integrity_check_runs row (UPDATE status,
--    completed_at_ms, rows_walked, mismatches_count, plus
--    attributable/unattributable counts and backup_diff_performed)
--    AND emits the audit.integrity_check.ran row +
--    one audit.integrity_check.mismatch row per entry in p_mismatches.
--
--    p_mismatches is an array of jsonb objects each with:
--      - audit_log_id        bigint   (required)
--      - mismatch_kind       text     ∈ {'hash_mismatch','row_missing',
--                                       'row_unexpected','head_pointer_drift'}
--      - attributable        boolean
--      - attribution_run_id  uuid?    (optional)
--    Invalid kinds raise 22023 BEFORE any emit. The run row + every
--    audit row are written in one transaction; library treats failure
--    as aborted pass.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.integrity_check_emit_run_and_mismatches(
  p_run_id                uuid,
  p_completed_at_ms       bigint,
  p_status                text,
  p_rows_walked           bigint,
  p_attributable_count    bigint,
  p_unattributable_count  bigint,
  p_backup_diff_performed boolean,
  p_resume_after_id       bigint,
  p_mismatches            jsonb
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor_pseudonym varchar(16);
  v_ran_audit_id    bigint;
  v_mismatches_count bigint;
  v_mismatch        jsonb;
  v_run_started_at_ms bigint;
  v_run_trigger     text;
  v_run_schedule_hash text;
  v_run_node_pin    text;
BEGIN
  -- Closed-set status validation.
  IF p_status NOT IN ('ok','mismatch_found','aborted','timed_out') THEN
    RAISE EXCEPTION 'p_status % is not on the closed set', p_status
      USING ERRCODE = '22023';
  END IF;

  -- Closed-set mismatch_kind validation up-front so the library aborts
  -- BEFORE emitting any partial rows.
  IF jsonb_typeof(p_mismatches) <> 'array' THEN
    RAISE EXCEPTION 'p_mismatches must be a JSON array' USING ERRCODE = '22023';
  END IF;
  FOR v_mismatch IN SELECT jsonb_array_elements(p_mismatches) LOOP
    IF NOT (v_mismatch ? 'audit_log_id' AND v_mismatch ? 'mismatch_kind') THEN
      RAISE EXCEPTION 'mismatch entry missing required keys: %', v_mismatch
        USING ERRCODE = '22023';
    END IF;
    IF (v_mismatch->>'mismatch_kind') NOT IN (
      'hash_mismatch','row_missing','row_unexpected','head_pointer_drift'
    ) THEN
      RAISE EXCEPTION 'mismatch_kind % not on closed set',
        v_mismatch->>'mismatch_kind' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  v_mismatches_count := COALESCE(jsonb_array_length(p_mismatches), 0)::bigint;

  -- Load the started row (must already exist via record_run_started).
  SELECT started_at_ms, trigger, schedule_hash, node_runtime_pin
    INTO v_run_started_at_ms, v_run_trigger, v_run_schedule_hash, v_run_node_pin
    FROM public.integrity_check_runs
   WHERE run_id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'integrity_check_runs row not found for run_id %', p_run_id
      USING ERRCODE = '22023';
  END IF;

  -- Finalize the run row.
  UPDATE public.integrity_check_runs
     SET status                = p_status,
         completed_at_ms       = p_completed_at_ms,
         rows_walked           = p_rows_walked,
         mismatches_count      = v_mismatches_count,
         attributable_count    = p_attributable_count,
         unattributable_count  = p_unattributable_count,
         backup_diff_performed = p_backup_diff_performed,
         resume_after_id       = p_resume_after_id
   WHERE run_id = p_run_id;

  -- Synthetic actor pseudonym for the system integrity-check pass.
  -- Mirrors mint_emit_revoked_during_mint / retention emit_deleted.
  v_actor_pseudonym := LEFT(
    encode(
      hmac('system:integrity-check'::bytea,
           current_setting('app.hmac_pseudonym_key')::bytea,
           'sha256'),
      'hex'
    ),
    16
  );

  -- Emit the audit.integrity_check.ran row.
  SELECT public.audit_emit(
    p_event_type      => 'audit.integrity_check.ran',
    p_actor_pseudonym => v_actor_pseudonym,
    p_target_class    => 'C0',
    p_severity        => CASE WHEN p_status = 'mismatch_found' THEN 'alert'
                              WHEN p_status IN ('aborted','timed_out') THEN 'warn'
                              ELSE 'info' END,
    p_request_id      => NULL,
    p_target_id       => NULL,
    p_rotation_id     => NULL,
    p_meta            => jsonb_build_object(
      'run_id', p_run_id::text,
      'trigger', v_run_trigger,
      'started_at_ms', v_run_started_at_ms,
      'completed_at_ms', p_completed_at_ms,
      'status', p_status,
      'rows_walked', p_rows_walked,
      'mismatches_count', v_mismatches_count,
      'attributable_count', p_attributable_count,
      'unattributable_count', p_unattributable_count,
      'backup_diff_performed', p_backup_diff_performed,
      'schedule_hash', v_run_schedule_hash,
      'node_runtime_pin', v_run_node_pin
    )
  ) INTO v_ran_audit_id;

  -- One audit.integrity_check.mismatch per mismatch entry.
  FOR v_mismatch IN SELECT jsonb_array_elements(p_mismatches) LOOP
    PERFORM public.audit_emit(
      p_event_type      => 'audit.integrity_check.mismatch',
      p_actor_pseudonym => v_actor_pseudonym,
      p_target_class    => 'C0',
      p_severity        => 'alert',
      p_request_id      => NULL,
      p_target_id       => NULL,
      p_rotation_id     => NULL,
      p_meta            => jsonb_build_object(
        'run_id', p_run_id::text,
        'audit_log_id', (v_mismatch->>'audit_log_id')::bigint,
        'mismatch_kind', v_mismatch->>'mismatch_kind',
        'attributable', COALESCE((v_mismatch->>'attributable')::boolean, false),
        'attribution_run_id', v_mismatch->>'attribution_run_id'
      )
    );
  END LOOP;

  RETURN v_ran_audit_id;
END
$$;

REVOKE EXECUTE ON FUNCTION public.integrity_check_emit_run_and_mismatches(
  uuid, bigint, text, bigint, bigint, bigint, boolean, bigint, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integrity_check_emit_run_and_mismatches(
  uuid, bigint, text, bigint, bigint, bigint, boolean, bigint, jsonb
) TO integrity_check_role;

COMMENT ON FUNCTION public.integrity_check_emit_run_and_mismatches(
  uuid, bigint, text, bigint, bigint, bigint, boolean, bigint, jsonb
) IS
  'ADR-0019 §3 / M8.B.2: finalize integrity_check_runs + emit audit.integrity_check.ran + one audit.integrity_check.mismatch per p_mismatches entry. Closed-set status + mismatch_kind validation. integrity_check_role only.';

-- ---------------------------------------------------------------------------
-- 3. integrity_check_emit_chain_anchor_weekly
--
--    INSERTs the audit_chain_anchors row + emits the
--    audit.chain_anchor.weekly audit row. The off-app email send
--    happens above this layer (Edge Function); this fn writes the
--    durable in-DB anchor.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.integrity_check_emit_chain_anchor_weekly(
  p_anchor_at_ms              bigint,
  p_head_audit_log_id         bigint,
  p_head_ts_ms                bigint,
  p_head_hash                 bytea,
  p_email_recipient_pseudonym text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_anchor_id       uuid := gen_random_uuid();
  v_actor_pseudonym varchar(16);
BEGIN
  IF p_head_audit_log_id IS NULL OR p_head_audit_log_id < 0 THEN
    RAISE EXCEPTION 'p_head_audit_log_id must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF p_head_hash IS NULL OR octet_length(p_head_hash) = 0 THEN
    RAISE EXCEPTION 'p_head_hash must be non-empty' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.audit_chain_anchors (
    anchor_id, anchor_at_ms, head_audit_log_id, head_ts_ms, head_hash,
    email_sent_at, email_recipient_pseudonym
  ) VALUES (
    v_anchor_id, p_anchor_at_ms, p_head_audit_log_id, p_head_ts_ms, p_head_hash,
    NULL, p_email_recipient_pseudonym
  );

  v_actor_pseudonym := LEFT(
    encode(
      hmac('system:integrity-check'::bytea,
           current_setting('app.hmac_pseudonym_key')::bytea,
           'sha256'),
      'hex'
    ),
    16
  );

  PERFORM public.audit_emit(
    p_event_type      => 'audit.chain_anchor.weekly',
    p_actor_pseudonym => v_actor_pseudonym,
    p_target_class    => 'C0',
    p_severity        => 'info',
    p_request_id      => NULL,
    p_target_id       => NULL,
    p_rotation_id     => NULL,
    p_meta            => jsonb_build_object(
      'anchor_id', v_anchor_id::text,
      'head_audit_log_id', p_head_audit_log_id,
      'head_ts_ms', p_head_ts_ms,
      'head_hash_hex', encode(p_head_hash, 'hex'),
      'email_recipient_pseudonym', p_email_recipient_pseudonym
    )
  );

  RETURN v_anchor_id;
END
$$;

REVOKE EXECUTE ON FUNCTION public.integrity_check_emit_chain_anchor_weekly(
  bigint, bigint, bigint, bytea, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integrity_check_emit_chain_anchor_weekly(
  bigint, bigint, bigint, bytea, text
) TO integrity_check_role;

COMMENT ON FUNCTION public.integrity_check_emit_chain_anchor_weekly(
  bigint, bigint, bigint, bytea, text
) IS
  'ADR-0019 §"Optional audit_chain_anchors table" / M8.B.2: INSERTs audit_chain_anchors + emits audit.chain_anchor.weekly. integrity_check_role only.';
