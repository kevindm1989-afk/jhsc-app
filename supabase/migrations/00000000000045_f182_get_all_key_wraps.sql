-- ===========================================================================
-- F182-1 — the anti-lockout read RPC for F-182 key-rotation (ADR-0030
-- Decision 6; threat-model §3.18 Amendment A-8.10, finding F-183).
--
-- This GENERALIZES the single-live-row `get_committee_key_wrap_for_self`
-- (migration 0038) into a MULTI-epoch SETOF: it returns EVERY wrap the caller
-- holds — the live epoch AND every retired epoch — so a member can still open
-- data sealed under a rotated-out key (the anti-lockout property). Migration
-- 0038 returns ONLY the live-key wrap; that is correct for the fresh-seal path
-- but leaves a rotated-out member unable to read pre-rotation data. F182-1 is
-- the read side of the F-182 rotation story.
--
-- Contract EXACTLY mirrors `get_committee_key_wrap_for_self` (migration 0038)
-- for the gate / REVOKE / GRANT / audit-before-return / hex handling; only the
-- cardinality (single live row → SETOF all-epochs) and the per-row `is_live`
-- flag are new.
--
-- F-183 (i) own-wrap-only / no-IDOR: the actor is `auth.uid()`, NEVER a
-- parameter — the function takes ZERO arguments, so there is no id to abuse.
-- It reads ONLY `WHERE w.user_id = auth.uid()`; it can never return another
-- member's wrap, and a caller cannot widen the scope.
--
-- F-183 no-history-read: reads `committee_key_wraps` ONLY, NEVER the forensic
-- archive `committee_key_wraps_history`. The archive is a retention-forensics
-- surface (populated by revoke_committee_member); it is never a member-read
-- path. A member whose only wrap is archived gets ZERO rows.
--
-- F-148 audit-before-return: one `committee_data_key.unwrap` row is emitted
-- INSIDE this SECURITY DEFINER transaction, BEFORE the wrap bytes are returned,
-- for EACH DISTINCT key materialized (a multi-epoch unwrap is still an unwrap
-- event per key). The meta carries the caller pseudonym + the `committee_key_id`
-- — NEVER the raw wrap ciphertext bytes (F-148 carry-forward). Because the wrap
-- table's PK is (user_id, key_id) a caller holds at most one wrap per key, so
-- one audit row per returned row IS one per distinct key.
--
-- VOLATILE (not STABLE) because the function writes the audit rows via
-- `audit_emit` — mirroring migration 0038 / `reveal_concern_source`.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.get_all_committee_key_wraps_for_self()
RETURNS TABLE(key_id uuid, epoch integer, wrapped_ciphertext bytea, is_live boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_row   record;
BEGIN
  -- F-01 / F-116 active-member gate (byte-identical denial to migration 0038 /
  -- record_committee_data_key_unwrap :537). Blocks a removed/inactive member
  -- from reading their own retained wrap even before the purge runs.
  PERFORM public._t07_gate_active_member();

  -- Resolve the caller's OWN wraps across ALL epochs (live + retired). The
  -- actor is auth.uid() — never a parameter (F-183 (i): own-wrap-only is
  -- structural, no IDOR). Reads the LIVE committee_key_wraps table ONLY; the
  -- forensic retention archive is never touched (F-183 no-history-read — a
  -- source-scan of this body must find no reference to that archive table). A
  -- no-wrap member iterates zero rows → no audit row, an empty SETOF (the
  -- client maps that to the holding state, Decision 7 / F-144).
  --
  -- is_live = true ⇔ the wrap's key is the committee's live key
  -- (committee_data_keys.rotated_at IS NULL). The partial-UNIQUE index below
  -- guarantees at most one live key, so at most one returned row is is_live.
  FOR v_row IN
    SELECT cdk.key_id                 AS k_id,
           cdk.epoch                  AS k_epoch,
           w.wrapped_ciphertext       AS k_ct,
           (cdk.rotated_at IS NULL)   AS k_live
      FROM public.committee_key_wraps w
      JOIN public.committee_data_keys cdk
        ON cdk.key_id = w.key_id
     WHERE w.user_id = v_actor
     ORDER BY cdk.epoch
  LOOP
    -- F-148 audit-BEFORE-return, one committee_data_key.unwrap per DISTINCT
    -- key materialized (mirror migration 0038's audit_emit meta shape). The
    -- row carries the caller pseudonym + the committee_key_id — NEVER the raw
    -- wrap bytes (no key material in the audit trail).
    PERFORM public.audit_emit(
      'committee_data_key.unwrap', public._committee_pseudonym(v_actor),
      'C2', 'info', NULL, v_actor, NULL,
      jsonb_build_object('actor_id', v_actor, 'committee_key_id', v_row.k_id)
    );

    key_id := v_row.k_id;
    epoch := v_row.k_epoch;
    wrapped_ciphertext := v_row.k_ct;
    is_live := v_row.k_live;
    RETURN NEXT;
  END LOOP;
  RETURN;
END $$;

REVOKE EXECUTE ON FUNCTION public.get_all_committee_key_wraps_for_self()
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_all_committee_key_wraps_for_self()
  TO authenticated, supabase_auth_admin;

-- ===========================================================================
-- F-183 (iv) — partial-UNIQUE live-key index. "Exactly one live key" was, until
-- now, only a PROCEDURAL invariant (init_committee_data_key / rotate_committee_
-- data_key each maintain it). F182-1 promotes it to a DB-LEVEL guarantee so a
-- second live row is structurally impossible — removing the is_live / seal-
-- target ambiguity F-183 (iv) warns about.
--
-- The predicate `WHERE rotated_at IS NULL` scopes uniqueness to LIVE rows only;
-- retired rows (rotated_at set) are excluded and remain unbounded. The index
-- key is the constant expression `(true)` — a single-tenant predicate per
-- ADR-0021: there is one committee, so "one live key globally" is the correct
-- shape. The existing non-unique lookup index `committee_data_keys_active_idx`
-- (migration 0007 :166-167) stays alongside for epoch-ordered live lookups.
-- ===========================================================================
CREATE UNIQUE INDEX IF NOT EXISTS committee_data_keys_one_live_idx
  ON public.committee_data_keys ((true)) WHERE rotated_at IS NULL;
