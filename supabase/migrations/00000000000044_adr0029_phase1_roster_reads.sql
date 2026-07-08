-- ===========================================================================
-- ADR-0029 P1-8a — the TWO co-chair-gated READ RPCs (Amendment A-8.1 / A-8.2).
--
--   B1  public.committee_roster_list()             (A-8.1) — the co-chair
--       roster read: EVERY committee_membership row joined to its users PI plus
--       per-member grant-state badges (has_identity_key / has_live_wrap).
--   B2  public.committee_invite_list_pending()     (A-8.2) — the ONLY read path
--       for committee_invite (SELECT is fully revoked, 00000000000002:60): the
--       unconsumed invites (incl. expired-unconsumed) joined to their target PI.
--
-- Both are the FIRST surfaces that project ALL members' PI + grant-state to a
-- co-chair, so both are co-chair-gated SECURITY DEFINER reads with the STRICT
-- committee_key_state_for_self GRANT/REVOKE posture (00000000000037:63-66),
-- NOT the looser concern_list_default one (00000000000040:90-91 keeps
-- service_role). The threat-modeler models both as facets of F-178 (the
-- whole-committee PI + grant-state oracle); F-176 rides along (no key bytes /
-- secret-adjacent material crosses the boundary — grant-state is BOOLEANS).
--
-- Gate form (pinned A-8.1/A-8.2): the RAISE form (mirroring
-- get_member_identity_pubkey_for_wrap, 00000000000042:162-167), NOT the
-- WHERE session_is_live() AND is_active_member(...) silent-empty form of
-- concern_list_default (00000000000040:81). The RAISE is load-bearing:
-- P1-8b's /committee route role-gate keys off rls_denied (403) to deny a
-- non-co-chair (A-8.4), so an empty set is NOT an acceptable "not a co-chair"
-- signal. Order: session_is_live() first, then _committee_is_active_co_chair();
-- BOTH branches raise the byte-identical `rls_denied` literal (ERRCODE 42501)
-- so no oracle distinguishes "logged out" from "not a co-chair" (F-178).
--
-- Join shapes (pinned A-8.1):
--   has_identity_key := EXISTS(identity_keys ik WHERE ik.user_id = cm.user_id
--     AND ik.revoked_at IS NULL) — the non-revoked identity, same predicate as
--     the pubkey RPC (00000000000042:181).
--   has_live_wrap    := EXISTS(committee_key_wraps w JOIN committee_data_keys
--     cdk ON cdk.key_id = w.key_id AND cdk.rotated_at IS NULL WHERE
--     w.user_id = cm.user_id) — the LIVE-key wrap, the
--     committee_key_state_for_self join shape (00000000000037:52-60).
--   pending-grant badge := has_identity_key AND NOT has_live_wrap (a UI concept;
--     the function projects the two booleans, the UI derives the badge).
--
-- raw-uid DECISION (A-8.1): the roster returns the RAW user_id (uuid), NOT a
-- pseudonym. B1 is co-chair-only and already discloses display_name /
-- off_employer_contact, so the raw uid adds ZERO incremental deanonymization of
-- the member (the co-chair knows each row by name); every downstream co-chair
-- op is keyed by raw uid; and the uid is NOT an audit-log deanonymization pivot
-- because _committee_pseudonym is REVOKE-ALL-FROM-PUBLIC (00000000000002:205) —
-- the audit pseudonym boundary rests on HMAC-key secrecy, not uid-hiding.
--
-- UNAUDITED (A-8.1): both are bulk list reads (sibling posture to
-- concern_list_default / committee_key_state_for_self) — they disclose
-- has_live_wrap BOOLEANS, not key bytes, so they are NOT the key-material
-- disclosure that A-1's success-only audit governs. No audit_emit here.
--
-- 🔒 B2 (A-8.2): the RETURNS TABLE NEVER projects the invite's TOTP-bootstrap
-- FK (an FK into the TOTP-secret store, 00000000000002:48 — TOTP-secret
-- adjacency), and the BODY reads NO TOTP-secret-adjacent table/column. Only the
-- INVITE metadata (invite_id, target, role, issued_at, expires_at) + the
-- target's display_name (LEFT JOIN users) cross the boundary. expires_at is the
-- INVITE TTL (7 days), never a TOTP window (the TOTP clock is secret-adjacent).
--
-- Templates mirrored:
--   00000000000042:162-167 — the co-chair RAISE-gate form (session_is_live →
--                            active-co-chair, byte-identical rls_denied).
--   00000000000040        — the list-shape SECURITY DEFINER + GRANT/REVOKE.
--   00000000000037:40-66  — committee_key_state_for_self: RETURN QUERY over a
--                            correlated LIVE-key EXISTS + the strict grant matrix.
--   00000000000002:22-54  — committee_membership / users PI / committee_invite.
-- ===========================================================================

-- ###########################################################################
-- B1 — committee_roster_list()   (Amendment A-8.1)
-- ###########################################################################
CREATE OR REPLACE FUNCTION public.committee_roster_list()
RETURNS TABLE(
  user_id               uuid,
  roles                 text[],
  active                boolean,
  invited_at            timestamptz,
  activated_at          timestamptz,
  deactivated_at        timestamptz,
  grace_until           timestamptz,
  display_name          text,
  off_employer_contact  text,
  has_identity_key      boolean,
  has_live_wrap         boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  -- Co-chair RAISE-gate (A-8.1) — session_is_live() FIRST, then active-co-chair.
  -- BOTH raise the byte-identical `rls_denied` (ERRCODE 42501) so no oracle
  -- distinguishes not-live from not-co-chair (F-178). RAISE, not silent-empty:
  -- P1-8b's route keys off the 403 to deny a non-co-chair (A-8.4).
  IF NOT public.session_is_live() THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';  -- F-116: revoked/expired session
  END IF;
  IF NOT public._committee_is_active_co_chair(v_actor) THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;

  -- Every committee_membership row, joined LEFT to its users PI (NULL when the
  -- member has no users PI — the row is NOT dropped, A-8.1 null-PI handling).
  -- The two grant-state badges are correlated EXISTS booleans, NEVER key bytes.
  RETURN QUERY
    SELECT
      cm.user_id,
      cm.role                       AS roles,          -- A-8.1: roles := cm.role
      cm.active,
      cm.invited_at,
      cm.activated_at,
      cm.deactivated_at,
      cm.grace_until,
      u.display_name,                                  -- PI (00000000000002:18-19)
      u.off_employer_contact,                          -- PI
      EXISTS (                                         -- non-revoked identity (0042:181)
        SELECT 1 FROM public.identity_keys ik
         WHERE ik.user_id = cm.user_id
           AND ik.revoked_at IS NULL
      )                             AS has_identity_key,
      EXISTS (                                         -- LIVE-key wrap (0037:52-60)
        SELECT 1
          FROM public.committee_key_wraps w
          JOIN public.committee_data_keys cdk
            ON cdk.key_id = w.key_id
           AND cdk.rotated_at IS NULL
         WHERE w.user_id = cm.user_id
      )                             AS has_live_wrap
      FROM public.committee_membership cm
      LEFT JOIN public.users u ON u.id = cm.user_id
      -- A-8.1: active members first; within a group named rows precede nameless
      -- (NULLS LAST) so the fallback rows sink. Deterministic for the UI + tests.
     ORDER BY cm.active DESC, u.display_name NULLS LAST;
END $$;

-- STRICT posture (A-8.1) — the committee_key_state_for_self matrix
-- (00000000000037:63-66), NOT the looser concern_list_default one: B1 is a
-- co-chair-privileged PI + grant-state projection, so service_role is REVOKED
-- too. anon holding only PUBLIC-inherited privileges is thereby denied.
REVOKE ALL ON FUNCTION public.committee_roster_list() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.committee_roster_list() TO authenticated, supabase_auth_admin;

COMMENT ON FUNCTION public.committee_roster_list() IS
  'A-8.1/F-178 co-chair roster read. STABLE SECURITY DEFINER; co-chair '
  'RAISE-gated (session_is_live then active-co-chair, byte-identical rls_denied '
  '42501). Projects EVERY committee_membership row + its users PI + the '
  'has_identity_key / has_live_wrap grant-state BOOLEANS (never key bytes). '
  'Returns the RAW user_id (A-8.1 raw-uid decision — the co-chair already knows '
  'each row by name; the uid is not an audit-pseudonym pivot). ORDER BY '
  'active DESC, display_name NULLS LAST. UNAUDITED bulk list read.';

-- ###########################################################################
-- B2 — committee_invite_list_pending()   (Amendment A-8.2)
-- ###########################################################################
-- 🔒 The `consumed_at IS NULL` filter lives in the BODY SELECT, not the
-- signature (A-8.2 ISSUE-4 fix — RETURNS TABLE admits no WHERE clause). The
-- projection excludes the invite's TOTP-bootstrap FK by construction, and the
-- body reads no TOTP-secret store — only invite metadata + the target PI.
CREATE OR REPLACE FUNCTION public.committee_invite_list_pending()
RETURNS TABLE(
  invite_id       uuid,
  target_user_id  uuid,
  display_name    text,
  roles           text[],
  issued_at       timestamptz,
  expires_at      timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  -- Same co-chair RAISE-gate as B1 (A-8.2) — byte-identical rls_denied.
  IF NOT public.session_is_live() THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;
  IF NOT public._committee_is_active_co_chair(v_actor) THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;

  -- Unconsumed invites (WHERE ci.consumed_at IS NULL — includes the
  -- expired-unconsumed so the co-chair can see which need action), joined LEFT
  -- to the target's users PI (NULL when absent — the row is NOT dropped).
  RETURN QUERY
    SELECT
      ci.invite_id,
      ci.target_user_id,
      u.display_name,                 -- target PI (LEFT JOIN users)
      ci.role          AS roles,      -- A-8.2: roles := ci.role
      ci.issued_at,
      ci.expires_at                   -- the INVITE TTL (7 days), never a TOTP window
      FROM public.committee_invite ci
      LEFT JOIN public.users u ON u.id = ci.target_user_id
     WHERE ci.consumed_at IS NULL
     ORDER BY ci.issued_at DESC;      -- most-recent invite first (A-8.2)
END $$;

REVOKE ALL ON FUNCTION public.committee_invite_list_pending() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.committee_invite_list_pending() TO authenticated, supabase_auth_admin;

COMMENT ON FUNCTION public.committee_invite_list_pending() IS
  'A-8.2/F-178 co-chair pending-invite read — the ONLY read path for '
  'committee_invite (SELECT fully revoked, 00000000000002:60). STABLE SECURITY '
  'DEFINER; same co-chair RAISE-gate as committee_roster_list. Projects the '
  'unconsumed invites (consumed_at IS NULL in the body; includes '
  'expired-unconsumed) + the target PI, ORDER BY issued_at DESC. NEVER projects '
  'the invite TOTP-bootstrap FK and reads no TOTP-secret store (F-178/F-176). '
  'expires_at is the invite TTL, not a TOTP window. UNAUDITED bulk list read.';
