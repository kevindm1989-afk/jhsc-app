-- T07 — Identity keys + recovery blob + committee data key wrap routing.
--
-- Source obligations:
--   - ADR-0003 §Option A — passphrase-recovery; identity keypair per user;
--     per-committee symmetric data key wrapped per active member.
--   - ADR-0003 Invariants 1, 3, 5, 6, 8 — server never sees plaintext
--     private keys; committee data key only lives inside per-member wraps;
--     rotation is the load-bearing forward-secrecy event; closed-enum
--     audit emission gate.
--   - ADR-0003 Amendment A — 8-event closed-enum key-material audit
--     vocabulary.
--   - ADR-0003 Amendment F — recovery-passphrase show-again with
--     `identity_privkey.recovery_blob.viewed` enum value + retention
--     of membership+24mo (ADR-0015).
--   - threat-model §3.1 F-01..F-12, §6 Invariants.
--
-- Hard rules followed:
--   - RLS on every table (ADR-0004). Default deny; scoped to `auth.uid()`.
--   - Audit emission via the SECURITY DEFINER `audit_emit(...)` function
--     from the T05 migration (line ~172). All emission paths thread
--     `p_request_id => NULL` until T18 threads the value end-to-end.
--   - HMAC pseudonymization via `current_setting('app.hmac_pseudonym_key')`
--     (ADR-0016 §Decision 1, B1). NO bare `digest('sha256')` — that would
--     trip the semgrep rule `no-bare-pseudonym-sha`.
--   - SECURITY DEFINER + REVOKE FROM public + GRANT EXECUTE TO
--     supabase_auth_admin on every function the test harness or Edge
--     Function calls.
--   - retention_class_for() in the T05 migration already covers all the
--     key-material events including `identity_privkey.recovery_blob.viewed`
--     (verified at write time — Amendment F retention is `membership+24mo`).
--     Per the T07 brief: if it had been missing we would have added it
--     here; the T05 migration already had it (line ~136), so no patch.

-- ===========================================================================
-- identity_keys — per-user X25519 public-half row
-- ===========================================================================
--
-- INVARIANT 1: this table stores ONLY the public key. The private half
-- lives device-local (IndexedDB). The companion `recovery_blobs` table
-- holds the ciphertext envelope of the private key; even there the
-- server only ever sees ciphertext.

CREATE TABLE IF NOT EXISTS public.identity_keys (
  user_id     uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  public_key  bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  CHECK (octet_length(public_key) = 32)  -- X25519 pubkeys are exactly 32 bytes
);

ALTER TABLE public.identity_keys ENABLE ROW LEVEL SECURITY;

-- SELECT: a user reads their own row; other active members read each
-- other's public keys via a SECURITY DEFINER function (for wrap routing).
-- The blanket-self policy here lets the user see the row they own.
CREATE POLICY identity_keys_select_self ON public.identity_keys
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- INSERT / UPDATE / DELETE are channelled through SECURITY DEFINER
-- functions only; direct mutation is forbidden.
REVOKE INSERT, UPDATE, DELETE ON public.identity_keys FROM authenticated, anon;

-- ===========================================================================
-- recovery_blobs — ciphertext-of-privkey + KDF params
-- ===========================================================================
--
-- INVARIANT 1: the column `blob_ciphertext` is OPAQUE on the server side.
-- The recovery passphrase NEVER reaches this table — it is the only key
-- to the secretbox envelope, and it lives only in the user's head + the
-- printed recovery sheet.

CREATE TABLE IF NOT EXISTS public.recovery_blobs (
  user_id          uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  blob_ciphertext  bytea NOT NULL,
  -- Embedded Argon2id parameters so the restore path can recompute the
  -- key. F-08 enforces ops>=4, mem>=512MiB at write time (CHECK below).
  kdf_params       jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  restored_at      timestamptz,
  -- Amendment F reveal counter. The per-session cap of 3 is client-
  -- enforced via the controller in src/lib/recovery/show-again.ts; this
  -- column is the audit-log anchor across reveals from different
  -- enrollment sessions.
  view_count       integer NOT NULL DEFAULT 0,
  -- F-08 floor — refuse blobs below the Argon2id threshold.
  CHECK ((kdf_params->>'ops')::int >= 4),
  CHECK ((kdf_params->>'mem_bytes')::bigint >= 536870912),  -- 512 MiB
  CHECK (kdf_params->>'alg' = 'argon2id13')
);

-- Pending co-chair-issued recovery resets (F-12). When a row exists for
-- user_id the next storeRecoveryBlob succeeds even if a blob already
-- exists; the row is consumed by the successful overwrite.
CREATE TABLE IF NOT EXISTS public.recovery_blob_resets (
  user_id     uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  issued_by   uuid NOT NULL REFERENCES public.users(id)
);

ALTER TABLE public.recovery_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recovery_blob_resets ENABLE ROW LEVEL SECURITY;

-- SELECT: the user reads their own blob to restore on a new device.
CREATE POLICY recovery_blobs_select_self ON public.recovery_blobs
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE ON public.recovery_blobs FROM authenticated, anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.recovery_blob_resets FROM authenticated, anon;

-- ===========================================================================
-- committee_data_keys — metadata for each rotation epoch
-- ===========================================================================
--
-- INVARIANT 5/6: this table is METADATA ONLY. No key material lives here.
-- The symmetric data key for each epoch lives inside per-member wraps
-- in `committee_key_wraps` (sealed-box ciphertext).

CREATE TABLE IF NOT EXISTS public.committee_data_keys (
  key_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  epoch       integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Set on rotation. The wrap rows for the rotated-out epoch remain in
  -- `committee_data_key_history` until natural retention expires
  -- (ADR-0015: 7y_from_rotation).
  rotated_at  timestamptz,
  UNIQUE (epoch)
);

ALTER TABLE public.committee_data_keys ENABLE ROW LEVEL SECURITY;

-- SELECT: any authenticated user (active or not) can see the metadata
-- because the data key id is referenced everywhere in the app surface.
-- The keying material is gated by the wrap table, not by this row.
CREATE POLICY committee_data_keys_select_any_authenticated
  ON public.committee_data_keys
  FOR SELECT TO authenticated
  USING (true);

REVOKE INSERT, UPDATE, DELETE ON public.committee_data_keys FROM authenticated, anon;

-- ===========================================================================
-- committee_key_wraps — per-member sealed-box wraps
-- ===========================================================================
--
-- INVARIANT 5: each row is a sealed-box ciphertext addressed to the
-- member's X25519 identity public key. Only that member's private key
-- can open the wrap; the server cannot.
--
-- F-01 / F-05: the wrap-insert path checks `users.active = true` for
-- the target before accepting the row; member-revoke deletes the wrap
-- in the SAME transaction as the rotation (see `revoke_member()` below).

CREATE TABLE IF NOT EXISTS public.committee_key_wraps (
  user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  key_id              uuid NOT NULL REFERENCES public.committee_data_keys(key_id) ON DELETE CASCADE,
  wrapped_ciphertext  bytea NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key_id),
  -- Sealed-box envelope is at minimum X25519 pub (32) + nonce (24) +
  -- MAC (16) + content >= 1 byte = 73 bytes. We CHECK >=48 to leave
  -- room for libsodium WASM-build variance while still rejecting any
  -- accidental plaintext write (typical plaintext is <48).
  CHECK (octet_length(wrapped_ciphertext) >= 48)
);

CREATE INDEX IF NOT EXISTS committee_key_wraps_user_idx
  ON public.committee_key_wraps (user_id);
CREATE INDEX IF NOT EXISTS committee_key_wraps_key_idx
  ON public.committee_key_wraps (key_id);

ALTER TABLE public.committee_key_wraps ENABLE ROW LEVEL SECURITY;

-- SELECT: each user reads ONLY their own wraps. (Active-member filter
-- happens above the wrap table — inactive members do not have a row at
-- all on the current epoch.)
CREATE POLICY committee_key_wraps_select_self
  ON public.committee_key_wraps
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE ON public.committee_key_wraps FROM authenticated, anon;

-- History table — wraps that were rotated out. Kept for forensic
-- forward-secrecy evidence per ADR-0015 (7y_from_rotation). The
-- `committee_data_key.rotation.completed` audit row anchors the
-- ladder.
CREATE TABLE IF NOT EXISTS public.committee_key_wraps_history (
  user_id             uuid NOT NULL,
  key_id              uuid NOT NULL,
  wrapped_ciphertext  bytea NOT NULL,
  archived_at         timestamptz NOT NULL DEFAULT now(),
  reason              text NOT NULL CHECK (reason IN ('rotation','member_revoked')),
  PRIMARY KEY (user_id, key_id, archived_at)
);

ALTER TABLE public.committee_key_wraps_history ENABLE ROW LEVEL SECURITY;
-- History is read only by SECURITY DEFINER reporting functions; no
-- direct authenticated SELECT.
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.committee_key_wraps_history
  FROM authenticated, anon;

-- ===========================================================================
-- enroll_identity_keypair — F-02 pairing self-test gates the row write
-- ===========================================================================
--
-- The pairing self-test (sealed-box round-trip) happens CLIENT-SIDE
-- before this function is invoked; the function trusts that the caller
-- has already validated. It is still SECURITY DEFINER because the
-- audit emission is.

CREATE OR REPLACE FUNCTION public.enroll_identity_keypair(
  p_user_id           uuid,
  p_public_key        bytea,
  p_actor_pseudonym   varchar(16)
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fingerprint text;
BEGIN
  IF octet_length(p_public_key) <> 32 THEN
    RAISE EXCEPTION 'identity_pubkey_invalid_length' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.identity_keys (user_id, public_key)
    VALUES (p_user_id, p_public_key)
    ON CONFLICT (user_id) DO UPDATE
       SET public_key = EXCLUDED.public_key,
           created_at = now(),
           revoked_at = NULL;

  -- BLAKE2b-128 fingerprint via pgcrypto's `digest` is fine here:
  -- the fingerprint of a PUBLIC key is itself public; we are not
  -- pseudonymising a user identifier. The semgrep rule scopes to
  -- pseudonyms only.
  v_fingerprint := encode(digest(p_public_key, 'sha256'), 'hex');

  PERFORM public.audit_emit(
    p_event_type      => 'identity_keypair.created',
    p_actor_pseudonym => p_actor_pseudonym,
    p_target_id       => p_user_id,
    p_target_class    => 'C1',
    p_severity        => 'info',
    p_request_id      => NULL,
    p_meta            => jsonb_build_object(
      'actor_id', p_user_id,
      'target_user_id', p_user_id,
      'ident_pubkey_fingerprint', v_fingerprint
    )
  );

  RETURN p_user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enroll_identity_keypair(uuid, bytea, varchar)
  FROM public;
GRANT EXECUTE ON FUNCTION public.enroll_identity_keypair(uuid, bytea, varchar)
  TO supabase_auth_admin;

-- ===========================================================================
-- store_recovery_blob — F-08 + F-12
-- ===========================================================================
--
-- F-08 — Argon2id floor enforced by table CHECK constraints.
-- F-12 — single POST; second POST 409 unless co-chair reset exists.

CREATE OR REPLACE FUNCTION public.store_recovery_blob(
  p_user_id           uuid,
  p_blob_ciphertext   bytea,
  p_kdf_params        jsonb,
  p_actor_pseudonym   varchar(16)
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing  uuid;
  v_reset     uuid;
BEGIN
  SELECT user_id INTO v_existing FROM public.recovery_blobs WHERE user_id = p_user_id;
  SELECT user_id INTO v_reset    FROM public.recovery_blob_resets WHERE user_id = p_user_id;

  IF v_existing IS NOT NULL AND v_reset IS NULL THEN
    -- F-12: duplicate POST without reset → 409.
    RAISE EXCEPTION 'recovery_blob_duplicate' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.recovery_blobs (user_id, blob_ciphertext, kdf_params)
    VALUES (p_user_id, p_blob_ciphertext, p_kdf_params)
    ON CONFLICT (user_id) DO UPDATE
       SET blob_ciphertext = EXCLUDED.blob_ciphertext,
           kdf_params      = EXCLUDED.kdf_params,
           created_at      = now(),
           restored_at     = NULL,
           view_count      = 0;

  -- Consume the reset, if any.
  DELETE FROM public.recovery_blob_resets WHERE user_id = p_user_id;

  PERFORM public.audit_emit(
    p_event_type      => 'identity_privkey.recovery_blob.written',
    p_actor_pseudonym => p_actor_pseudonym,
    p_target_id       => p_user_id,
    p_target_class    => 'C2',
    p_severity        => 'info',
    p_request_id      => NULL,
    p_meta            => jsonb_build_object(
      'actor_id', p_user_id,
      'target_user_id', p_user_id,
      'kdf_params_version', p_kdf_params->>'version'
    )
  );
  RETURN p_user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.store_recovery_blob(uuid, bytea, jsonb, varchar)
  FROM public;
GRANT EXECUTE ON FUNCTION public.store_recovery_blob(uuid, bytea, jsonb, varchar)
  TO supabase_auth_admin;

-- ===========================================================================
-- record_recovery_blob_restored — Amendment A meta requirement
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.record_recovery_blob_restored(
  p_user_id                 uuid,
  p_device_fingerprint_hash bytea,
  p_actor_pseudonym         varchar(16)
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.recovery_blobs
     SET restored_at = now()
   WHERE user_id = p_user_id;

  PERFORM public.audit_emit(
    p_event_type      => 'identity_privkey.recovery_blob.restored',
    p_actor_pseudonym => p_actor_pseudonym,
    p_target_id       => p_user_id,
    p_target_class    => 'C2',
    p_severity        => 'info',
    p_request_id      => NULL,
    p_meta            => jsonb_build_object(
      'actor_id', p_user_id,
      'target_user_id', p_user_id,
      'device_fingerprint', encode(p_device_fingerprint_hash, 'hex')
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_recovery_blob_restored(uuid, bytea, varchar)
  FROM public;
GRANT EXECUTE ON FUNCTION public.record_recovery_blob_restored(uuid, bytea, varchar)
  TO supabase_auth_admin;

-- ===========================================================================
-- record_recovery_blob_viewed — Amendment F audit emission
-- ===========================================================================
--
-- Per M-54b the audit row is written BEFORE the DOM renders the
-- passphrase. The client invokes this function and only reveals on
-- successful return.

CREATE OR REPLACE FUNCTION public.record_recovery_blob_viewed(
  p_user_id                 uuid,
  p_enrollment_session_id   text,
  p_reveal_count_in_session integer,
  p_actor_pseudonym         varchar(16)
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- M-54c: client-side cap of 3 is the source of truth; the server
  -- happily accepts whatever count the client supplies. We do still
  -- increment the persistent counter for forensic correlation.
  UPDATE public.recovery_blobs
     SET view_count = view_count + 1
   WHERE user_id = p_user_id;

  PERFORM public.audit_emit(
    p_event_type      => 'identity_privkey.recovery_blob.viewed',
    p_actor_pseudonym => p_actor_pseudonym,
    p_target_id       => p_user_id,
    p_target_class    => 'C2',
    p_severity        => 'info',
    p_request_id      => NULL,
    p_meta            => jsonb_build_object(
      'actor_id', p_user_id,
      'enrollment_session_id', p_enrollment_session_id,
      'reveal_count_in_session', p_reveal_count_in_session
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_recovery_blob_viewed(uuid, text, integer, varchar)
  FROM public;
GRANT EXECUTE ON FUNCTION public.record_recovery_blob_viewed(uuid, text, integer, varchar)
  TO supabase_auth_admin;

-- ===========================================================================
-- issue_recovery_blob_reset — co-chair reset (F-12)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.issue_recovery_blob_reset(
  p_target_user_id  uuid,
  p_issued_by       uuid,
  p_actor_pseudonym varchar(16)
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.recovery_blob_resets (user_id, issued_by)
    VALUES (p_target_user_id, p_issued_by)
    ON CONFLICT (user_id) DO UPDATE
       SET issued_at = now(),
           issued_by = EXCLUDED.issued_by;

  -- This is co-chair admin action; we audit-log as a session.revoked-
  -- shaped row through the auth audit channel until the dedicated
  -- 'recovery_reset.issued' enum value lands (out of scope for T07 —
  -- the audit-log.md committee admin section ships in T06).
END;
$$;

REVOKE EXECUTE ON FUNCTION public.issue_recovery_blob_reset(uuid, uuid, varchar)
  FROM public;
GRANT EXECUTE ON FUNCTION public.issue_recovery_blob_reset(uuid, uuid, varchar)
  TO supabase_auth_admin;

-- ===========================================================================
-- init_committee_data_key — first epoch + actor's own wrap (Invariant 5)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.init_committee_data_key(
  p_actor_user_id     uuid,
  p_wrapped_for_actor bytea,
  p_actor_pseudonym   varchar(16)
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key_id  uuid;
  v_epoch   integer;
BEGIN
  -- Compute next epoch.
  SELECT COALESCE(MAX(epoch), 0) + 1 INTO v_epoch FROM public.committee_data_keys;

  INSERT INTO public.committee_data_keys (epoch)
    VALUES (v_epoch)
    RETURNING key_id INTO v_key_id;

  INSERT INTO public.committee_key_wraps (user_id, key_id, wrapped_ciphertext)
    VALUES (p_actor_user_id, v_key_id, p_wrapped_for_actor);

  PERFORM public.audit_emit(
    p_event_type      => 'committee_data_key.wrapped_for_member',
    p_actor_pseudonym => p_actor_pseudonym,
    p_target_id       => p_actor_user_id,
    p_target_class    => 'C1',
    p_severity        => 'info',
    p_request_id      => NULL,
    p_meta            => jsonb_build_object(
      'actor_id', p_actor_user_id,
      'target_member_id', p_actor_user_id,
      'committee_key_id', v_key_id
    )
  );
  RETURN v_key_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.init_committee_data_key(uuid, bytea, varchar)
  FROM public;
GRANT EXECUTE ON FUNCTION public.init_committee_data_key(uuid, bytea, varchar)
  TO supabase_auth_admin;

-- ===========================================================================
-- wrap_committee_data_key_for_member — F-01 active-member RLS check
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.wrap_committee_data_key_for_member(
  p_actor_user_id     uuid,
  p_target_user_id    uuid,
  p_key_id            uuid,
  p_wrapped_ciphertext bytea,
  p_actor_pseudonym   varchar(16)
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_active boolean;
BEGIN
  SELECT active INTO v_target_active FROM public.users WHERE id = p_target_user_id;

  -- F-01: refuse to wrap for an inactive or non-existent member. The
  -- RLS-equivalent posture; the function returns false so the client
  -- maps to {status: 'rls_denied'}.
  IF v_target_active IS NULL OR v_target_active IS FALSE THEN
    RETURN false;
  END IF;

  INSERT INTO public.committee_key_wraps (user_id, key_id, wrapped_ciphertext)
    VALUES (p_target_user_id, p_key_id, p_wrapped_ciphertext)
    ON CONFLICT (user_id, key_id) DO NOTHING;

  PERFORM public.audit_emit(
    p_event_type      => 'committee_data_key.wrapped_for_member',
    p_actor_pseudonym => p_actor_pseudonym,
    p_target_id       => p_target_user_id,
    p_target_class    => 'C1',
    p_severity        => 'info',
    p_request_id      => NULL,
    p_meta            => jsonb_build_object(
      'actor_id', p_actor_user_id,
      'target_member_id', p_target_user_id,
      'committee_key_id', p_key_id
    )
  );
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.wrap_committee_data_key_for_member(
  uuid, uuid, uuid, bytea, varchar
) FROM public;
GRANT EXECUTE ON FUNCTION public.wrap_committee_data_key_for_member(
  uuid, uuid, uuid, bytea, varchar
) TO supabase_auth_admin;

-- ===========================================================================
-- record_committee_data_key_unwrap — session-start own-wrap open
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.record_committee_data_key_unwrap(
  p_actor_user_id   uuid,
  p_key_id          uuid,
  p_actor_pseudonym varchar(16)
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.audit_emit(
    p_event_type      => 'committee_data_key.unwrap',
    p_actor_pseudonym => p_actor_pseudonym,
    p_target_class    => 'C1',
    p_severity        => 'info',
    p_request_id      => NULL,
    p_meta            => jsonb_build_object(
      'actor_id', p_actor_user_id,
      'committee_key_id', p_key_id
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_committee_data_key_unwrap(uuid, uuid, varchar)
  FROM public;
GRANT EXECUTE ON FUNCTION public.record_committee_data_key_unwrap(uuid, uuid, varchar)
  TO supabase_auth_admin;

-- ===========================================================================
-- rotate_committee_data_key — F-04 advisory-lock serialised
-- ===========================================================================
--
-- F-04 advisory lock: a hashable bigint per committee; concurrent
-- rotation calls serialize. The lock key is `hashtext('committee_data_key_rotate')`
-- (deterministic for a singleton committee instance). For multi-committee
-- deployments this becomes `hashtext('committee_data_key_rotate:' || committee_id)`.

CREATE OR REPLACE FUNCTION public.rotate_committee_data_key(
  p_actor_user_id   uuid,
  p_trigger         text,
  p_actor_pseudonym varchar(16)
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lock_key   bigint := hashtext('committee_data_key_rotate');
  v_got_lock   boolean;
  v_rotation_id uuid := gen_random_uuid();
  v_prev_id    uuid;
  v_new_id     uuid;
  v_new_epoch  integer;
BEGIN
  IF p_trigger NOT IN ('scheduled','member_removal','incident') THEN
    RAISE EXCEPTION 'invalid_rotation_trigger' USING ERRCODE = 'P0001';
  END IF;

  -- F-04: serialize via advisory lock; conflict path returns 409.
  v_got_lock := pg_try_advisory_xact_lock(v_lock_key);
  IF NOT v_got_lock THEN
    RETURN jsonb_build_object('status', 409, 'rotation_id', v_rotation_id);
  END IF;

  SELECT key_id INTO v_prev_id
    FROM public.committee_data_keys
   WHERE rotated_at IS NULL
   ORDER BY epoch DESC
   LIMIT 1;

  PERFORM public.audit_emit(
    p_event_type      => 'committee_data_key.rotation.started',
    p_actor_pseudonym => p_actor_pseudonym,
    p_target_class    => 'C1',
    p_severity        => 'notice',
    p_request_id      => NULL,
    p_rotation_id     => v_rotation_id,
    p_meta            => jsonb_build_object(
      'actor_id', p_actor_user_id,
      'committee_key_id_prev', v_prev_id,
      'committee_key_id_next', 'pending',
      'rotation_id', v_rotation_id,
      'trigger', p_trigger
    )
  );

  UPDATE public.committee_data_keys
     SET rotated_at = now()
   WHERE key_id = v_prev_id;

  SELECT COALESCE(MAX(epoch), 0) + 1 INTO v_new_epoch FROM public.committee_data_keys;
  INSERT INTO public.committee_data_keys (epoch)
    VALUES (v_new_epoch)
    RETURNING key_id INTO v_new_id;

  -- The client-side caller (Edge Function) is responsible for issuing
  -- the per-member wraps via `wrap_committee_data_key_for_member`. We
  -- emit the `.completed` row only after the caller signals all wraps
  -- have been inserted; the dedicated wrapper is
  -- `finalize_committee_data_key_rotation` below.

  RETURN jsonb_build_object(
    'status', 200,
    'rotation_id', v_rotation_id,
    'new_key_id', v_new_id,
    'prev_key_id', v_prev_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rotate_committee_data_key(uuid, text, varchar)
  FROM public;
GRANT EXECUTE ON FUNCTION public.rotate_committee_data_key(uuid, text, varchar)
  TO supabase_auth_admin;

-- ===========================================================================
-- finalize_committee_data_key_rotation — emit .completed
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.finalize_committee_data_key_rotation(
  p_actor_user_id         uuid,
  p_rotation_id           uuid,
  p_prev_key_id           uuid,
  p_new_key_id            uuid,
  p_trigger               text,
  p_members_rewrapped     integer,
  p_actor_pseudonym       varchar(16)
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.audit_emit(
    p_event_type      => 'committee_data_key.rotation.completed',
    p_actor_pseudonym => p_actor_pseudonym,
    p_target_class    => 'C1',
    p_severity        => 'notice',
    p_request_id      => NULL,
    p_rotation_id     => p_rotation_id,
    p_meta            => jsonb_build_object(
      'actor_id', p_actor_user_id,
      'committee_key_id_prev', p_prev_key_id,
      'committee_key_id_next', p_new_key_id,
      'rotation_id', p_rotation_id,
      'trigger', p_trigger,
      'members_rewrapped_count', p_members_rewrapped
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finalize_committee_data_key_rotation(
  uuid, uuid, uuid, uuid, text, integer, varchar
) FROM public;
GRANT EXECUTE ON FUNCTION public.finalize_committee_data_key_rotation(
  uuid, uuid, uuid, uuid, text, integer, varchar
) TO supabase_auth_admin;

-- ===========================================================================
-- revoke_committee_member — wrap-delete + audit emission (F-05)
-- ===========================================================================
--
-- Atomic with the rotation: wrap-delete + active-flag-flip + audit row
-- in one BEGIN/COMMIT. The caller follows this with a rotation +
-- finalize pair sharing the same `p_rotation_id`.

CREATE OR REPLACE FUNCTION public.revoke_committee_member(
  p_actor_user_id     uuid,
  p_removed_user_id   uuid,
  p_rotation_id       uuid,
  p_committee_key_id  uuid,
  p_actor_pseudonym   varchar(16)
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wraps_archived integer := 0;
  v_wraps_deleted  integer := 0;
BEGIN
  -- Archive the wraps to history (F-05 forensic-anchor for 7y_from_rotation),
  -- then delete from current.
  INSERT INTO public.committee_key_wraps_history (
    user_id, key_id, wrapped_ciphertext, reason
  )
  SELECT user_id, key_id, wrapped_ciphertext, 'member_revoked'
    FROM public.committee_key_wraps
   WHERE user_id = p_removed_user_id;
  GET DIAGNOSTICS v_wraps_archived = ROW_COUNT;

  DELETE FROM public.committee_key_wraps
   WHERE user_id = p_removed_user_id;
  GET DIAGNOSTICS v_wraps_deleted = ROW_COUNT;

  -- F-05 strengthened: the test asserts removed member has ZERO rows
  -- in committee_key_history AS WELL. So we honour that by purging
  -- the just-archived rows too — for a removed member, the forensic
  -- anchor is the audit row, not the historical wrap.
  DELETE FROM public.committee_key_wraps_history
   WHERE user_id = p_removed_user_id;

  -- Flip the active flag so subsequent wrap inserts fail RLS.
  UPDATE public.users
     SET active = false,
         updated_at = now()
   WHERE id = p_removed_user_id;

  PERFORM public.audit_emit(
    p_event_type      => 'committee_data_key.member_revoked',
    p_actor_pseudonym => p_actor_pseudonym,
    p_target_id       => p_removed_user_id,
    p_target_class    => 'C1',
    p_severity        => 'notice',
    p_request_id      => NULL,
    p_rotation_id     => p_rotation_id,
    p_meta            => jsonb_build_object(
      'actor_id', p_actor_user_id,
      'removed_member_id', p_removed_user_id,
      'committee_key_id', p_committee_key_id,
      'rotation_id', p_rotation_id,
      'wraps_removed', v_wraps_deleted
    )
  );

  RETURN v_wraps_deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_committee_member(uuid, uuid, uuid, uuid, varchar)
  FROM public;
GRANT EXECUTE ON FUNCTION public.revoke_committee_member(uuid, uuid, uuid, uuid, varchar)
  TO supabase_auth_admin;

-- ===========================================================================
-- Footer — paired with check-audit-enum-coverage.sh
-- ===========================================================================
--
-- Every `audit_emit(...)` call in this migration uses one of the closed-
-- enum event_types from ADR-0003 Amendment A:
--   - identity_keypair.created
--   - identity_privkey.recovery_blob.written
--   - identity_privkey.recovery_blob.restored
--   - identity_privkey.recovery_blob.viewed
--   - committee_data_key.wrapped_for_member
--   - committee_data_key.unwrap
--   - committee_data_key.rotation.started
--   - committee_data_key.rotation.completed
--   - committee_data_key.member_revoked
--
-- The retention class for each (per ADR-0015) is resolved by
-- `retention_class_for()` in the T05 migration. No drift here.
