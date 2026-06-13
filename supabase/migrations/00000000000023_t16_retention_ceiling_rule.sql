-- ===========================================================================
-- M6.1.B / T16.1 — SECURITY DEFINER underlying-record-ceiling rule
--
--   ADR-0015 Sec3.5: "Audit-log rows linked via target_id to a record
--   in another table MUST NOT outlive the linked record by more than
--   30 days." This migration ships the two SECURITY DEFINER functions
--   the library's RetentionStore.deleteForUnderlyingRecordCeiling /
--   countCandidatesForCeiling consume:
--
--     1. retention_delete_for_ceiling(p_ceiling_cutoff_ms, p_max_rows)
--     2. retention_count_for_ceiling(p_ceiling_cutoff_ms)
--
--   Closed allowlist of (event_type → target_table). Today:
--     - concern.created  → public.concerns
--     - concern.updated  → public.concerns
--   These are the only two entries in RETENTION_SCHEDULE today whose
--   `kind` is `match_underlying`. Adding a new (event_type, table)
--   pair requires:
--     (a) adding `kind: 'match_underlying'` to apps/web/src/lib/
--         retention/schedule.ts for the event_type
--     (b) adding a row to the AllowlistRow CTE below
--     (c) extending the pgTAP test
--   All three mirror; CI drift catches a missing mirror.
--
-- Authoritative ADRs: ADR-0015 + Amendment I (per-event-type
--   retention; Sec3.5 ceiling rule); ADR-0017 (T16 retention library).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. retention_delete_for_ceiling
--
--    DELETE up to max_rows audit_log rows where:
--      - retention_class = 'match_underlying'
--      - target_id IS NOT NULL
--      - event_type is on the closed (event_type → target_table) allowlist
--      - target_id has no surviving row in the mapped target_table
--      - ts < to_timestamp(ceiling_cutoff_ms/1000)   (proxy for
--        "underlying record gone >= 30 days"; the library passes
--        now() - 30d as the cutoff)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_delete_for_ceiling(
  p_ceiling_cutoff_ms bigint,
  p_max_rows          integer
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_deleted_count integer;
BEGIN
  IF p_max_rows IS NULL OR p_max_rows <= 0 THEN
    RAISE EXCEPTION 'p_max_rows must be > 0' USING ERRCODE = '22023';
  END IF;

  WITH victims AS (
    SELECT a.id
      FROM public.audit_log a
     WHERE a.retention_class = 'match_underlying'
       AND a.target_id IS NOT NULL
       AND a.ts < to_timestamp(p_ceiling_cutoff_ms / 1000.0)
       AND (
         -- concern.* → concerns (closed allowlist; only entry today)
         (a.event_type IN ('concern.created', 'concern.updated')
          AND NOT EXISTS (
            SELECT 1 FROM public.concerns c WHERE c.id = a.target_id
          ))
       )
     ORDER BY a.ts
     LIMIT p_max_rows
  ),
  deleted AS (
    DELETE FROM public.audit_log
     WHERE id IN (SELECT id FROM victims)
     RETURNING 1
  )
  SELECT count(*)::int INTO v_deleted_count FROM deleted;

  RETURN COALESCE(v_deleted_count, 0);
END
$$;

REVOKE EXECUTE ON FUNCTION public.retention_delete_for_ceiling(bigint, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retention_delete_for_ceiling(bigint, integer)
  TO retention_service_role;

COMMENT ON FUNCTION public.retention_delete_for_ceiling(bigint, integer) IS
  'ADR-0015 Sec3.5 / library RetentionStore.deleteForUnderlyingRecordCeiling: DELETE up to max_rows orphaned audit_log rows whose retention_class = match_underlying AND target_id no longer resolves in the mapped target_table. Closed allowlist of (event_type → target_table). retention_service_role only.';

-- ---------------------------------------------------------------------------
-- 2. retention_count_for_ceiling
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_count_for_ceiling(
  p_ceiling_cutoff_ms bigint
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT count(*)::bigint
    FROM public.audit_log a
   WHERE a.retention_class = 'match_underlying'
     AND a.target_id IS NOT NULL
     AND a.ts < to_timestamp(p_ceiling_cutoff_ms / 1000.0)
     AND (
       (a.event_type IN ('concern.created', 'concern.updated')
        AND NOT EXISTS (
          SELECT 1 FROM public.concerns c WHERE c.id = a.target_id
        ))
     );
$$;

REVOKE EXECUTE ON FUNCTION public.retention_count_for_ceiling(bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retention_count_for_ceiling(bigint)
  TO retention_service_role;

COMMENT ON FUNCTION public.retention_count_for_ceiling(bigint) IS
  'ADR-0015 Sec3.5 / library countCandidatesForCeiling: count orphaned audit_log rows the same-shape delete would target. STABLE. retention_service_role only.';
