-- ===========================================================================
-- T14.1 — Work-refusal (s.43) + s.51 evidence server.
--
-- Server sibling of T14. Mirrors the SQL the Memory{WorkRefusal,S51Evidence}Store
-- / *-core.ts contracts encode, reusing the T13 C4-read pattern:
--   work_refusal_submit / _read / _update      (F-21 + HG-6 + F-31-style update)
--   s51_evidence_submit / _read / _update       (+ photos_ct array)
--
-- F-21: INSERT/UPDATE require is_certified_member(); the audited read view is
-- reachable by is_certified_or_cochair() (co-chairs read but cannot write).
-- HG-6: reads go through the SECURITY DEFINER read functions, which audit
-- BEFORE returning the ciphertext (sharing the T13 c4_read_service role). The
-- per-record passphrase (G-T14-5/10, option b) is verified inside the read.
-- Amendment D extension: work_refusal.* / s51_evidence.* events join the
-- pseudonymized reprisal_feed.
--
-- Conventions mirror 0005_reprisal.sql. E2EE: notes/title/photos are sealed
-- CLIENT-SIDE; this layer sees only ciphertext. PG14-safe (no security_invoker).
-- New audit-enum values (G-T14-7) + ADR-0016 schedule + §PI inventory are the
-- governance fold-in (drafted separately).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- F-21 membership predicates.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_certified_member(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$ SELECT EXISTS (SELECT 1 FROM public.committee_membership
  WHERE user_id = p_uid AND active AND 'certified_member' = ANY(role)); $$;
REVOKE EXECUTE ON FUNCTION public.is_certified_member(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_certified_member(uuid) TO authenticated, supabase_auth_admin;

CREATE OR REPLACE FUNCTION public.is_certified_or_cochair(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$ SELECT EXISTS (SELECT 1 FROM public.committee_membership
  WHERE user_id = p_uid AND active AND ('certified_member' = ANY(role) OR 'worker_co_chair' = ANY(role))); $$;
REVOKE EXECUTE ON FUNCTION public.is_certified_or_cochair(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_certified_or_cochair(uuid) TO authenticated, supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Tables (C4 notes / photos). All access mediated; direct read/write denied.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.work_refusal (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id                    uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,  -- F-17 (statutory filer)
  title_ct                    bytea NOT NULL,
  notes_ct                    bytea NOT NULL,                 -- s.43 narrative (C4)
  per_record_passphrase_hash  text,
  status                      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','closed')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_refusal_actor_idx ON public.work_refusal (actor_id);
ALTER TABLE public.work_refusal ENABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.work_refusal FROM authenticated, anon;

CREATE TABLE IF NOT EXISTS public.s51_evidence (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id                    uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  title_ct                    bytea NOT NULL,
  notes_ct                    bytea NOT NULL,                 -- s.51 narrative (C4)
  photos_ct                   bytea[] NOT NULL DEFAULT '{}',  -- per-photo sealed blobs (C4)
  per_record_passphrase_hash  text,
  status                      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','closed')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS s51_evidence_actor_idx ON public.s51_evidence (actor_id);
ALTER TABLE public.s51_evidence ENABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.s51_evidence FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- F-21 gates.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._t14_gate_write()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
BEGIN
  IF NOT public.session_is_live() THEN RAISE EXCEPTION 'rls_denied' USING ERRCODE='42501'; END IF;
  IF NOT public.is_certified_member(auth.uid()) THEN RAISE EXCEPTION 'rls_denied' USING ERRCODE='42501'; END IF;  -- F-21 write
END $$;

CREATE OR REPLACE FUNCTION public._t14_gate_read()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
BEGIN
  IF NOT public.session_is_live() THEN RAISE EXCEPTION 'rls_denied' USING ERRCODE='42501'; END IF;
  IF NOT public.is_certified_or_cochair(auth.uid()) THEN RAISE EXCEPTION 'rls_denied' USING ERRCODE='42501'; END IF;  -- F-21 read
END $$;

-- ---------------------------------------------------------------------------
-- work_refusal_submit / _read / _update.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.work_refusal_submit(p_title_ct bytea, p_notes_ct bytea, p_passphrase text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_actor uuid := auth.uid(); v_id uuid; v_hash text;
BEGIN
  PERFORM public._t14_gate_write();
  IF p_passphrase IS NOT NULL AND length(p_passphrase) > 0 THEN v_hash := crypt(p_passphrase, gen_salt('bf')); END IF;
  INSERT INTO public.work_refusal (actor_id, title_ct, notes_ct, per_record_passphrase_hash)
    VALUES (v_actor, p_title_ct, p_notes_ct, v_hash) RETURNING id INTO v_id;
  PERFORM public.audit_emit('work_refusal.created', public._committee_pseudonym(v_actor), 'C4', 'notice', NULL, v_id, NULL,
    jsonb_build_object('created', true));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.work_refusal_read(p_id uuid, p_passphrase text DEFAULT NULL)
RETURNS TABLE(title_ct bytea, notes_ct bytea) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_actor uuid := auth.uid(); v_row public.work_refusal%ROWTYPE;
BEGIN
  PERFORM public._t14_gate_read();
  SELECT * INTO v_row FROM public.work_refusal WHERE id = p_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_row.per_record_passphrase_hash IS NOT NULL
     AND (p_passphrase IS NULL OR crypt(p_passphrase, v_row.per_record_passphrase_hash) <> v_row.per_record_passphrase_hash) THEN
    PERFORM public.audit_emit('sensitive.access_attempt', public._committee_pseudonym(v_actor), 'C4', 'warn', NULL, p_id, NULL,
      jsonb_build_object('reason','wrong_passphrase','table','work_refusal'));
    RETURN;
  END IF;
  PERFORM public.audit_emit('work_refusal.read', public._committee_pseudonym(v_actor), 'C4', 'notice', NULL, p_id, NULL,
    jsonb_build_object('read_via','security_definer_view'));
  RETURN QUERY SELECT v_row.title_ct, v_row.notes_ct;
END $$;

CREATE OR REPLACE FUNCTION public.work_refusal_update(p_id uuid, p_title_ct bytea DEFAULT NULL, p_notes_ct bytea DEFAULT NULL)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_actor uuid := auth.uid(); v_row public.work_refusal%ROWTYPE; v_prev jsonb := '{}'::jsonb;
BEGIN
  PERFORM public._t14_gate_write();
  SELECT * INTO v_row FROM public.work_refusal WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF p_title_ct IS NOT NULL THEN
    v_prev := v_prev || jsonb_build_object('title_ct', encode(digest(v_row.title_ct,'sha256'),'hex'));
    UPDATE public.work_refusal SET title_ct = p_title_ct WHERE id = p_id;
  END IF;
  IF p_notes_ct IS NOT NULL THEN
    v_prev := v_prev || jsonb_build_object('notes_ct', encode(digest(v_row.notes_ct,'sha256'),'hex'));
    UPDATE public.work_refusal SET notes_ct = p_notes_ct WHERE id = p_id;
  END IF;
  UPDATE public.work_refusal SET updated_at = now() WHERE id = p_id;
  PERFORM public.audit_emit('work_refusal.update', public._committee_pseudonym(v_actor), 'C4', 'notice', NULL, p_id, NULL,
    jsonb_build_object('prev_field_hashes', v_prev));
END $$;

-- ---------------------------------------------------------------------------
-- s51_evidence_submit / _read / _update (with photos_ct array).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.s51_evidence_submit(
  p_title_ct bytea, p_notes_ct bytea, p_photos_ct bytea[] DEFAULT '{}', p_passphrase text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_actor uuid := auth.uid(); v_id uuid; v_hash text;
BEGIN
  PERFORM public._t14_gate_write();
  IF p_passphrase IS NOT NULL AND length(p_passphrase) > 0 THEN v_hash := crypt(p_passphrase, gen_salt('bf')); END IF;
  INSERT INTO public.s51_evidence (actor_id, title_ct, notes_ct, photos_ct, per_record_passphrase_hash)
    VALUES (v_actor, p_title_ct, p_notes_ct, COALESCE(p_photos_ct, '{}'), v_hash) RETURNING id INTO v_id;
  PERFORM public.audit_emit('s51_evidence.created', public._committee_pseudonym(v_actor), 'C4', 'notice', NULL, v_id, NULL,
    jsonb_build_object('created', true, 'photo_count', COALESCE(array_length(p_photos_ct, 1), 0)));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.s51_evidence_read(p_id uuid, p_passphrase text DEFAULT NULL)
RETURNS TABLE(title_ct bytea, notes_ct bytea, photos_ct bytea[]) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_actor uuid := auth.uid(); v_row public.s51_evidence%ROWTYPE;
BEGIN
  PERFORM public._t14_gate_read();
  SELECT * INTO v_row FROM public.s51_evidence WHERE id = p_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_row.per_record_passphrase_hash IS NOT NULL
     AND (p_passphrase IS NULL OR crypt(p_passphrase, v_row.per_record_passphrase_hash) <> v_row.per_record_passphrase_hash) THEN
    PERFORM public.audit_emit('sensitive.access_attempt', public._committee_pseudonym(v_actor), 'C4', 'warn', NULL, p_id, NULL,
      jsonb_build_object('reason','wrong_passphrase','table','s51_evidence'));
    RETURN;
  END IF;
  PERFORM public.audit_emit('s51_evidence.read', public._committee_pseudonym(v_actor), 'C4', 'notice', NULL, p_id, NULL,
    jsonb_build_object('read_via','security_definer_view'));
  RETURN QUERY SELECT v_row.title_ct, v_row.notes_ct, v_row.photos_ct;
END $$;

CREATE OR REPLACE FUNCTION public.s51_evidence_update(p_id uuid, p_title_ct bytea DEFAULT NULL, p_notes_ct bytea DEFAULT NULL)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE v_actor uuid := auth.uid(); v_row public.s51_evidence%ROWTYPE; v_prev jsonb := '{}'::jsonb;
BEGIN
  PERFORM public._t14_gate_write();
  SELECT * INTO v_row FROM public.s51_evidence WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF p_title_ct IS NOT NULL THEN
    v_prev := v_prev || jsonb_build_object('title_ct', encode(digest(v_row.title_ct,'sha256'),'hex'));
    UPDATE public.s51_evidence SET title_ct = p_title_ct WHERE id = p_id;
  END IF;
  IF p_notes_ct IS NOT NULL THEN
    v_prev := v_prev || jsonb_build_object('notes_ct', encode(digest(v_row.notes_ct,'sha256'),'hex'));
    UPDATE public.s51_evidence SET notes_ct = p_notes_ct WHERE id = p_id;
  END IF;
  UPDATE public.s51_evidence SET updated_at = now() WHERE id = p_id;
  PERFORM public.audit_emit('s51_evidence.update', public._committee_pseudonym(v_actor), 'C4', 'notice', NULL, p_id, NULL,
    jsonb_build_object('prev_field_hashes', v_prev));
END $$;

-- ---------------------------------------------------------------------------
-- Amendment D extension — the C4 sensitive-activity feed (reprisal_feed) now
-- also surfaces work_refusal.* / s51_evidence.* write events (pseudonymized,
-- ts bucketed to the hour, no actor). CREATE OR REPLACE keeps the same columns.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.reprisal_feed AS
  SELECT
    a.id, a.event_type,
    (extract(epoch from date_trunc('hour', a.ts)) * 1000)::bigint AS ts_bucketed_to_hour,
    a.target_id, a.target_class,
    encode(a.prev_hash, 'hex') AS prev_hash, encode(a.hash, 'hex') AS hash
  FROM public.audit_log a
  WHERE (a.event_type LIKE 'reprisal.%' OR a.event_type LIKE 'work_refusal.%' OR a.event_type LIKE 's51_evidence.%')
    AND public.session_is_live() AND public.is_active_member(auth.uid());
REVOKE ALL ON public.reprisal_feed FROM PUBLIC, anon;
GRANT SELECT ON public.reprisal_feed TO authenticated, supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Grants — write gated to certified members; the C4 reads also held by the
-- shared c4_read_service role (HG-6). The gate is enforced inside each.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  public.work_refusal_submit(bytea, bytea, text), public.work_refusal_update(uuid, bytea, bytea),
  public.s51_evidence_submit(bytea, bytea, bytea[], text), public.s51_evidence_update(uuid, bytea, bytea),
  public.work_refusal_read(uuid, text), public.s51_evidence_read(uuid, text)
FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION
  public.work_refusal_submit(bytea, bytea, text), public.work_refusal_update(uuid, bytea, bytea),
  public.s51_evidence_submit(bytea, bytea, bytea[], text), public.s51_evidence_update(uuid, bytea, bytea)
TO authenticated, supabase_auth_admin;

GRANT EXECUTE ON FUNCTION public.work_refusal_read(uuid, text) TO authenticated, c4_read_service, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.s51_evidence_read(uuid, text) TO authenticated, c4_read_service, supabase_auth_admin;
