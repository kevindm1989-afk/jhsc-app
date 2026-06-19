-- ===========================================================================
-- ADR-0023 Amendment A (M1 / F-128 post-mint EXISTS check):
--
--   1. mint_is_session_live(p_session_id uuid) — EXISTS check the mint
--      dispatcher calls between mint_create_session and signSessionJwt
--      to close the TOCTOU race against concurrent revoke_all_sessions.
--      Takes an explicit session_id parameter because the mint path is
--      checking a freshly-minted jti BEFORE the caller has a JWT for it
--      (so the existing session_is_live() — which reads request.jwt.claims
--      — cannot be used).
--
--   2. mint_emit_revoked_during_mint(...) — narrow SECURITY DEFINER wrapper
--      that calls audit_emit with event_type hard-coded to
--      'auth.mint.revoked_during_mint'. mint_writer cannot call audit_emit
--      directly (it's GRANTed only to supabase_auth_admin) and we don't
--      want to widen that grant. This wrapper hard-codes the event_type
--      so the caller cannot mis-shape the audit row.
--
-- Authoritative ADRs: ADR-0023 Amendment A (`.context/decisions.md`),
--   threat-model.md §3.14 F-128 (race detector).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.mint_is_session_live(p_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.auth_sessions
    WHERE session_id = p_session_id
      AND revoked_at IS NULL
  );
$$;

REVOKE EXECUTE ON FUNCTION public.mint_is_session_live(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mint_is_session_live(uuid) TO mint_writer;

COMMENT ON FUNCTION public.mint_is_session_live(uuid) IS
  'ADR-0023 Amendment A / F-128: EXISTS check the mint dispatcher runs between mint_create_session and signSessionJwt. Caller-supplied session_id (the mint path has no JWT yet so session_is_live() does not apply). NOT expires_at-aware — caller is checking a freshly-inserted row whose expires_at is by definition in the future.';

CREATE OR REPLACE FUNCTION public.mint_emit_revoked_during_mint(
  p_user_id     uuid,
  p_request_id  uuid,
  p_session_id  uuid
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_id            bigint;
  v_pseudonym     varchar(16);
BEGIN
  -- Compute the actor pseudonym server-side via HMAC of the user_id
  -- (matches the LEFT(encode(hmac(...))) pattern used elsewhere in this
  -- migration set). mint_writer does NOT have direct access to the
  -- pseudonym key (it lives in the app.hmac_pseudonym_key GUC); doing
  -- the computation in a SECURITY DEFINER fn is the only path.
  v_pseudonym := LEFT(
    encode(
      hmac(p_user_id::text::bytea, private._hmac_pseudonym_key()::bytea, 'sha256'),
      'hex'
    ),
    16
  );

  -- Hard-coded event_type: caller cannot tamper. target_class 'C0' because
  -- this event records an internal protocol outcome, not access to a
  -- specific user record.
  --
  -- IMPORTANT: target_id is deliberately NULL — per ADR-0015 Amendment I,
  -- this row is NOT linked via target_id (the underlying-record-ceiling
  -- rule does NOT apply) so the 24mo floor governs absolutely. If we
  -- passed target_id = session_id, audit_emit's ceiling-rewrite
  -- (00000000000001_auth.sql line ~207) would re-stamp retention_class
  -- as 'match_underlying' and the row would age out with the
  -- auth_sessions row (≤300s TTL) — defeating the race-detector
  -- forensic purpose. The session_id goes in `meta` instead, where the
  -- ceiling rule doesn't apply but a forensic walker can still join.
  SELECT public.audit_emit(
    p_event_type      => 'auth.mint.revoked_during_mint',
    p_actor_pseudonym => v_pseudonym,
    p_target_class    => 'C0',
    p_severity        => 'notice',
    p_request_id      => p_request_id,
    p_target_id       => NULL,
    p_rotation_id     => NULL,
    p_meta            => jsonb_build_object(
      'session_id_revoked_during_mint', p_session_id::text
    )
  ) INTO v_id;
  RETURN v_id;
END
$$;

REVOKE EXECUTE ON FUNCTION public.mint_emit_revoked_during_mint(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mint_emit_revoked_during_mint(uuid, uuid, uuid) TO mint_writer;

COMMENT ON FUNCTION public.mint_emit_revoked_during_mint(uuid, uuid, uuid) IS
  'ADR-0023 Amendment A / F-128: narrow wrapper for emitting the auth.mint.revoked_during_mint audit row from the mint dispatcher. Event_type hard-coded so mint_writer cannot mis-shape the audit row. Actor pseudonym computed server-side via HMAC of user_id (mint_writer cannot access the pseudonym key directly). Retention class ''24mo'' per ADR-0015 Amendment I.';
