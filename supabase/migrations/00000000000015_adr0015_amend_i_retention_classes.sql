-- ===========================================================================
-- ADR-0015 Amendment I (M0 closure for M1 + M2):
--   Extend retention_class_for() with three new event-types, all '24mo':
--     • key_parity.mismatch          — F-125 forensic anchor (M2)
--     • key_parity.deploy_ok         — forensic asymmetry protection (M2)
--     • auth.mint.revoked_during_mint — F-128 race detector (M1)
--
-- Authoritative ADRs: ADR-0015 Amendment I (`.context/decisions.md`),
--   threat-model.md §3.14 F-124 / F-125 / F-127 / F-128.
--
-- This migration only re-stamps the static lookup audit_emit calls at write
-- time. The strict CHECK constraint on audit_log.event_type is still owned
-- by T18 (see 00000000000001_auth.sql:42-45 architect note).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.retention_class_for(p_event_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, extensions
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
    ELSE '24mo'
  END;
$$;
REVOKE EXECUTE ON FUNCTION public.retention_class_for(text) FROM public;
GRANT EXECUTE ON FUNCTION public.retention_class_for(text) TO supabase_auth_admin;
