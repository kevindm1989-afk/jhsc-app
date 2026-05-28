-- ===========================================================================
-- T08.1 — Concern intake server (concerns + RLS + rate-limit + reveal).
--
-- Server sibling of T08 (ADR-0007 library). Implements the SQL the
-- MemoryConcernStore / concern-core.ts contract mirrors:
--   submitConcern → concern_submit         (F-15 active-member gate, F-17
--                                            actor-always, F-20 rate limit)
--   updateConcernText → concern_update      (F-16 prev_field_hashes audit)
--   listConcerns → concerns_default_view    (F-18 omits source_name_ct)
--   revealSource → reveal_concern_source    (F-18 audit-before-return +
--                                            per-record passphrase, G-T08-6)
--
-- Conventions mirror 00000000000002_committee.sql: SECURITY DEFINER mutation
-- functions, writes REVOKED from authenticated/anon, gates on
-- session_is_live() (F-116) AND is_active_member() (F-15/F-30), pseudonymised
-- audit via public.audit_emit, HMAC pseudonym via _committee_pseudonym.
--
-- E2EE posture (ADR-0003 Invariant 1): title/body/source_name are sealed
-- CLIENT-SIDE under the committee key; this layer only ever sees ciphertext
-- (bytea). The per-record reveal passphrase (G-T08-6) is a UX friction gate,
-- NOT the cryptographic gate (the committee key is), so it is hashed
-- server-side (pgcrypto bf) — it never gates the source-name plaintext, which
-- stays encrypted regardless.
--
-- Concern audit rows (concern.created/updated/source_revealed) all carry a
-- target_id, so audit_emit's "default class + target_id ⇒ match_underlying"
-- rule makes them follow the concerns row retention (ADR-0016 schedule row is
-- the architect amendment G-T08-4); no retention_class_for arm is added here.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- concerns — the C3 (body) / C4 (source_name) intake record.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.concerns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- F-17: the submitter is ALWAYS recorded, regardless of the anonymous toggle.
  actor_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  title_ct              bytea NOT NULL,                 -- committee-key sealed
  body_ct               bytea NOT NULL,                 -- committee-key sealed
  source_name_ct        bytea,                          -- NULL ⇔ logged anonymously
  source_passphrase_hash text,                          -- pgcrypto bf; per-record reveal gate (G-T08-6)
  hazard_class          text NOT NULL
                          CHECK (hazard_class IN ('physical','chemical','biological','ergonomic','psychosocial','other')),
  severity              text NOT NULL
                          CHECK (severity IN ('low','medium','high','critical')),
  location_id           text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- F-17 structural invariant: a named source must carry its ciphertext, and an
  -- anonymous concern must NOT. (actor_id is non-null above, independently.)
  CONSTRAINT concerns_source_consistency CHECK (
    (source_name_ct IS NULL AND source_passphrase_hash IS NULL)
    OR source_name_ct IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS concerns_actor_idx ON public.concerns (actor_id);
CREATE INDEX IF NOT EXISTS concerns_created_idx ON public.concerns (created_at);

ALTER TABLE public.concerns ENABLE ROW LEVEL SECURITY;

-- All access is mediated: writes via the SECURITY DEFINER functions below, reads
-- via concerns_default_view (omits source_name_ct, F-18) + reveal_concern_source.
-- Direct base-table access is denied so source_name_ct cannot be SELECTed and
-- rows cannot be written outside the audited, rate-limited, gated path.
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.concerns FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- concern_rate_log + consume_concern_rate_budget — F-20 / G-T08-13.
-- Two windows: ≤20 per rolling hour AND ≤200 per rolling 24h. The retention
-- sweep (T16) prunes this operational table; not in scope here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.concern_rate_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS concern_rate_log_actor_time_idx
  ON public.concern_rate_log (actor_id, created_at);

ALTER TABLE public.concern_rate_log ENABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.concern_rate_log FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.consume_concern_rate_budget(p_actor_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_hour  integer;
  v_day   integer;
BEGIN
  SELECT count(*) INTO v_hour FROM public.concern_rate_log
    WHERE actor_id = p_actor_id AND created_at > now() - interval '1 hour';
  IF v_hour >= 20 THEN RETURN false; END IF;                 -- F-20: 20/hour

  SELECT count(*) INTO v_day FROM public.concern_rate_log
    WHERE actor_id = p_actor_id AND created_at > now() - interval '24 hours';
  IF v_day >= 200 THEN RETURN false; END IF;                 -- G-T08-13: 200/24h

  INSERT INTO public.concern_rate_log (actor_id) VALUES (p_actor_id);
  RETURN true;
END $$;
REVOKE EXECUTE ON FUNCTION public.consume_concern_rate_budget(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- _concern_gate — session-live (F-116) AND active-member (F-15/F-30) or deny.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._concern_gate()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF NOT public.session_is_live() THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';    -- F-116 revoked/expired session
  END IF;
  IF NOT public.is_active_member(auth.uid()) THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';    -- F-15 / F-30 non/removed member
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- concern_submit — gate → rate-limit → insert → audit (one transaction).
-- Receives ONLY ciphertext (E2EE). actor_id is the caller (F-17, never null);
-- source_name_ct is forced NULL when anonymous.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.concern_submit(
  p_title_ct          bytea,
  p_body_ct           bytea,
  p_hazard_class      text,
  p_severity          text,
  p_location_id       text,
  p_anonymous         boolean,
  p_source_name_ct    bytea  DEFAULT NULL,
  p_source_passphrase text   DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_src_ct  bytea;
  v_pass_h  text;
  v_id      uuid;
BEGIN
  PERFORM public._concern_gate();

  IF NOT public.consume_concern_rate_budget(v_actor) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';  -- F-20
  END IF;

  IF p_anonymous THEN
    v_src_ct := NULL;            -- F-17: anonymous ⇒ no source ciphertext stored
    v_pass_h := NULL;
  ELSE
    IF p_source_name_ct IS NULL THEN
      RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';  -- named ⇒ source required (defense-in-depth)
    END IF;
    v_src_ct := p_source_name_ct;
    -- Per-record reveal passphrase (G-T08-6): hash server-side (UX gate, not the
    -- crypto gate). NULL/empty ⇒ no per-record gate on reveal.
    IF p_source_passphrase IS NOT NULL AND length(p_source_passphrase) > 0 THEN
      v_pass_h := crypt(p_source_passphrase, gen_salt('bf'));
    END IF;
  END IF;

  INSERT INTO public.concerns (
    actor_id, title_ct, body_ct, source_name_ct, source_passphrase_hash,
    hazard_class, severity, location_id
  )
  VALUES (
    v_actor, p_title_ct, p_body_ct, v_src_ct, v_pass_h,
    p_hazard_class, p_severity, p_location_id
  )
  RETURNING id INTO v_id;

  -- F-17: the audit row ALWAYS carries the submitter pseudonym; anonymous only
  -- governs source_name_ct, never the actor. anonymous_default_kept lets the
  -- audit feed show "kept default" vs "named" without revealing the source.
  PERFORM public.audit_emit(
    p_event_type      => 'concern.created',
    p_actor_pseudonym => public._committee_pseudonym(v_actor),
    p_target_class    => 'C3',
    p_severity        => 'info',
    p_target_id       => v_id,
    p_meta            => jsonb_build_object(
      'anonymous_default_kept', p_anonymous,
      'hazard_class', p_hazard_class,
      'severity', p_severity,
      'location_id', p_location_id
    )
  );
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- concern_update — re-encrypt changed columns + audit prev_field_hashes (F-16).
-- NULL params mean "unchanged". prev_field_hashes carries the SHA-256 of the
-- PRIOR ciphertext for each changed sealed column (server-computed, unforgeable).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.concern_update(
  p_id            uuid,
  p_title_ct      bytea  DEFAULT NULL,
  p_body_ct       bytea  DEFAULT NULL,
  p_hazard_class  text   DEFAULT NULL,
  p_severity      text   DEFAULT NULL,
  p_location_id   text   DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_row   public.concerns%ROWTYPE;
  v_prev  jsonb := '{}'::jsonb;
BEGIN
  PERFORM public._concern_gate();

  SELECT * INTO v_row FROM public.concerns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  IF p_title_ct IS NOT NULL THEN
    v_prev := v_prev || jsonb_build_object('title_ct', encode(digest(v_row.title_ct, 'sha256'), 'hex'));
    UPDATE public.concerns SET title_ct = p_title_ct WHERE id = p_id;
  END IF;
  IF p_body_ct IS NOT NULL THEN
    v_prev := v_prev || jsonb_build_object('body_ct', encode(digest(v_row.body_ct, 'sha256'), 'hex'));
    UPDATE public.concerns SET body_ct = p_body_ct WHERE id = p_id;
  END IF;
  IF p_hazard_class IS NOT NULL THEN
    UPDATE public.concerns SET hazard_class = p_hazard_class WHERE id = p_id;
  END IF;
  IF p_severity IS NOT NULL THEN
    UPDATE public.concerns SET severity = p_severity WHERE id = p_id;
  END IF;
  IF p_location_id IS NOT NULL THEN
    UPDATE public.concerns SET location_id = p_location_id WHERE id = p_id;
  END IF;

  UPDATE public.concerns SET updated_at = now() WHERE id = p_id;

  PERFORM public.audit_emit(
    p_event_type      => 'concern.updated',
    p_actor_pseudonym => public._committee_pseudonym(v_actor),
    p_target_class    => 'C3',
    p_severity        => 'info',
    p_target_id       => p_id,
    p_meta            => jsonb_build_object('prev_field_hashes', v_prev)
  );
END $$;

-- ---------------------------------------------------------------------------
-- concerns_default_view — F-18 list projection. OMITS source_name_ct; exposes
-- has_named_source instead. Runs with the view owner's rights (not invoker) so
-- it reads the RLS-locked base table, and gates rows to live, active members.
-- ---------------------------------------------------------------------------
-- NB: no `security_invoker` reloption — that view option is PG15+, but the
-- vanilla pgTAP CI job runs on PG14. The DEFAULT (owner's-rights) view behavior
-- is exactly what we want here (the view owner reads the RLS-locked base table;
-- the WHERE clause is the membership gate), and it is identical across PG14/15+.
CREATE OR REPLACE VIEW public.concerns_default_view AS
  SELECT
    c.id, c.actor_id, c.title_ct, c.body_ct,
    c.hazard_class, c.severity, c.location_id, c.created_at, c.updated_at,
    (c.source_name_ct IS NOT NULL) AS has_named_source
  FROM public.concerns c
  WHERE public.session_is_live() AND public.is_active_member(auth.uid());

REVOKE ALL ON public.concerns_default_view FROM PUBLIC, anon;
GRANT SELECT ON public.concerns_default_view TO authenticated, supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- reveal_concern_source — F-18 / G-T08-6. Verifies the per-record passphrase
-- (when one was set), emits concern.source_revealed BEFORE returning, and
-- returns the source ciphertext (decryption is client-side under committee key).
-- Returns NULL when the concern has no source (logged anonymously) or no row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reveal_concern_source(
  p_id          uuid,
  p_passphrase  text DEFAULT NULL
) RETURNS bytea
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_ct    bytea;
  v_hash  text;
BEGIN
  PERFORM public._concern_gate();

  SELECT source_name_ct, source_passphrase_hash INTO v_ct, v_hash
    FROM public.concerns WHERE id = p_id;
  IF NOT FOUND OR v_ct IS NULL THEN
    RETURN NULL;                                             -- no row / anonymous
  END IF;

  -- Per-record reveal gate (G-T08-6): if a passphrase was set at submit, the
  -- caller must supply the matching one. This is friction, not crypto.
  IF v_hash IS NOT NULL THEN
    IF p_passphrase IS NULL OR crypt(p_passphrase, v_hash) <> v_hash THEN
      RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- F-18: audit row committed BEFORE the plaintext (ciphertext) is returned.
  PERFORM public.audit_emit(
    p_event_type      => 'concern.source_revealed',
    p_actor_pseudonym => public._committee_pseudonym(v_actor),
    p_target_class    => 'C4',
    p_severity        => 'notice',
    p_target_id       => p_id,
    p_meta            => jsonb_build_object(
      'concern_id', p_id,
      'per_record_unlock_ts', (extract(epoch from now()) * 1000)::bigint
    )
  );

  RETURN v_ct;
END $$;

-- ---------------------------------------------------------------------------
-- Grants — the audited/gated functions are reachable by active members only
-- (the gate is enforced inside each). consume_concern_rate_budget stays
-- internal (revoked above; reached only via concern_submit's definer context).
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  public.concern_submit(bytea, bytea, text, text, text, boolean, bytea, text),
  public.concern_update(uuid, bytea, bytea, text, text, text),
  public.reveal_concern_source(uuid, text)
FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION
  public.concern_submit(bytea, bytea, text, text, text, boolean, bytea, text),
  public.concern_update(uuid, bytea, bytea, text, text, text),
  public.reveal_concern_source(uuid, text)
TO authenticated, supabase_auth_admin;
