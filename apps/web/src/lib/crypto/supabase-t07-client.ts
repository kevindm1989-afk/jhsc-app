/**
 * SupabaseT07Client — production-shaped client for the t07-op Edge Function
 * (T07.1 / G-T07-2).
 *
 * Why a separate client instead of `SupabaseKeyStore implements KeyStore`:
 * the KeyStore interface designed for the test orchestrator
 * (MemoryKeyStore) decomposes a single high-level operation (e.g. rotate
 * the committee data key) into many small steps (markCommitteeKeyRotated +
 * initCommitteeDataKey + listActiveMemberIds + per-member insertCommitteeKeyWrap
 * + recordKeyEvent etc.). The PRODUCTION architecture folds these steps
 * into one SECURITY DEFINER SQL function per high-level operation
 * (rotate_committee_data_key from migration 0007, etc.) — atomicity is the
 * point. A 1:1 KeyStore implementation that maps the small steps would
 * have to (a) leave most methods as throw-stubs or (b) re-implement the
 * server-side orchestration in TS, defeating atomicity. Instead this
 * class exposes the HIGH-LEVEL operations 1:1 with the t07-op Edge Function
 * ops, and downstream callers (T19 onboarding, future committee-management
 * UI) invoke them directly. The LocalIdentityStore split (G-T07-10) is
 * structural; the high-level path threads `BrowserLocalIdentityStore` for
 * private-key reads.
 *
 * Wire format: every op POSTs `{ op: <name>, ...args }` JSON to the
 * t07-op Edge Function with the caller's JWT in `Authorization: Bearer`.
 * The response is `{ ok: true, data: ... } | { ok: false, error: <T07Reason>, status: <http> }`
 * mirroring `supabase/functions/t07-op/core.ts`.
 *
 * Transport injection: the constructor takes an `invoke` function so this
 * module has zero runtime dependency on `@supabase/supabase-js`. Production
 * callers wire `invoke` to `supabase.functions.invoke('t07-op', { body: op })`
 * (or a hand-rolled fetch); tests inject a stub that records calls.
 *
 * F-02 enrollment: enroll() drives the full sealed-box challenge flow —
 * client generates the keypair, posts the public half + fingerprint to
 * enrollment_challenge_init, the Edge Function returns the SEALED nonce,
 * the client unseals with the device-local private key (via the supplied
 * `unsealNonce` callback so this class stays libsodium-agnostic) and posts
 * the cleartext to enrollment_challenge_finalize. The private key is
 * persisted to `LocalIdentityStore` only AFTER the F-02 challenge succeeds
 * (so a hostile pubkey can't get the privkey persisted device-side either).
 */

import type { LocalIdentityStore } from './key-store';
import { bytesToPgHex, pgHexToBytes } from '../server-client/pg-hex';
export { bytesToPgHex, pgHexToBytes } from '../server-client/pg-hex';

// ---------------------------------------------------------------------------
// Wire shape — mirrors supabase/functions/t07-op/core.ts T07Reason.
// ---------------------------------------------------------------------------

export type T07OpReason =
  | 'rls_denied'
  | 'duplicate'
  | 'not_found'
  | 'invalid_input'
  | 'cap_reached'
  | 'already_initialised'
  | 'no_active_members'
  | 'rotation_in_progress'
  | 'rotation_not_started'
  | 'challenge_expired'
  | 'challenge_consumed'
  | 'wrong_nonce'
  | 'unknown';

export type T07OpResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: T07OpReason; status: number };

/**
 * Edge Function transport. Returns the parsed JSON body + the response status.
 * Implementations live next to whichever Supabase client the caller uses.
 *
 * Production wiring (apps/web):
 *   const transport: T07OpTransport = async (body) => {
 *     const r = await supabase.functions.invoke('t07-op', { body });
 *     if (r.error) return { status: 500, body: { ok: false, error: 'unknown' } };
 *     return { status: 200, body: r.data };
 *   };
 *
 * Test wiring: see apps/web/test/T07/supabase-t07-client.test.ts.
 */
export type T07OpTransport = (
  body: Record<string, unknown>
) => Promise<{ status: number; body: unknown }>;

interface T07OpWireOk<T> {
  ok: true;
  data: T;
}
interface T07OpWireErr {
  ok: false;
  error: T07OpReason;
}

async function invoke<T>(
  transport: T07OpTransport,
  body: Record<string, unknown>
): Promise<T07OpResult<T>> {
  const r = await transport(body);
  const payload = r.body as Partial<T07OpWireOk<T>> & Partial<T07OpWireErr>;
  if (payload && payload.ok === true) {
    return { ok: true, data: payload.data as T };
  }
  const reason: T07OpReason = (payload?.error as T07OpReason | undefined) ?? 'unknown';
  return { ok: false, reason, status: r.status };
}

// ---------------------------------------------------------------------------
// SupabaseT07Client
// ---------------------------------------------------------------------------

export interface SupabaseT07ClientOptions {
  transport: T07OpTransport;
  localIdentity?: LocalIdentityStore;
}

/**
 * The arrow-return shape of `enrollIdentityViaChallenge` — the caller can
 * `if (r.ok)` to narrow.
 */
export type EnrollResult =
  | { ok: true; user_id: string }
  | { ok: false; reason: T07OpReason; status: number };

export class SupabaseT07Client {
  constructor(private opts: SupabaseT07ClientOptions) {}

  // -----------------------------------------------------------------------
  // Identity enrollment (F-02 sealed-box challenge — G-T07-9 path)
  // -----------------------------------------------------------------------

  /**
   * Drive the F-02 sealed-box enrollment challenge end-to-end.
   *
   * Callers supply:
   *  - `public_key` + `pubkey_fingerprint` — the locally-generated keypair's
   *    public half + the BLAKE2b fingerprint the JS lib's `pubkeyFingerprint`
   *    already computed.
   *  - `private_key` — the locally-generated keypair's secret. Persisted to
   *    LocalIdentityStore ONLY after the challenge succeeds (so a malformed
   *    or hostile challenge cannot get the privkey stored device-side).
   *  - `unsealNonce(sealed_nonce, public_key, private_key)` — a callback
   *    that opens the sealed-box ciphertext with libsodium's
   *    `crypto_box_seal_open`. Injected so this class stays libsodium-
   *    agnostic; production callers pass `(s, pk, sk) =>
   *    sodium.crypto_box_seal_open(s, pk, sk)`.
   */
  async enrollIdentityViaChallenge(input: {
    user_id: string;
    public_key: Uint8Array;
    private_key: Uint8Array;
    pubkey_fingerprint: string;
    unsealNonce: (
      sealed: Uint8Array,
      pk: Uint8Array,
      sk: Uint8Array
    ) => Promise<Uint8Array> | Uint8Array;
  }): Promise<EnrollResult> {
    const init = await invoke<{ challenge_id: string; sealed_nonce_hex: string }>(
      this.opts.transport,
      {
        op: 'enrollment_challenge_init',
        public_key_hex: bytesToPgHex(input.public_key),
        pubkey_fingerprint: input.pubkey_fingerprint
      }
    );
    if (!init.ok) return init;

    const sealed = pgHexToBytes(init.data.sealed_nonce_hex);
    let unsealed: Uint8Array;
    try {
      unsealed = await Promise.resolve(
        input.unsealNonce(sealed, input.public_key, input.private_key)
      );
    } catch {
      // Unseal failure means the client's privkey doesn't match the posted
      // pubkey — the F-02 mitigation's exact catch. Surface as wrong_nonce
      // since the next step would do the same.
      return { ok: false, reason: 'wrong_nonce', status: 403 };
    }

    const finalize = await invoke<string>(this.opts.transport, {
      op: 'enrollment_challenge_finalize',
      challenge_id: init.data.challenge_id,
      unsealed_nonce_hex: bytesToPgHex(unsealed)
    });
    if (!finalize.ok) return finalize;

    // Server accepted the unsealed nonce → identity_keys row committed +
    // identity_keypair.created audit emitted (atomically). Persist the
    // private half device-locally so subsequent self-tests / unwraps /
    // recovery-blob writes succeed.
    if (this.opts.localIdentity) {
      await this.opts.localIdentity.storeIdentityPrivateKey(input.user_id, input.private_key);
    }
    return { ok: true, user_id: finalize.data };
  }

  // -----------------------------------------------------------------------
  // Recovery blob (F-08, F-12, Amendment F)
  // -----------------------------------------------------------------------

  storeRecoveryBlob(input: {
    blob_ciphertext: Uint8Array;
    kdf_params: Record<string, unknown>;
  }): Promise<T07OpResult<null>> {
    return invoke<null>(this.opts.transport, {
      op: 'store_recovery',
      blob_ciphertext_hex: bytesToPgHex(input.blob_ciphertext),
      kdf_params: input.kdf_params
    });
  }

  /**
   * F-08 restore-flow read path. Returns the auth.uid()'s sealed recovery
   * blob + kdf_params, or `null` when no row exists. The SQL function
   * (`get_recovery_blob_for_self`, migration 0010) is structurally
   * self-only — there's no `target_user_id` parameter, so the caller can
   * only ever fetch their own row. Once the client decrypts locally with
   * the passphrase it should post `recordRecoveryBlobRestored` so the
   * audit-trail records the successful restore.
   */
  async getRecoveryBlob(): Promise<
    T07OpResult<{ blob_ciphertext: Uint8Array; kdf_params: Record<string, unknown> } | null>
  > {
    const r = await invoke<{
      blob_ciphertext_hex: string;
      kdf_params: Record<string, unknown>;
    } | null>(this.opts.transport, { op: 'get_recovery_blob' });
    if (!r.ok) return r;
    if (!r.data) return { ok: true, data: null };
    return {
      ok: true,
      data: {
        blob_ciphertext: pgHexToBytes(r.data.blob_ciphertext_hex),
        kdf_params: r.data.kdf_params
      }
    };
  }

  recordRecoveryBlobRestored(input: {
    device_fingerprint_hashed: string;
  }): Promise<T07OpResult<null>> {
    return invoke<null>(this.opts.transport, {
      op: 'record_restored',
      device_fingerprint_hashed: input.device_fingerprint_hashed
    });
  }

  recordRecoveryBlobViewed(input: {
    enrollment_session_id: string;
  }): Promise<T07OpResult<{ reveal_count_in_session: number }>> {
    return invoke<{ reveal_count_in_session: number }>(this.opts.transport, {
      op: 'record_viewed',
      enrollment_session_id: input.enrollment_session_id
    });
  }

  issueRecoveryBlobReset(input: {
    target_user_id: string;
  }): Promise<T07OpResult<{ reset_id: string }>> {
    return invoke<{ reset_id: string }>(this.opts.transport, {
      op: 'issue_reset',
      target_user_id: input.target_user_id
    });
  }

  // -----------------------------------------------------------------------
  // Committee data key (Invariants 5, 6)
  // -----------------------------------------------------------------------

  initCommitteeDataKey(): Promise<T07OpResult<{ key_id: string; epoch: number }>> {
    return invoke<{ key_id: string; epoch: number }>(this.opts.transport, { op: 'init_key' });
  }

  /**
   * Read-only resume probe (P0a-2 / ADR-0026 Amendment A) — return the live
   * (`rotated_at IS NULL`) committee key's id + epoch + the TOTAL wrap count
   * and whether the actor holds a wrap. `null` when no live key exists.
   *
   * The wrap COUNT is the load-bearing discriminator the `already_initialised`
   * resume branch reads to tell edge-A (zero wraps → rotate-and-reinit) from
   * the foreign-held sub-case (some-other-member-wrapped → recoverable error).
   * Branching on actor-wrap presence alone cannot distinguish the two
   * (Amendment A Ruling 1). `actor_user_id` is forwarded so the server can
   * compute `actor_has_wrap` against the caller; the SQL function ignores
   * any mismatch with `auth.uid()` (the server is the trust boundary).
   *
   * Backed server-side by `committee_key_state_for_self` (migration 0037),
   * dispatched as the `committee_key_state` op on t07-op.
   */
  getCommitteeKeyState(input: { actor_user_id: string }): Promise<
    T07OpResult<{
      key_id: string;
      epoch: number;
      wrap_count: number;
      actor_has_wrap: boolean;
    } | null>
  > {
    return invoke<{
      key_id: string;
      epoch: number;
      wrap_count: number;
      actor_has_wrap: boolean;
    } | null>(this.opts.transport, {
      op: 'committee_key_state',
      actor_user_id: input.actor_user_id
    });
  }

  /**
   * Phase 2a PR1 / ADR-0027 Decision 2 (P2a-2) — read the caller's OWN
   * committee-key wrap ciphertext. The FIRST production client method that
   * returns committee key material across the t07-op trust boundary. The wrap
   * is SEALED ciphertext (opaque without the device-local identity privkey);
   * the composition `unwrapCommitteeDataKeyViaProduction` opens it with
   * `crypto_box_seal_open`.
   *
   * F-142 own-wrap-only: the `get_key_wrap` op carries NO id/target/member
   * parameter — the server resolves the wrap against `auth.uid()` only, so
   * there is no IDOR surface. Backed by `get_committee_key_wrap_for_self`
   * (migration 0038), which emits `committee_data_key.unwrap` audit-before-
   * return inside one txn (F-151). `null` when the actor holds no live-key
   * wrap (client maps to no_wrap → Phase 0a setup, Decision 7).
   *
   * hex→bytes via `pgHexToBytes`, mirroring `getRecoveryBlob`.
   */
  async getCommitteeKeyWrapForSelf(): Promise<
    T07OpResult<{ key_id: string; epoch: number; wrapped_ciphertext: Uint8Array } | null>
  > {
    const r = await invoke<{
      key_id: string;
      epoch: number;
      wrapped_ciphertext_hex: string;
    } | null>(this.opts.transport, { op: 'get_key_wrap' });
    if (!r.ok) return r;
    if (!r.data) return { ok: true, data: null };
    return {
      ok: true,
      data: {
        key_id: r.data.key_id,
        epoch: r.data.epoch,
        wrapped_ciphertext: pgHexToBytes(r.data.wrapped_ciphertext_hex)
      }
    };
  }

  wrapCommitteeDataKeyForMember(input: {
    member_user_id: string;
    key_id: string;
    wrapped_ciphertext: Uint8Array;
    rotation_id?: string | null;
  }): Promise<T07OpResult<null>> {
    return invoke<null>(this.opts.transport, {
      op: 'wrap_member',
      member_user_id: input.member_user_id,
      key_id: input.key_id,
      wrapped_ciphertext_hex: bytesToPgHex(input.wrapped_ciphertext),
      rotation_id: input.rotation_id ?? null
    });
  }

  recordCommitteeDataKeyUnwrap(input: { key_id: string }): Promise<T07OpResult<null>> {
    return invoke<null>(this.opts.transport, { op: 'record_unwrap', key_id: input.key_id });
  }

  rotateCommitteeDataKey(input: {
    trigger: 'scheduled' | 'member_removal' | 'incident';
  }): Promise<T07OpResult<{ rotation_id: string; new_key_id: string }>> {
    return invoke<{ rotation_id: string; new_key_id: string }>(this.opts.transport, {
      op: 'rotate',
      trigger: input.trigger
    });
  }

  finalizeCommitteeDataKeyRotation(input: {
    rotation_id: string;
    new_key_id: string;
    members_rewrapped_count: number;
  }): Promise<T07OpResult<null>> {
    return invoke<null>(this.opts.transport, {
      op: 'finalize_rotate',
      rotation_id: input.rotation_id,
      new_key_id: input.new_key_id,
      members_rewrapped_count: input.members_rewrapped_count
    });
  }

  revokeCommitteeMember(input: {
    removed_member_id: string;
    rotation_id: string;
  }): Promise<T07OpResult<{ wraps_removed: number }>> {
    return invoke<{ wraps_removed: number }>(this.opts.transport, {
      op: 'revoke_member',
      removed_member_id: input.removed_member_id,
      rotation_id: input.rotation_id
    });
  }

  // -----------------------------------------------------------------------
  // G-T07-15 server-side emission for client.identity_selftest_fail
  // -----------------------------------------------------------------------

  recordIdentitySelftestFail(input?: {
    meta?: Record<string, unknown>;
  }): Promise<T07OpResult<null>> {
    return invoke<null>(this.opts.transport, {
      op: 'record_selftest_fail',
      meta: input?.meta ?? {}
    });
  }

  // -----------------------------------------------------------------------
  // G-T19-PRIV-3 server-side emission for panic_wipe.invoked
  // -----------------------------------------------------------------------

  /**
   * Emit `panic_wipe.invoked` via `record_panic_wipe_invoked` (migration
   * 0011). F-53 / M-106a audit-before-side-effect: the
   * `BrowserWipeStore.emitAudit` caller MUST await this BEFORE any
   * `clear*` side-effect lands. The CLIENT-supplied `meta` (surface /
   * wipe_scope / completed / partial_failure_classes) merges with the
   * server-derived `actor_id`; the server-derived value overrides any
   * client-smuggled `actor_id`.
   */
  recordPanicWipeInvoked(input?: { meta?: Record<string, unknown> }): Promise<T07OpResult<null>> {
    return invoke<null>(this.opts.transport, {
      op: 'record_panic_wipe',
      meta: input?.meta ?? {}
    });
  }
}
