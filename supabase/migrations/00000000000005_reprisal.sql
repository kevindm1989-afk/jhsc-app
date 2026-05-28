-- ===========================================================================
-- T13.1 — Reprisal log server (reprisal_log + 4-eyes + forensic reveal).
--
-- Server sibling of T13 (ADR-0007 amendment library). Mirrors the SQL the
-- MemoryReprisalStore / reprisal-core.ts contract encodes:
--   submitReprisal       → reprisal_submit          (F-17 actor-always, F-35 rate)
--   readReprisalEntry    → reprisal_read            (HG-6 audit-before-return,
--                                                    G-T13-6 per-record passphrase)
--   updateReprisalText   → reprisal_update          (F-31 prev_field_hashes)
--   propose/approveStatus→ reprisal_propose_status /reprisal_approve_status (HG-7 4-eyes)
--   propose/approveForensic→ reprisal_propose_forensic/reprisal_approve_forensic
--                                                    (Amendment E: 24h, role-pair)
--   listReprisalFeed     → reprisal_feed view       (Amendment D: pseudonymized,
--                                                    ts bucketed to hour, no actor)
--
-- Conventions mirror 00000000000002_committee.sql / 0004_concerns.sql:
-- SECURITY DEFINER functions, writes/reads mediated + REVOKED from
-- authenticated/anon, gate on session_is_live() (F-116) AND is_active_member()
-- (F-15/F-30), pseudonymised audit via audit_emit + _committee_pseudonym.
--
-- E2EE (ADR-0003 Invariant 1): title/body are sealed CLIENT-SIDE; this layer
-- only ever sees ciphertext. The per-record passphrase (F-34 friction gate, not
-- the crypto gate) is hashed server-side (pgcrypto bf). NB: no PG15-only view
-- options — the vanilla pgTAP CI job is PG14.
--
-- Pending-op storage is ONE unified table (architect decision, matching the
-- shipped PendingFourEyesOp library type; confirms G-T13-11 column names).
-- New audit-enum values (G-T13-14) + ADR-0016 schedule + §PI inventory are the
-- governance fold-in (drafted separately). Concern audit/reprisal audit rows
-- carry target_id, so audit_emit's "default class + target_id ⇒ match_underlying"
-- gives them the reprisal_log 7y retention; no retention_class_for arm added.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- reprisal_log — the highest-sensitivity (C4 body) record. No anonymous mode.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reprisal_log (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id                    uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,  -- F-17
  title_ct                    bytea NOT NULL,                 -- committee-key sealed
  body_ct                     bytea NOT NULL,                 -- committee-key sealed (C4)
  per_record_passphrase_hash  text,                           -- pgcrypto bf (G-T13-6)
  status                      text NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open','under_review','closed','deleted')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reprisal_log_actor_idx ON public.reprisal_log (actor_id);

ALTER TABLE public.reprisal_log ENABLE ROW LEVEL SECURITY;
-- All access mediated by the SECURITY DEFINER functions below; the C4 body is
-- never directly SELECTable (HG-6 — reads MUST go through reprisal_read so the
-- access is audited before the ciphertext is returned).
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.reprisal_log FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- pending_four_eyes_ops — unified 4-eyes ledger (status flips + forensic
-- reveals). HG-7 / Amendment E. Reachable only via the SECURITY DEFINER
-- propose/approve functions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pending_four_eyes_ops (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                      text NOT NULL CHECK (kind IN ('status_flip','forensic_reveal')),
  proposer_id               uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  approver_id               uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  target_table              text NOT NULL CHECK (target_table IN ('reprisal_log','audit_log')),
  target_id                 text NOT NULL,                    -- reprisal uuid OR audit_log id
  new_status                text CHECK (new_status IN ('open','under_review','closed','deleted')),
  reveal_reason             text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  expires_at                timestamptz,                      -- 24h for forensic; NULL for status flips
  expired_at                timestamptz,
  revealed_actor_pseudonym  varchar(16)
);
CREATE INDEX IF NOT EXISTS pending_four_eyes_target_idx ON public.pending_four_eyes_ops (target_table, target_id);

ALTER TABLE public.pending_four_eyes_ops ENABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.pending_four_eyes_ops FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- reprisal_rate_log + consume_reprisal_rate_budget — F-35 (mirrors concerns).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reprisal_rate_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reprisal_rate_log_actor_time_idx ON public.reprisal_rate_log (actor_id, created_at);
ALTER TABLE public.reprisal_rate_log ENABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.reprisal_rate_log FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.consume_reprisal_rate_budget(p_actor_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_hour integer; v_day integer;
BEGIN
  SELECT count(*) INTO v_hour FROM public.reprisal_rate_log
    WHERE actor_id = p_actor_id AND created_at > now() - interval '1 hour';
  IF v_hour >= 20 THEN RETURN false; END IF;
  SELECT count(*) INTO v_day FROM public.reprisal_rate_log
    WHERE actor_id = p_actor_id AND created_at > now() - interval '24 hours';
  IF v_day >= 200 THEN RETURN false; END IF;
  INSERT INTO public.reprisal_rate_log (actor_id) VALUES (p_actor_id);
  RETURN true;
END $$;
REVOKE EXECUTE ON FUNCTION public.consume_reprisal_rate_budget(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Dedicated least-privilege C4-read roles (HG-6 / Amendment E). NOLOGIN —
-- reachable only via a role JWT; the Edge Function path also reaches the
-- functions as `authenticated` (the gate is enforced inside each).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'c4_read_service') THEN
    CREATE ROLE c4_read_service NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'forensic_read_service') THEN
    CREATE ROLE forensic_read_service NOLOGIN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    GRANT c4_read_service, forensic_read_service TO authenticator;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Gate + role helpers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._reprisal_gate()
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
BEGIN
  IF NOT public.session_is_live() THEN RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501'; END IF;
  IF NOT public.is_active_member(auth.uid()) THEN RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public._reprisal_is_cochair(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$ SELECT EXISTS (SELECT 1 FROM public.committee_membership
  WHERE user_id = p_uid AND active AND 'worker_co_chair' = ANY(role)); $$;

CREATE OR REPLACE FUNCTION public._reprisal_is_certified(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$ SELECT EXISTS (SELECT 1 FROM public.committee_membership
  WHERE user_id = p_uid AND active AND 'certified_member' = ANY(role)); $$;

-- Role-pair rule (Amendment E): co-chair+co-chair OR co-chair+certified.
CREATE OR REPLACE FUNCTION public._reprisal_valid_pair(p_proposer uuid, p_approver uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
  SELECT (public._reprisal_is_cochair(p_proposer) AND public._reprisal_is_cochair(p_approver))
      OR (public._reprisal_is_cochair(p_proposer) AND public._reprisal_is_certified(p_approver))
      OR (public._reprisal_is_certified(p_proposer) AND public._reprisal_is_cochair(p_approver));
$$;

-- jhsc_forensic_reveal_actor_pseudonym — resolve the actor_pseudonym recorded
-- on a target audit_log row (forensic_read_service surface, Amendment E).
CREATE OR REPLACE FUNCTION public.jhsc_forensic_reveal_actor_pseudonym(p_audit_log_id text)
RETURNS varchar(16)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
  SELECT actor_pseudonym FROM public.audit_log WHERE id = NULLIF(p_audit_log_id, '')::bigint;
$$;
REVOKE EXECUTE ON FUNCTION public.jhsc_forensic_reveal_actor_pseudonym(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jhsc_forensic_reveal_actor_pseudonym(text) TO forensic_read_service, supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- reprisal_submit — gate → rate → insert → audit (F-17, F-35).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reprisal_submit(
  p_title_ct bytea, p_body_ct bytea, p_passphrase text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_actor uuid := auth.uid(); v_id uuid; v_hash text;
BEGIN
  PERFORM public._reprisal_gate();
  IF NOT public.consume_reprisal_rate_budget(v_actor) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
  END IF;
  IF p_passphrase IS NOT NULL AND length(p_passphrase) > 0 THEN
    v_hash := crypt(p_passphrase, gen_salt('bf'));
  END IF;
  INSERT INTO public.reprisal_log (actor_id, title_ct, body_ct, per_record_passphrase_hash)
    VALUES (v_actor, p_title_ct, p_body_ct, v_hash)
    RETURNING id INTO v_id;
  PERFORM public.audit_emit(
    p_event_type => 'reprisal.created', p_actor_pseudonym => public._committee_pseudonym(v_actor),
    p_target_class => 'C4', p_severity => 'notice', p_target_id => v_id,
    p_meta => jsonb_build_object('created', true));
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- reprisal_read — HG-6 audit-before-return + per-record passphrase (G-T13-6).
-- Wrong passphrase emits sensitive.access_attempt and returns NO rows (without
-- aborting, so the attempt audit persists). Correct passphrase emits
-- reprisal.read BEFORE returning the ciphertext; if the audit insert fails the
-- whole function aborts and no ciphertext is returned.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reprisal_read(p_id uuid, p_passphrase text DEFAULT NULL)
RETURNS TABLE(title_ct bytea, body_ct bytea)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_actor uuid := auth.uid(); v_row public.reprisal_log%ROWTYPE;
BEGIN
  PERFORM public._reprisal_gate();
  SELECT * INTO v_row FROM public.reprisal_log WHERE id = p_id;
  IF NOT FOUND THEN RETURN; END IF;                          -- not found: no rows, no audit

  IF v_row.per_record_passphrase_hash IS NOT NULL
     AND (p_passphrase IS NULL OR crypt(p_passphrase, v_row.per_record_passphrase_hash) <> v_row.per_record_passphrase_hash) THEN
    PERFORM public.audit_emit(
      p_event_type => 'sensitive.access_attempt', p_actor_pseudonym => public._committee_pseudonym(v_actor),
      p_target_class => 'C4', p_severity => 'warn', p_target_id => p_id,
      p_meta => jsonb_build_object('reason', 'wrong_passphrase'));
    RETURN;                                                  -- denied: no ciphertext
  END IF;

  PERFORM public.audit_emit(
    p_event_type => 'reprisal.read', p_actor_pseudonym => public._committee_pseudonym(v_actor),
    p_target_class => 'C4', p_severity => 'notice', p_target_id => p_id,
    p_meta => jsonb_build_object('read_via', 'security_definer_view'));
  RETURN QUERY SELECT v_row.title_ct, v_row.body_ct;
END $$;

-- ---------------------------------------------------------------------------
-- reprisal_update — F-31 prev_field_hashes (server-computed SHA-256 of prior ct).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reprisal_update(
  p_id uuid, p_title_ct bytea DEFAULT NULL, p_body_ct bytea DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_actor uuid := auth.uid(); v_row public.reprisal_log%ROWTYPE; v_prev jsonb := '{}'::jsonb;
BEGIN
  PERFORM public._reprisal_gate();
  SELECT * INTO v_row FROM public.reprisal_log WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF p_title_ct IS NOT NULL THEN
    v_prev := v_prev || jsonb_build_object('title_ct', encode(digest(v_row.title_ct, 'sha256'), 'hex'));
    UPDATE public.reprisal_log SET title_ct = p_title_ct WHERE id = p_id;
  END IF;
  IF p_body_ct IS NOT NULL THEN
    v_prev := v_prev || jsonb_build_object('body_ct', encode(digest(v_row.body_ct, 'sha256'), 'hex'));
    UPDATE public.reprisal_log SET body_ct = p_body_ct WHERE id = p_id;
  END IF;
  UPDATE public.reprisal_log SET updated_at = now() WHERE id = p_id;
  PERFORM public.audit_emit(
    p_event_type => 'reprisal.update', p_actor_pseudonym => public._committee_pseudonym(v_actor),
    p_target_class => 'C4', p_severity => 'notice', p_target_id => p_id,
    p_meta => jsonb_build_object('prev_field_hashes', v_prev));
END $$;

-- ---------------------------------------------------------------------------
-- 4-eyes status flip (HG-7).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reprisal_propose_status(p_reprisal_id uuid, p_new_status text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_actor uuid := auth.uid(); v_id uuid;
BEGIN
  PERFORM public._reprisal_gate();
  IF p_new_status NOT IN ('open','under_review','closed','deleted') THEN RAISE EXCEPTION 'invalid_status'; END IF;
  INSERT INTO public.pending_four_eyes_ops (kind, proposer_id, target_table, target_id, new_status)
    VALUES ('status_flip', v_actor, 'reprisal_log', p_reprisal_id::text, p_new_status)
    RETURNING id INTO v_id;
  PERFORM public.audit_emit(
    p_event_type => 'reprisal.status_changed.4eyes_pending', p_actor_pseudonym => public._committee_pseudonym(v_actor),
    p_target_class => 'C4', p_severity => 'notice', p_target_id => p_reprisal_id,
    p_meta => jsonb_build_object('target_status', p_new_status, 'pending_id', v_id));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.reprisal_approve_status(p_pending_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_actor uuid := auth.uid(); v_p public.pending_four_eyes_ops%ROWTYPE;
BEGIN
  PERFORM public._reprisal_gate();
  SELECT * INTO v_p FROM public.pending_four_eyes_ops WHERE id = p_pending_id AND kind = 'status_flip' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_p.proposer_id = v_actor THEN RAISE EXCEPTION 'self_approve_denied' USING ERRCODE = '42501'; END IF;
  IF NOT public._reprisal_valid_pair(v_p.proposer_id, v_actor) THEN RAISE EXCEPTION 'role_pair_invalid' USING ERRCODE = '42501'; END IF;

  UPDATE public.pending_four_eyes_ops SET approver_id = v_actor WHERE id = p_pending_id;
  UPDATE public.reprisal_log SET status = v_p.new_status, updated_at = now() WHERE id = v_p.target_id::uuid;
  PERFORM public.audit_emit(
    p_event_type => 'reprisal.status_changed.4eyes_completed', p_actor_pseudonym => public._committee_pseudonym(v_actor),
    p_target_class => 'C4', p_severity => 'notice', p_target_id => v_p.target_id::uuid,
    p_meta => jsonb_build_object('target_status', v_p.new_status,
      'proposer_actor_pseudonym', public._committee_pseudonym(v_p.proposer_id),
      'approver_actor_pseudonym', public._committee_pseudonym(v_actor), 'pending_id', p_pending_id));
END $$;

-- ---------------------------------------------------------------------------
-- 4-eyes forensic reveal (Amendment E): 24h expiry + role-pair; on approve,
-- the target audit row's actor_pseudonym is revealed for ≤24h.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reprisal_propose_forensic(p_audit_log_id text, p_reveal_reason text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_actor uuid := auth.uid(); v_id uuid;
BEGIN
  PERFORM public._reprisal_gate();
  INSERT INTO public.pending_four_eyes_ops (kind, proposer_id, target_table, target_id, reveal_reason, expires_at)
    VALUES ('forensic_reveal', v_actor, 'audit_log', p_audit_log_id, p_reveal_reason, now() + interval '24 hours')
    RETURNING id INTO v_id;
  PERFORM public.audit_emit(
    p_event_type => 'audit.forensic_reveal.4eyes_pending', p_actor_pseudonym => public._committee_pseudonym(v_actor),
    p_target_class => 'C4', p_severity => 'warn', p_target_id => NULL,
    p_meta => jsonb_build_object('reveal_reason', p_reveal_reason, 'audit_log_id', p_audit_log_id, 'pending_id', v_id));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.reprisal_approve_forensic(p_pending_id uuid)
RETURNS varchar(16)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_actor uuid := auth.uid(); v_p public.pending_four_eyes_ops%ROWTYPE; v_revealed varchar(16);
BEGIN
  PERFORM public._reprisal_gate();
  SELECT * INTO v_p FROM public.pending_four_eyes_ops WHERE id = p_pending_id AND kind = 'forensic_reveal' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_p.proposer_id = v_actor THEN RAISE EXCEPTION 'self_approve_denied' USING ERRCODE = '42501'; END IF;
  IF v_p.expires_at IS NOT NULL AND now() > v_p.expires_at THEN RAISE EXCEPTION 'expired' USING ERRCODE = 'P0001'; END IF;
  IF NOT public._reprisal_valid_pair(v_p.proposer_id, v_actor) THEN RAISE EXCEPTION 'role_pair_invalid' USING ERRCODE = '42501'; END IF;

  v_revealed := public.jhsc_forensic_reveal_actor_pseudonym(v_p.target_id);
  UPDATE public.pending_four_eyes_ops SET approver_id = v_actor, revealed_actor_pseudonym = v_revealed WHERE id = p_pending_id;
  PERFORM public.audit_emit(
    p_event_type => 'audit.forensic_reveal.4eyes_completed', p_actor_pseudonym => public._committee_pseudonym(v_actor),
    p_target_class => 'C4', p_severity => 'warn', p_target_id => NULL,
    p_meta => jsonb_build_object('reveal_reason', v_p.reveal_reason,
      'proposer_actor_pseudonym', public._committee_pseudonym(v_p.proposer_id),
      'approver_actor_pseudonym', public._committee_pseudonym(v_actor), 'pending_id', p_pending_id));
  RETURN v_revealed;
END $$;

-- expire_forensic_reveals — clears revealed_actor_pseudonym past the 24h window
-- (the T16 sweep / a scheduled job calls this; reveal reads must re-check expiry).
CREATE OR REPLACE FUNCTION public.expire_forensic_reveals()
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE public.pending_four_eyes_ops
     SET expired_at = now(), revealed_actor_pseudonym = NULL
   WHERE kind = 'forensic_reveal' AND expires_at IS NOT NULL AND now() > expires_at AND expired_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE EXECUTE ON FUNCTION public.expire_forensic_reveals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_forensic_reveals() TO supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- reprisal_feed view — Amendment D pseudonymized projection. reprisal.* only;
-- ts bucketed DOWN to the hour; NO actor_pseudonym. Gated to live active members.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.reprisal_feed AS
  SELECT
    a.id,
    a.event_type,
    (extract(epoch from date_trunc('hour', a.ts)) * 1000)::bigint AS ts_bucketed_to_hour,
    a.target_id,
    a.target_class,
    encode(a.prev_hash, 'hex') AS prev_hash,
    encode(a.hash, 'hex')      AS hash
  FROM public.audit_log a
  WHERE a.event_type LIKE 'reprisal.%'
    AND public.session_is_live() AND public.is_active_member(auth.uid());
REVOKE ALL ON public.reprisal_feed FROM PUBLIC, anon;
GRANT SELECT ON public.reprisal_feed TO authenticated, supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Grants — the gated/audited functions are reachable by active members (the
-- gate is enforced inside each); the dedicated C4-read roles also hold them.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  public.reprisal_submit(bytea, bytea, text),
  public.reprisal_read(uuid, text),
  public.reprisal_update(uuid, bytea, bytea),
  public.reprisal_propose_status(uuid, text),
  public.reprisal_approve_status(uuid),
  public.reprisal_propose_forensic(text, text),
  public.reprisal_approve_forensic(uuid)
FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION
  public.reprisal_submit(bytea, bytea, text),
  public.reprisal_update(uuid, bytea, bytea),
  public.reprisal_propose_status(uuid, text),
  public.reprisal_approve_status(uuid),
  public.reprisal_propose_forensic(text, text)
TO authenticated, supabase_auth_admin;

-- C4 body read is the dedicated c4_read_service surface (HG-6); forensic
-- approve is the forensic_read_service surface (Amendment E). Both also
-- reachable as authenticated (the gate is internal).
GRANT EXECUTE ON FUNCTION public.reprisal_read(uuid, text) TO authenticated, c4_read_service, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.reprisal_approve_forensic(uuid) TO authenticated, forensic_read_service, supabase_auth_admin;
