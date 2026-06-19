-- ===========================================================================
-- ADR-0025 / first-co-chair bootstrap — one-shot cold-instance enrollment.
-- ===========================================================================
--
-- Problem: a freshly-deployed instance has zero users. Normal first-passkey
-- enrollment (public.enroll_first_passkey, migration 0001) requires a CO-CHAIR
-- to have issued a TOTP bootstrap row for the new worker — but the very first
-- co-chair has nobody to issue theirs, and no existing session. There is no
-- self-service path to create the first `public.users` row + bind the first
-- passkey. This function is that path, gated so it can run EXACTLY ONCE.
--
-- Security posture (ADR-0025 STRIDE — the guard is load-bearing):
--   * One-shot guard: `pg_advisory_xact_lock` serialises concurrent callers,
--     then an in-transaction `EXISTS (SELECT 1 FROM public.users)` check
--     aborts if ANY user already exists. The lock closes the TOCTOU race
--     (two simultaneous callers cannot both pass the empty-table check). The
--     guard is SELF-DISABLING: once the first user row commits, the check can
--     NEVER pass again — strictly stronger than a toggle flag.
--   * Reachable ONLY by `mint_writer` (the isolated NOLOGIN role the bootstrap
--     Edge Function assumes via a self-minted token — same least-privilege
--     identity as mint-session; NOT service_role). REVOKE from PUBLIC/anon/
--     authenticated/service_role so an unauthenticated REST caller cannot
--     reach it despite the EF being verify_jwt=false.
--   * Every successful bootstrap emits audit rows in the SAME transaction
--     (member.added + auth.passkey.enrolled — both already in the closed
--     event_type enum; no enum extension needed).
--   * Operator MUST delete the bootstrap Edge Function after first use
--     (ADR-0025 task A4); the count=0 guard already prevents re-creation, this
--     is belt-and-braces against a future enumeration/probe surface.
--
-- The first co-chair is created ACTIVE with role worker_co_chair in both
-- public.users and public.committee_membership so they can immediately invite
-- the rest of the committee through the normal co-chair-gated flows.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.bootstrap_first_co_chair(
  p_credential_id  text,
  p_public_key     bytea,
  p_aaguid         uuid,
  p_transports     text[],
  p_rp_id          text,
  p_device_label   text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user_id   uuid := gen_random_uuid();
  v_pseudonym varchar(16);
BEGIN
  -- Serialise concurrent callers so the empty-table check below is race-safe
  -- (closes the TOCTOU: two callers cannot both observe zero users and both
  -- insert). Transaction-scoped; released at COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(hashtext('jhsc.bootstrap_first_co_chair'));

  -- One-shot guard. Self-disabling: after the first user commits this can
  -- never pass again.
  IF EXISTS (SELECT 1 FROM public.users) THEN
    RAISE EXCEPTION 'BOOTSTRAP_ALREADY_DONE' USING ERRCODE = 'P0001';
  END IF;

  -- Defensive: a credential id must not already exist (it cannot if there are
  -- no users, but fail loud rather than silently collide).
  IF EXISTS (SELECT 1 FROM public.webauthn_credentials WHERE credential_id = p_credential_id) THEN
    RAISE EXCEPTION 'BOOTSTRAP_CREDENTIAL_EXISTS' USING ERRCODE = 'P0001';
  END IF;

  -- 1. The first co-chair's profile row (active worker_co_chair).
  INSERT INTO public.users (id, active, role)
    VALUES (v_user_id, true, 'worker_co_chair');

  -- 2. Their committee membership (active co-chair; self-bootstrapped, so
  --    invited_by is NULL — there is no prior member to attribute it to).
  INSERT INTO public.committee_membership (user_id, role, active, activated_at)
    VALUES (v_user_id, ARRAY['worker_co_chair']::text[], true, now());

  -- 3. Bind the first passkey (the WebAuthn ceremony ran in the browser; the
  --    public key + credential id are passed in).
  INSERT INTO public.webauthn_credentials (
    credential_id, user_id, public_key, aaguid, transports, rp_id, device_label
  )
  VALUES (
    p_credential_id, v_user_id, p_public_key, p_aaguid, p_transports, p_rp_id, p_device_label
  );

  -- Pseudonymise the new actor for the audit rows (keyed HMAC via the
  -- GUC-or-Vault accessor; never the raw uid).
  v_pseudonym := public._committee_pseudonym(v_user_id);

  -- 4a. Audit the membership creation (member.added — C2, in the closed enum).
  PERFORM public.audit_emit(
    p_event_type      => 'member.added',
    p_actor_pseudonym => v_pseudonym,
    p_target_class    => 'C2',
    p_severity        => 'info',
    p_request_id      => NULL,
    p_target_id       => v_user_id,
    p_meta            => jsonb_build_object('bootstrap', true, 'role', 'worker_co_chair')
  );

  -- 4b. Audit the passkey binding (auth.passkey.enrolled — C1, in the closed
  --     enum; mirrors enroll_first_passkey's audit shape).
  PERFORM public.audit_emit(
    p_event_type      => 'auth.passkey.enrolled',
    p_actor_pseudonym => v_pseudonym,
    p_target_class    => 'C1',
    p_severity        => 'info',
    p_request_id      => NULL,
    p_meta            => jsonb_build_object(
      'bootstrap', true,
      'cred_id_pseudonym',
        LEFT(encode(hmac(p_credential_id::bytea, private._hmac_pseudonym_key()::bytea, 'sha256'), 'hex'), 16)
    )
  );

  RETURN v_user_id;
END;
$$;

-- Reachable ONLY by mint_writer (the bootstrap EF's self-minted least-privilege
-- identity). Closed to every REST-reachable role so the verify_jwt=false EF
-- cannot be bypassed by a direct anon/authenticated RPC.
REVOKE ALL ON FUNCTION public.bootstrap_first_co_chair(text, bytea, uuid, text[], text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bootstrap_first_co_chair(text, bytea, uuid, text[], text, text)
  TO mint_writer;

COMMENT ON FUNCTION public.bootstrap_first_co_chair(text, bytea, uuid, text[], text, text) IS
  'ADR-0025: one-shot first-co-chair cold-instance enrollment. Advisory-lock + count=0 guard (self-disabling). mint_writer-only. Delete the bootstrap Edge Function after first use (ADR-0025 A4).';
