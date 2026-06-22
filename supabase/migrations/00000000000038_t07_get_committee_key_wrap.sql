-- ===========================================================================
-- Phase 2a PR1 / ADR-0027 Decision 2 — the committee-key-unwrap disclosure RPC
-- (threat-model §3.16 F-142 + F-151).
--
-- This is the FIRST production RPC that returns committee key material (a
-- per-member sealed-box wrap) across the browser ↔ t07-op trust boundary. It
-- is shared by every Phase 2 E2EE read feature (2b/2c/2d), so its contract is
-- load-bearing beyond Phase 2a.
--
-- The keystone (migration 0007) revokes all direct SELECT on
-- `committee_key_wraps` from authenticated/anon (:184). Until now there was NO
-- production path for a member to read back their OWN wrap ciphertext so the
-- client could `crypto_box_seal_open` it with the device-local identity privkey
-- and recover the plaintext committee data key. `committee_key_state_for_self`
-- (migration 0037) returns only metadata (no key material);
-- `record_committee_data_key_unwrap` (migration 0007:529-547) is audit-only and
-- returns `void`. This migration fuses the two into one atomic audited read.
--
-- F-142 (own-wrap-only / no-IDOR): the actor is `auth.uid()`, NEVER a
-- parameter — the function takes ZERO arguments, so there is no id to abuse.
-- It reads ONLY `WHERE user_id = auth.uid()` against the LIVE key
-- (`rotated_at IS NULL`); it can never return another member's wrap nor a
-- retired-key wrap.
--
-- F-151 (audit-before-return): the `committee_data_key.unwrap` audit row is
-- emitted INSIDE the same SECURITY DEFINER transaction, BEFORE the
-- `RETURN QUERY` of the ciphertext (mirroring `reveal_concern_source` at
-- migration 0004:317-330). The audit row commits before the bytes leave the
-- function. We fold in the existing `record_committee_data_key_unwrap` body
-- (the active-member gate + the actor-has-wrap assertion + the `audit_emit`)
-- so exactly ONE row is emitted per call — no double-count, no two-call dance.
-- No NEW audit enum value: `committee_data_key.unwrap` is already on the closed
-- allowlist + ADR-0016 retention schedule, so there is no six-mirror dance.
--
-- Conventions EXACTLY mirror `committee_key_state_for_self` (migration 0037)
-- for gating + grants:
--   - SECURITY DEFINER; SET search_path = public, extensions.
--   - gates on `_t07_gate_active_member()` (F-01 / F-116 — session_is_live +
--     is_active_member(auth.uid())).
--   - REVOKE EXECUTE FROM PUBLIC, anon, service_role.
--   - GRANT  EXECUTE TO   authenticated, supabase_auth_admin.
--   - No-row case (actor has no live-key wrap) returns no rows; the client
--     maps that to `no_wrap` and routes to Phase 0a setup (Decision 7).
--
-- VOLATILE (not STABLE) because the function performs a write (the audit row)
-- via `audit_emit` — mirroring `reveal_concern_source` (VOLATILE) rather than
-- `committee_key_state_for_self` (STABLE, pure read).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.get_committee_key_wrap_for_self()
RETURNS TABLE(key_id uuid, epoch integer, wrapped_ciphertext bytea)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_key_id  uuid;
  v_epoch   integer;
  v_ct      bytea;
BEGIN
  -- F-01 / F-116 active-member gate (mirrors record_committee_data_key_unwrap
  -- :537 and committee_key_state_for_self :47).
  PERFORM public._t07_gate_active_member();

  -- Resolve the caller's OWN wrap on the LIVE key (rotated_at IS NULL). The
  -- actor is auth.uid() — never a parameter (F-142: own-wrap-only is
  -- structural, no IDOR). A no-wrap member resolves to no row → the client
  -- maps that to no_wrap (Decision 7 / F-144); no audit row is emitted in
  -- that case (nothing was unwrapped).
  SELECT cdk.key_id, cdk.epoch, w.wrapped_ciphertext
    INTO v_key_id, v_epoch, v_ct
    FROM public.committee_data_keys cdk
    JOIN public.committee_key_wraps w
      ON w.key_id = cdk.key_id
   WHERE cdk.rotated_at IS NULL
     AND w.user_id = v_actor
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN;                                                  -- no live-key wrap
  END IF;

  -- F-151 audit-BEFORE-return (mirror reveal_concern_source :317-330). Fold in
  -- the record_committee_data_key_unwrap body (:542-546) so exactly ONE
  -- committee_data_key.unwrap row commits in THIS txn before the ciphertext is
  -- returned. The actor-has-wrap precondition is already proven by the SELECT
  -- above. The audit row carries the caller pseudonym + the committee_key_id —
  -- NEVER the raw key bytes (F-148).
  PERFORM public.audit_emit(
    'committee_data_key.unwrap', public._committee_pseudonym(v_actor),
    'C2', 'info', NULL, v_actor, NULL,
    jsonb_build_object('actor_id', v_actor, 'committee_key_id', v_key_id)
  );

  key_id := v_key_id;
  epoch := v_epoch;
  wrapped_ciphertext := v_ct;
  RETURN NEXT;
END $$;

REVOKE EXECUTE ON FUNCTION public.get_committee_key_wrap_for_self()
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_committee_key_wrap_for_self()
  TO authenticated, supabase_auth_admin;
