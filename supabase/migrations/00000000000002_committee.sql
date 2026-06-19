-- ===========================================================================
-- T06.1 — Committee membership server (committee_membership + invite + RLS).
--
-- Server sibling of T06 (ADR-0021 library). Implements ADR-0022.
--
-- Conventions mirror 00000000000001_auth.sql: SECURITY DEFINER mutation
-- functions with write GRANTs REVOKED from authenticated/anon; pseudonymised
-- audit via public.audit_emit; HMAC keyed by the app.hmac_pseudonym_key GUC.
--
-- Single-tenant: there is NO committee_id column or parameter anywhere
-- (ADR-0021 / ADR-0022). Roles are a SET; users.role is the auth mirror.
-- 4-eyes co-chair self-removal is app-enforced in one call (second_approver_id
-- verified as a distinct active co-chair). The member.role_changed strict
-- audit CHECK + retention-schedule row are deferred to T18 (ADR-0022 Q2).
-- ===========================================================================

-- --- C2 profile columns deferred from T05 (ADR-0002 Amendment G.3) -----------
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS display_name          text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS off_employer_contact  text;

-- --- committee_membership ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.committee_membership (
  user_id         uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  role            text[] NOT NULL
                    CHECK (role <@ ARRAY['worker_member','worker_co_chair','certified_member']::text[]
                           AND array_length(role, 1) >= 1),
  active          boolean NOT NULL DEFAULT false,
  invited_by      uuid REFERENCES public.users(id),
  invited_at      timestamptz,
  activated_at    timestamptz,
  deactivated_at  timestamptz,
  grace_until     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.committee_membership ENABLE ROW LEVEL SECURITY;

-- All writes go through the SECURITY DEFINER functions below. The SELECT
-- policy is declared after is_active_member() is defined (see below).
REVOKE INSERT, UPDATE, DELETE ON public.committee_membership FROM authenticated, anon;

-- --- committee_invite (binds an invite to its target; ADR-0022 Q3) -----------
CREATE TABLE IF NOT EXISTS public.committee_invite (
  invite_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Production links the one-time code to the T05 bootstrap (untouched here).
  bootstrap_id     uuid REFERENCES public.auth_totp_bootstraps(id) ON DELETE SET NULL,
  role             text[] NOT NULL,
  issued_by        uuid NOT NULL REFERENCES public.users(id),
  issued_at        timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz
);

CREATE INDEX IF NOT EXISTS committee_invite_target_idx
  ON public.committee_invite (target_user_id);

ALTER TABLE public.committee_invite ENABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.committee_invite FROM authenticated, anon;

-- ===========================================================================
-- retention_class_for — extend with member.role_changed (ADR-0022 Q2).
-- The strict audit_log.event_type CHECK + audit_log_retention_schedule row
-- are owned by T18; this only adds the static class mapping audit_emit stamps.
-- (CREATE OR REPLACE re-declares the whole function with the new arm.)
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
    WHEN 'committee_data_key.wrapped_for_member'          THEN '7y_from_rotation'
    WHEN 'export.generated'                               THEN '7y'
    WHEN 'export.contained_concern_derived_items'         THEN '7y'
    WHEN 'retention.deleted'                              THEN '7y'
    WHEN 'member.added'                                   THEN 'membership+7y'
    WHEN 'member.removed'                                 THEN 'membership+7y'
    WHEN 'member.role_changed'                            THEN 'membership+7y'  -- T06.1 (ADR-0022 Q2)
    WHEN 'alert.fired'                                    THEN '24mo'
    WHEN 'client.cache_policy_violation'                  THEN '90d'
    WHEN 'client.identity_selftest_fail'                  THEN '90d'
    ELSE '24mo'
  END;
$$;
REVOKE EXECUTE ON FUNCTION public.retention_class_for(text) FROM public;
GRANT EXECUTE ON FUNCTION public.retention_class_for(text) TO supabase_auth_admin;

-- ===========================================================================
-- Helpers
-- ===========================================================================

-- Public membership predicate (the T08 is_active_member contract).
CREATE OR REPLACE FUNCTION public.is_active_member(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT COALESCE((SELECT active FROM public.committee_membership WHERE user_id = p_uid), false);
$$;
REVOKE EXECUTE ON FUNCTION public.is_active_member(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_active_member(uuid) TO authenticated, supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- session_is_live — F-116 cross-system revocation gate (ADR-0023 / threat-model
-- §3.12). The minted GoTrue JWT carries the auth_sessions jti as `session_id`;
-- this consults the authoritative revocation list (auth_sessions.revoked_at,
-- F-39) so a revoked/expired session is denied within the same request rather
-- than authorizing for the full token TTL. Default-deny: no claim / no row /
-- revoked / expired => false. (Auth primitive; may relocate to the auth
-- migration when the GoTrue mint path lands — see ADR-0023.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.session_is_live()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.auth_sessions
    WHERE session_id = NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'session_id', '')::uuid
      AND revoked_at IS NULL
      AND expires_at > now()
  );
$$;
REVOKE EXECUTE ON FUNCTION public.session_is_live() FROM public;
GRANT EXECUTE ON FUNCTION public.session_is_live() TO authenticated, supabase_auth_admin;

-- Read = active committee members (the T08 is_active_member contract) with a
-- live session (F-116 / ADR-0023): a revoked-but-unexpired JWT is denied.
CREATE POLICY committee_membership_select_active ON public.committee_membership
  FOR SELECT TO authenticated
  USING (public.session_is_live() AND public.is_active_member(auth.uid()));

CREATE OR REPLACE FUNCTION public._committee_is_active_co_chair(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.committee_membership
    WHERE user_id = p_uid AND active AND 'worker_co_chair' = ANY(role)
  );
$$;

CREATE OR REPLACE FUNCTION public._committee_norm_roles(p_roles text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY(SELECT DISTINCT e FROM unnest(p_roles) AS e ORDER BY e);
$$;

-- Single representative role for the users.role auth mirror (precedence).
CREATE OR REPLACE FUNCTION public._committee_primary_role(p_roles text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN 'worker_co_chair'   = ANY(p_roles) THEN 'worker_co_chair'
    WHEN 'certified_member'  = ANY(p_roles) THEN 'certified_member'
    ELSE 'worker_member'
  END;
$$;

CREATE OR REPLACE FUNCTION public._committee_pseudonym(p_uid uuid)
RETURNS varchar(16)
LANGUAGE sql
STABLE
AS $$
  SELECT LEFT(encode(hmac(p_uid::text::bytea, private._hmac_pseudonym_key()::bytea, 'sha256'), 'hex'), 16)::varchar(16);
$$;

-- `_committee_pseudonym` is an INTERNAL helper, only ever evaluated nested
-- inside the SECURITY DEFINER mutation/audit functions below (where argument
-- evaluation runs as the function owner). It is NOT a public RPC. Postgres
-- defaults new functions to `EXECUTE TO PUBLIC`, which — being in the
-- PostgREST-exposed `public` schema — would otherwise let `authenticated`/
-- `anon` invoke it directly over RPC. Revoke explicitly so the posture is
-- closed-by-construction and matches every other `_`-prefixed internal
-- helper. (Security-reviewer note, HMAC-key-Vault change.) The nested
-- SECURITY DEFINER call paths are unaffected — they run as the owner, which
-- retains EXECUTE as the function's owner.
REVOKE ALL ON FUNCTION public._committee_pseudonym(uuid) FROM PUBLIC;

-- ===========================================================================
-- Mutations (co-chair-gated; mutation + audit in one transaction)
-- ===========================================================================

-- Invite a new member (pending). Returns invite_id. Co-chair-gated.
CREATE OR REPLACE FUNCTION public.committee_invite_member(
  p_target_user_id      uuid,
  p_roles               text[],
  p_display_name        text DEFAULT NULL,
  p_off_employer_contact text DEFAULT NULL,
  p_bootstrap_id        uuid DEFAULT NULL,
  p_ttl_minutes         integer DEFAULT 10080  -- 7 days
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_roles    text[];
  v_existing public.committee_membership%ROWTYPE;
  v_invite   uuid;
BEGIN
  IF NOT public.session_is_live() THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';  -- F-116: revoked/expired session
  END IF;
  IF NOT public._committee_is_active_co_chair(v_actor) THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;
  v_roles := public._committee_norm_roles(p_roles);
  IF array_length(v_roles, 1) IS NULL
     OR NOT (v_roles <@ ARRAY['worker_member','worker_co_chair','certified_member']::text[]) THEN
    RAISE EXCEPTION 'invalid_role';
  END IF;

  SELECT * INTO v_existing FROM public.committee_membership WHERE user_id = p_target_user_id;
  IF FOUND AND v_existing.active THEN RAISE EXCEPTION 'already_active'; END IF;
  IF FOUND AND NOT v_existing.active THEN RAISE EXCEPTION 'membership_exists'; END IF;

  INSERT INTO public.committee_membership (user_id, role, active, invited_by, invited_at)
  VALUES (p_target_user_id, v_roles, false, v_actor, now());

  v_invite := gen_random_uuid();
  INSERT INTO public.committee_invite (invite_id, target_user_id, bootstrap_id, role, issued_by, expires_at)
  VALUES (v_invite, p_target_user_id, p_bootstrap_id, v_roles, v_actor, now() + make_interval(mins => p_ttl_minutes));
  -- No audit here — member.added fires on activation.
  RETURN v_invite;
END;
$$;

-- Consume an invite and activate. The enrolling uid MUST equal the invited
-- target (consumer-binding via the T05 enrollment path). Emits member.added.
CREATE OR REPLACE FUNCTION public.committee_activate_membership(
  p_invite_id      uuid,
  p_enrolling_uid  uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_inv  public.committee_invite%ROWTYPE;
  v_mem  public.committee_membership%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM public.committee_invite WHERE invite_id = p_invite_id;
  IF NOT FOUND OR v_inv.consumed_at IS NOT NULL OR v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'invite_invalid';
  END IF;
  IF v_inv.target_user_id <> p_enrolling_uid THEN
    RAISE EXCEPTION 'invite_invalid';  -- consumer must equal the invited target
  END IF;

  SELECT * INTO v_mem FROM public.committee_membership WHERE user_id = v_inv.target_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_mem.active THEN RAISE EXCEPTION 'already_active'; END IF;
  IF v_mem.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'invite_invalid';  -- a removed member re-enters via reactivate
  END IF;

  UPDATE public.committee_membership
     SET active = true, activated_at = now(), grace_until = NULL, updated_at = now()
   WHERE user_id = v_inv.target_user_id;
  UPDATE public.committee_invite SET consumed_at = now() WHERE invite_id = p_invite_id;
  UPDATE public.users SET role = public._committee_primary_role(v_mem.role), updated_at = now()
   WHERE id = v_inv.target_user_id;

  PERFORM public.audit_emit(
    p_event_type      => 'member.added',
    p_actor_pseudonym => public._committee_pseudonym(v_inv.issued_by),
    p_target_class    => 'C2',
    p_severity        => 'info',
    p_target_id       => v_inv.target_user_id,
    p_meta            => jsonb_build_object('roles', to_jsonb(v_mem.role))
  );
END;
$$;

-- Change a member's role set. Co-chair-gated; emits member.role_changed.
CREATE OR REPLACE FUNCTION public.committee_set_roles(
  p_target_user_id    uuid,
  p_roles             text[],
  p_second_approver_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_next  text[];
  v_mem   public.committee_membership%ROWTYPE;
  v_losing boolean;
BEGIN
  IF NOT public.session_is_live() THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';  -- F-116: revoked/expired session
  END IF;
  IF NOT public._committee_is_active_co_chair(v_actor) THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;
  v_next := public._committee_norm_roles(p_roles);
  IF array_length(v_next, 1) IS NULL
     OR NOT (v_next <@ ARRAY['worker_member','worker_co_chair','certified_member']::text[]) THEN
    RAISE EXCEPTION 'invalid_role';
  END IF;

  SELECT * INTO v_mem FROM public.committee_membership WHERE user_id = p_target_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_mem.role = v_next THEN RETURN; END IF;  -- no-op: no write, no audit

  v_losing := ('worker_co_chair' = ANY(v_mem.role)) AND NOT ('worker_co_chair' = ANY(v_next)) AND v_mem.active;
  IF v_losing THEN
    -- Lock the active co-chair rows, then count (count(*) + FOR UPDATE is
    -- illegal) so concurrent co-chair removals can't both pass the guard.
    PERFORM 1 FROM public.committee_membership
      WHERE active AND 'worker_co_chair' = ANY(role) FOR UPDATE;
    IF (SELECT count(*) FROM public.committee_membership
          WHERE active AND 'worker_co_chair' = ANY(role)) <= 1 THEN
      RAISE EXCEPTION 'last_co_chair';
    END IF;
    IF v_actor = p_target_user_id THEN
      IF p_second_approver_id IS NULL OR p_second_approver_id = v_actor
         OR NOT public._committee_is_active_co_chair(p_second_approver_id) THEN
        RAISE EXCEPTION '4eyes_required' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  UPDATE public.committee_membership SET role = v_next, updated_at = now()
   WHERE user_id = p_target_user_id;
  IF v_mem.active THEN
    UPDATE public.users SET role = public._committee_primary_role(v_next), updated_at = now()
     WHERE id = p_target_user_id;
  END IF;

  PERFORM public.audit_emit(
    p_event_type      => 'member.role_changed',
    p_actor_pseudonym => public._committee_pseudonym(v_actor),
    p_target_class    => 'C2',
    p_severity        => 'info',
    p_target_id       => p_target_user_id,
    p_meta            => jsonb_build_object('roles_before', to_jsonb(v_mem.role), 'roles_after', to_jsonb(v_next))
  );
END;
$$;

-- Remove a member: inactive + 90-day grace. Co-chair-gated; emits member.removed.
CREATE OR REPLACE FUNCTION public.committee_remove_member(
  p_target_user_id    uuid,
  p_second_approver_id uuid DEFAULT NULL
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_mem   public.committee_membership%ROWTYPE;
  v_grace timestamptz;
BEGIN
  IF NOT public.session_is_live() THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';  -- F-116: revoked/expired session
  END IF;
  IF NOT public._committee_is_active_co_chair(v_actor) THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_mem FROM public.committee_membership WHERE user_id = p_target_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT v_mem.active THEN RETURN v_mem.grace_until; END IF;  -- idempotent, no audit

  IF 'worker_co_chair' = ANY(v_mem.role) THEN
    -- Lock the active co-chair rows, then count (count(*) + FOR UPDATE is
    -- illegal) so concurrent co-chair removals can't both pass the guard.
    PERFORM 1 FROM public.committee_membership
      WHERE active AND 'worker_co_chair' = ANY(role) FOR UPDATE;
    IF (SELECT count(*) FROM public.committee_membership
          WHERE active AND 'worker_co_chair' = ANY(role)) <= 1 THEN
      RAISE EXCEPTION 'last_co_chair';
    END IF;
    IF v_actor = p_target_user_id THEN
      IF p_second_approver_id IS NULL OR p_second_approver_id = v_actor
         OR NOT public._committee_is_active_co_chair(p_second_approver_id) THEN
        RAISE EXCEPTION '4eyes_required' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  v_grace := now() + interval '90 days';
  UPDATE public.committee_membership
     SET active = false, deactivated_at = now(), grace_until = v_grace, updated_at = now()
   WHERE user_id = p_target_user_id;
  UPDATE public.users SET role = NULL, updated_at = now() WHERE id = p_target_user_id;

  PERFORM public.audit_emit(
    p_event_type      => 'member.removed',
    p_actor_pseudonym => public._committee_pseudonym(v_actor),
    p_target_class    => 'C2',
    p_severity        => 'info',
    p_target_id       => p_target_user_id,
    p_meta            => jsonb_build_object('grace_until', v_grace)
  );
  RETURN v_grace;
END;
$$;

-- Re-activate a removed member. Co-chair-gated; emits member.added.
CREATE OR REPLACE FUNCTION public.committee_reactivate_member(
  p_target_user_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_mem   public.committee_membership%ROWTYPE;
BEGIN
  IF NOT public.session_is_live() THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';  -- F-116: revoked/expired session
  END IF;
  IF NOT public._committee_is_active_co_chair(v_actor) THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_mem FROM public.committee_membership WHERE user_id = p_target_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_mem.active THEN RAISE EXCEPTION 'already_active'; END IF;

  UPDATE public.committee_membership
     SET active = true, activated_at = now(), grace_until = NULL, updated_at = now()
   WHERE user_id = p_target_user_id;
  UPDATE public.users SET role = public._committee_primary_role(v_mem.role), updated_at = now()
   WHERE id = p_target_user_id;

  PERFORM public.audit_emit(
    p_event_type      => 'member.added',
    p_actor_pseudonym => public._committee_pseudonym(v_actor),
    p_target_class    => 'C2',
    p_severity        => 'info',
    p_target_id       => p_target_user_id,
    p_meta            => jsonb_build_object('roles', to_jsonb(v_mem.role), 'reactivated', true)
  );
END;
$$;

-- Writes are server-only; co-chair gating is enforced inside each function.
REVOKE EXECUTE ON FUNCTION
  public.committee_invite_member(uuid, text[], text, text, uuid, integer),
  public.committee_activate_membership(uuid, uuid),
  public.committee_set_roles(uuid, text[], uuid),
  public.committee_remove_member(uuid, uuid),
  public.committee_reactivate_member(uuid)
FROM public;
GRANT EXECUTE ON FUNCTION
  public.committee_invite_member(uuid, text[], text, text, uuid, integer),
  public.committee_activate_membership(uuid, uuid),
  public.committee_set_roles(uuid, text[], uuid),
  public.committee_remove_member(uuid, uuid),
  public.committee_reactivate_member(uuid)
TO authenticated, supabase_auth_admin;
