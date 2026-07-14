/**
 * t07-op / core — high-level identity-keys + recovery-blob + committee-data-
 * key RPC client (T07.1 increment 2; mirrors concern-op / reprisal-op /
 * t14-op).
 *
 * Forwards to the consolidated SECURITY DEFINER RPCs (migration 0007). Authz
 * is enforced server-side inside each function:
 *   - session-only gate (enroll / store / restore / viewed)         — F-116
 *   - active-member gate (init / wrap / unwrap / rotate / finalize) — F-01
 *   - co-chair gate (issue_recovery_blob_reset / revoke_member)     — G-T07-8 / F-12
 *
 * All key material is client-sealed (E2EE per ADR-0003 Invariant 1):
 *   - identity privkey            — never leaves the device
 *   - symmetric committee key     — only inside per-member sealed-box wraps
 *   - recovery-blob plaintext     — Argon2id-derived secretbox, client-only
 * The wire carries bytea as PostgREST hex (`\x…`).
 *
 * Deferred from this increment (per the T07.1 plan):
 *   - F-02 server-issued nonce / sealed-box enrollment challenge (G-T07-9)
 *   - SupabaseKeyStore TS class                                    (G-T07-2)
 *   - KeyStore interface split + `client.identity_selftest_fail` unification
 *     (G-T07-10 / G-T07-15)
 *   - `libsodium-wrappers-sumo` dep swap                           (G-T07-12)
 */

export interface RpcError {
  code: string | null;
  message: string;
}
export type RpcPort = (
  fn: string,
  args: Record<string, unknown>
) => Promise<{ data: unknown; error: RpcError | null }>;

export type T07Reason =
  | 'rls_denied'
  | 'duplicate'
  | 'not_found'
  | 'invalid_input'
  | 'cap_reached'
  | 'already_initialised'
  | 'no_active_members'
  | 'member_not_enrolled'
  | 'rotation_in_progress'
  | 'rotation_not_started'
  | 'challenge_expired'
  | 'challenge_consumed'
  | 'wrong_nonce'
  | 'unknown';

export type OpStatus = 400 | 403 | 404 | 409 | 410 | 422 | 423;
export type OpResult<T> = { ok: true; data: T } | { ok: false; reason: T07Reason; status: OpStatus };

const MESSAGE_LITERALS: ReadonlySet<string> = new Set([
  'rls_denied',
  'duplicate',
  'not_found',
  'invalid_input',
  'cap_reached',
  'already_initialised',
  'no_active_members',
  'member_not_enrolled',
  'rotation_in_progress',
  'rotation_not_started',
  'challenge_expired',
  'challenge_consumed',
  'wrong_nonce',
  'invalid_pubkey',
  'invalid_blob',
  'invalid_kdf_params',
  'invalid_fingerprint',
  'invalid_session_id',
  'invalid_target',
  'invalid_args',
  'invalid_trigger',
  'invalid_new_key',
  'invalid_nonce',
  'invalid_ttl',
  'target_not_member',
  '4eyes_required'
]);

const STATUS: Record<T07Reason, OpStatus> = {
  rls_denied: 403,
  duplicate: 409,
  not_found: 404,
  invalid_input: 422,
  cap_reached: 409,
  already_initialised: 409,
  no_active_members: 422,
  // ADR-0029 P1-4 / Amendment A-5: precondition-failed (mirrors no_active_members:422).
  member_not_enrolled: 422,
  rotation_in_progress: 423,
  rotation_not_started: 422,
  challenge_expired: 410,
  challenge_consumed: 409,
  wrong_nonce: 403,
  unknown: 400
};

/**
 * Map Postgres error → T07 denial contract.
 *
 * The SECURITY DEFINER functions RAISE either a message literal (e.g.
 * `'rls_denied'`, `'cap_reached'`) or an ERRCODE the client can match on:
 *   42501 → rls_denied (every gate raises 42501 with the 'rls_denied' message)
 *   23505 → duplicate (Invariant 1 identity collision; F-12 second-store)
 *   55P03 → rotation_in_progress (pg_try_advisory_xact_lock conflict)
 *   P0001 → covers cap_reached / already_initialised / no_active_members /
 *           rate_limited — disambiguated by the message literal.
 *   23514 → invalid_input (CHECK violation)
 * Catch-all literals (`invalid_pubkey`, `invalid_blob`, etc.) collapse to
 * `invalid_input` because the client surface is the same: re-validate input.
 */
export function mapRpcError(error: RpcError): { reason: T07Reason; status: OpStatus } {
  // First try the message literal — matches the SQL's RAISE EXCEPTION text.
  const msg = error.message;
  if (MESSAGE_LITERALS.has(msg)) {
    let reason: T07Reason;
    switch (msg) {
      case 'rls_denied':
      case '4eyes_required':
        reason = 'rls_denied';
        break;
      case 'duplicate':
        reason = 'duplicate';
        break;
      case 'not_found':
        reason = 'not_found';
        break;
      case 'cap_reached':
        reason = 'cap_reached';
        break;
      case 'already_initialised':
        reason = 'already_initialised';
        break;
      case 'no_active_members':
        reason = 'no_active_members';
        break;
      // ADR-0029 P1-4 (F-174) — the closed-literal denial the SQL keystone
      // raises when the target is not enrolled OR not an active member.
      // `target_not_member` is the alternative literal the test admits;
      // both fold to the same client-mappable reason (status 422).
      case 'member_not_enrolled':
      case 'target_not_member':
        reason = 'member_not_enrolled';
        break;
      case 'rotation_in_progress':
        reason = 'rotation_in_progress';
        break;
      case 'rotation_not_started':
        reason = 'rotation_not_started';
        break;
      case 'challenge_expired':
        reason = 'challenge_expired';
        break;
      case 'challenge_consumed':
        reason = 'challenge_consumed';
        break;
      case 'wrong_nonce':
        reason = 'wrong_nonce';
        break;
      default:
        reason = 'invalid_input';
    }
    return { reason, status: STATUS[reason] };
  }
  // Fall back on ERRCODE.
  let reason: T07Reason = 'unknown';
  if (error.code === '42501') reason = 'rls_denied';
  else if (error.code === '23505') reason = 'duplicate';
  else if (error.code === '55P03') reason = 'rotation_in_progress';
  else if (error.code === '23514') reason = 'invalid_input';
  return { reason, status: STATUS[reason] };
}

async function call<T>(
  rpc: RpcPort,
  fn: string,
  args: Record<string, unknown>
): Promise<OpResult<T>> {
  const { data, error } = await rpc(fn, args);
  if (error) return { ok: false, ...mapRpcError(error) };
  return { ok: true, data: data as T };
}

// ---------------------------------------------------------------------------
// Identity keys (Invariant 1)
// ---------------------------------------------------------------------------

export function enrollIdentityKeypair(
  rpc: RpcPort,
  input: { public_key_hex: string; pubkey_fingerprint: string }
): Promise<OpResult<{ user_id: string }>> {
  return call<string>(rpc, 'enroll_identity_keypair', {
    p_public_key: input.public_key_hex,
    p_pubkey_fingerprint: input.pubkey_fingerprint
  }).then((r) => (r.ok ? { ok: true, data: { user_id: r.data } } : r));
}

// ---------------------------------------------------------------------------
// F-02 sealed-box enrollment challenge (G-T07-9). Two-step handshake:
//   1. issueEnrollmentChallenge — server stores HMAC(nonce) + the Edge
//      Function seals the raw nonce to the posted pubkey via crypto_box_seal.
//   2. verifyAndEnrollIdentityKeypair — client posts the unsealed nonce; the
//      SQL function re-HMACs, compares, and atomically commits identity_keys.
// ---------------------------------------------------------------------------

export function issueEnrollmentChallenge(
  rpc: RpcPort,
  input: {
    public_key_hex: string;
    pubkey_fingerprint: string;
    raw_nonce_hex: string;
    ttl_minutes?: number;
  }
): Promise<OpResult<{ challenge_id: string }>> {
  return call<string>(rpc, 'issue_enrollment_challenge', {
    p_public_key: input.public_key_hex,
    p_pubkey_fingerprint: input.pubkey_fingerprint,
    p_raw_nonce: input.raw_nonce_hex,
    p_ttl_minutes: input.ttl_minutes ?? 10
  }).then((r) => (r.ok ? { ok: true, data: { challenge_id: r.data } } : r));
}

export function verifyAndEnrollIdentityKeypair(
  rpc: RpcPort,
  input: { challenge_id: string; raw_nonce_observed_hex: string }
): Promise<OpResult<{ user_id: string }>> {
  return call<string>(rpc, 'verify_and_enroll_identity_keypair', {
    p_challenge_id: input.challenge_id,
    p_raw_nonce_observed: input.raw_nonce_observed_hex
  }).then((r) => (r.ok ? { ok: true, data: { user_id: r.data } } : r));
}

/**
 * G-T07-15 / G-T07-2 — emit `client.identity_selftest_fail` server-side
 * via the SECURITY DEFINER `record_identity_selftest_fail` function
 * (migration 0009). The CLIENT supplies the forensic meta; the SQL
 * function adds the server-derived `actor_id` and stamps the canonical
 * event_type / retention_class.
 */
export function recordIdentitySelftestFail(
  rpc: RpcPort,
  input: { meta?: Record<string, unknown> }
): Promise<OpResult<null>> {
  return call<null>(rpc, 'record_identity_selftest_fail', {
    p_meta: input.meta ?? {}
  });
}

/**
 * G-T19-PRIV-3 — emit `panic_wipe.invoked` server-side via the
 * SECURITY DEFINER `record_panic_wipe_invoked` function (migration 0011).
 * Same shape as recordIdentitySelftestFail; the CLIENT-supplied meta
 * (surface / wipe_scope / completed / partial_failure_classes) merges
 * with the server-derived `actor_id`. F-53 / M-106a contract: the
 * caller (`BrowserWipeStore.emitAudit`) MUST await this BEFORE any
 * clear* side-effect lands.
 */
export function recordPanicWipeInvoked(
  rpc: RpcPort,
  input: { meta?: Record<string, unknown> }
): Promise<OpResult<null>> {
  return call<null>(rpc, 'record_panic_wipe_invoked', {
    p_meta: input.meta ?? {}
  });
}

// ---------------------------------------------------------------------------
// Recovery blob (F-08, F-12, Amendment F)
// ---------------------------------------------------------------------------

export function storeRecoveryBlob(
  rpc: RpcPort,
  input: { blob_ciphertext_hex: string; kdf_params: Record<string, unknown> }
): Promise<OpResult<null>> {
  return call<null>(rpc, 'store_recovery_blob', {
    p_blob_ciphertext: input.blob_ciphertext_hex,
    p_kdf_params: input.kdf_params
  });
}

/**
 * F-08 restore-flow read path (migration 0010). Returns the auth.uid()'s
 * sealed recovery blob + kdf_params, or `null` when no row exists. The
 * SQL function is structurally self-only (no parameter); the client
 * decrypts with the passphrase locally and posts the recovery once via
 * `record_recovery_blob_restored`.
 */
export function getRecoveryBlob(
  rpc: RpcPort
): Promise<OpResult<{ blob_ciphertext_hex: string; kdf_params: Record<string, unknown> } | null>> {
  return call<Array<{ blob_ciphertext: string; kdf_params: Record<string, unknown> }>>(
    rpc,
    'get_recovery_blob_for_self',
    {}
  ).then((r) => {
    if (!r.ok) return r;
    const row = r.data?.[0];
    if (!row) return { ok: true, data: null };
    return {
      ok: true,
      data: { blob_ciphertext_hex: row.blob_ciphertext, kdf_params: row.kdf_params }
    };
  });
}

export function recordRecoveryBlobRestored(
  rpc: RpcPort,
  input: { device_fingerprint_hashed: string }
): Promise<OpResult<null>> {
  return call<null>(rpc, 'record_recovery_blob_restored', {
    p_device_fingerprint_hashed: input.device_fingerprint_hashed
  });
}

/**
 * Amendment F reveal. SERVER enforces the cap-of-3 per enrollment_session_id
 * (G-T07-7). On the 4th call within the same session the SQL function raises
 * `cap_reached` (P0001) — surfaced here as `{ ok: false, reason: 'cap_reached', status: 409 }`.
 */
export function recordRecoveryBlobViewed(
  rpc: RpcPort,
  input: { enrollment_session_id: string }
): Promise<OpResult<{ reveal_count_in_session: number }>> {
  return call<number>(rpc, 'record_recovery_blob_viewed', {
    p_enrollment_session_id: input.enrollment_session_id
  }).then((r) => (r.ok ? { ok: true, data: { reveal_count_in_session: r.data } } : r));
}

export function issueRecoveryBlobReset(
  rpc: RpcPort,
  input: { target_user_id: string }
): Promise<OpResult<{ reset_id: string }>> {
  return call<string>(rpc, 'issue_recovery_blob_reset', {
    p_target_user_id: input.target_user_id
  }).then((r) => (r.ok ? { ok: true, data: { reset_id: r.data } } : r));
}

// ---------------------------------------------------------------------------
// Committee data key (Invariants 5, 6)
// ---------------------------------------------------------------------------

export function initCommitteeDataKey(
  rpc: RpcPort
): Promise<OpResult<{ key_id: string; epoch: number }>> {
  return call<Array<{ key_id: string; epoch: number }>>(rpc, 'init_committee_data_key', {}).then(
    (r) => {
      if (!r.ok) return r;
      const row = r.data?.[0];
      if (!row) return { ok: false, reason: 'unknown', status: 400 };
      return { ok: true, data: row };
    }
  );
}

/**
 * ADR-0026 Phase 0a (P0a-2) — read-only resume probe for the live committee
 * key's state (key_id + epoch + TOTAL wrap count + actor-has-wrap). Backed by
 * the self-only `committee_key_state_for_self` SECURITY DEFINER fn (migration
 * 0037). The wrap COUNT is the F-138 edge-A discriminator (Amendment A
 * Ruling 1); no key material crosses the boundary. `null` when no live key
 * exists. The `actor_user_id` carried on the wire is forwarded by the
 * dispatcher for symmetry with the client probe shape; the SQL computes
 * `actor_has_wrap` against `auth.uid()` regardless (the server is the trust
 * boundary), so a smuggled mismatch cannot widen the result.
 */
export function committeeKeyState(
  rpc: RpcPort
): Promise<
  OpResult<{ key_id: string; epoch: number; wrap_count: number; actor_has_wrap: boolean } | null>
> {
  return call<
    Array<{ key_id: string; epoch: number; wrap_count: number; actor_has_wrap: boolean }>
  >(rpc, 'committee_key_state_for_self', {}).then((r) => {
    if (!r.ok) return r;
    const row = r.data?.[0];
    if (!row) return { ok: true, data: null };
    return { ok: true, data: row };
  });
}

/**
 * Phase 2a PR1 / ADR-0027 Decision 2 — read the caller's OWN committee-key
 * wrap ciphertext (the FIRST production RPC that returns committee key material
 * across the trust boundary). Backed by the self-only
 * `get_committee_key_wrap_for_self` SECURITY DEFINER fn (migration 0038) which
 * emits `committee_data_key.unwrap` audit-BEFORE-return inside one txn (F-151)
 * and reads ONLY `WHERE user_id = auth.uid()` on the live key (F-142:
 * own-wrap-only, no IDOR — the fn takes NO parameter). `null` when the actor
 * holds no live-key wrap (client maps to no_wrap → Phase 0a setup). The wrap is
 * SEALED ciphertext (useless without the device-local identity privkey); the
 * bytea crosses the wire as PostgREST hex (`\x…`).
 */
export function getCommitteeKeyWrapForSelf(
  rpc: RpcPort
): Promise<
  OpResult<{ key_id: string; epoch: number; wrapped_ciphertext_hex: string } | null>
> {
  return call<Array<{ key_id: string; epoch: number; wrapped_ciphertext: string }>>(
    rpc,
    'get_committee_key_wrap_for_self',
    {}
  ).then((r) => {
    if (!r.ok) return r;
    const row = r.data?.[0];
    if (!row) return { ok: true, data: null };
    return {
      ok: true,
      data: { key_id: row.key_id, epoch: row.epoch, wrapped_ciphertext_hex: row.wrapped_ciphertext }
    };
  });
}

/**
 * F182-1 / ADR-0030 Decision 6 — read ALL of the caller's OWN committee-key
 * wraps across every epoch (live + retired). Generalizes
 * `getCommitteeKeyWrapForSelf` from the single live wrap to the multi-epoch
 * SETOF (the F-183 anti-lockout property: a member keeps reading data sealed
 * under a rotated-out key). Backed by the self-only
 * `get_all_committee_key_wraps_for_self` SECURITY DEFINER fn (migration 0045)
 * which gates on `_t07_gate_active_member`, emits `committee_data_key.unwrap`
 * audit-before-return per distinct key (F-148), and reads ONLY
 * `WHERE user_id = auth.uid()` on the LIVE wrap table (F-183 (i): own-wrap-only,
 * no IDOR — the fn takes NO parameter; never `committee_key_wraps_history`).
 *
 * Each SQL row's `wrapped_ciphertext` bytea → `wrapped_ciphertext_hex` EXACTLY
 * as the single-arm does (PostgREST hex `\x…`); `is_live` is surfaced per row.
 * An empty SETOF surfaces as `{ ok: true, data: [] }` (the holding state).
 */
export function getAllKeyWrapsForSelf(
  rpc: RpcPort
): Promise<
  OpResult<
    Array<{ key_id: string; epoch: number; wrapped_ciphertext_hex: string; is_live: boolean }>
  >
> {
  return call<
    Array<{ key_id: string; epoch: number; wrapped_ciphertext: string; is_live: boolean }>
  >(rpc, 'get_all_committee_key_wraps_for_self', {}).then((r) => {
    if (!r.ok) return r;
    return {
      ok: true,
      data: (r.data ?? []).map((row) => ({
        key_id: row.key_id,
        epoch: row.epoch,
        wrapped_ciphertext_hex: row.wrapped_ciphertext,
        is_live: row.is_live
      }))
    };
  });
}

/**
 * ADR-0029 P1-4 / P1-5 — read the TARGET member's enrolled identity public key
 * for the co-chair-side wrap composition. The FIRST production EF surface that
 * returns ANOTHER member's pubkey across the trust boundary. Backed server-side
 * by `get_member_identity_pubkey_for_wrap` (SQL migration 0042) which is
 * co-chair-gated in-fn, emits `identity_pubkey.disclosed_for_wrap`
 * audit-before-return SUCCESS-ONLY (Amendment A-1), and collapses all four
 * target-failure branches to the closed literal `member_not_enrolled`
 * (Amendment A-2, F-174 enumeration-defeat).
 *
 * Wire shape: `{ public_key_hex, fingerprint }`. The bytea crosses the wire as
 * PostgREST hex (`\x...`); the apps/web `SupabaseT07Client` converts to
 * `Uint8Array` via `pgHexToBytes` the same way `getCommitteeKeyWrapForSelf`
 * does. The fingerprint is the server-side re-derived SHA-256 hex
 * (Amendment A-6.1 supersedes A-6's BLAKE2b choice); the EF forwards verbatim.
 *
 * F-172: only `target_user_id` is forwarded — no caller-supplied pubkey field.
 * F-176: the returned hex / fingerprint / target uid NEVER reach a log line;
 * the dispatcher's reason-only logging posture is the structural mitigation.
 */
export function getMemberPubkey(
  rpc: RpcPort,
  input: { target_user_id: string }
): Promise<OpResult<{ public_key_hex: string; fingerprint: string }>> {
  // ONLY p_target_user_id is forwarded (F-172). Any caller-smuggled
  // pubkey/sealed/cipher/wrap field is dropped here by destructuring.
  return call<Array<{ public_key: string; fingerprint: string }>>(
    rpc,
    'get_member_identity_pubkey_for_wrap',
    { p_target_user_id: input.target_user_id }
  ).then((r) => {
    if (!r.ok) return r;
    const row = r.data?.[0];
    if (!row) {
      // The SQL keystone returns NO ROWS only when it RAISEs an exception
      // (success path always returns one row). A null row here would mean a
      // server-side regression; collapse to the closed denial literal so the
      // composition cannot proceed to seal-to-nothing.
      return { ok: false, reason: 'member_not_enrolled', status: 422 };
    }
    return {
      ok: true,
      data: { public_key_hex: row.public_key, fingerprint: row.fingerprint }
    };
  });
}

export function wrapCommitteeDataKeyForMember(
  rpc: RpcPort,
  input: {
    member_user_id: string;
    key_id: string;
    wrapped_ciphertext_hex: string;
    rotation_id?: string | null;
  }
): Promise<OpResult<null>> {
  return call<null>(rpc, 'wrap_committee_data_key_for_member', {
    p_member_user_id: input.member_user_id,
    p_key_id: input.key_id,
    p_wrapped_ciphertext: input.wrapped_ciphertext_hex,
    p_rotation_id: input.rotation_id ?? null
  });
}

export function recordCommitteeDataKeyUnwrap(
  rpc: RpcPort,
  input: { key_id: string }
): Promise<OpResult<null>> {
  return call<null>(rpc, 'record_committee_data_key_unwrap', { p_key_id: input.key_id });
}

export type RotationTrigger = 'scheduled' | 'member_removal' | 'incident';

/**
 * F-04 / G-T07-14. On lock contention the SQL function raises
 * `rotation_in_progress` (55P03) — surfaced as status 423 so the caller can
 * back off / retry. On zero active members it raises `no_active_members`
 * (P0001) — surfaced as 422.
 */
export function rotateCommitteeDataKey(
  rpc: RpcPort,
  input: { trigger: RotationTrigger }
): Promise<OpResult<{ rotation_id: string; new_key_id: string }>> {
  return call<Array<{ rotation_id: string; new_key_id: string }>>(rpc, 'rotate_committee_data_key', {
    p_trigger: input.trigger
  }).then((r) => {
    if (!r.ok) return r;
    const row = r.data?.[0];
    if (!row) return { ok: false, reason: 'unknown', status: 400 };
    return { ok: true, data: row };
  });
}

export function finalizeCommitteeDataKeyRotation(
  rpc: RpcPort,
  input: { rotation_id: string; new_key_id: string; members_rewrapped_count: number }
): Promise<OpResult<null>> {
  return call<null>(rpc, 'finalize_committee_data_key_rotation', {
    p_rotation_id: input.rotation_id,
    p_new_key_id: input.new_key_id,
    p_members_rewrapped_count: input.members_rewrapped_count
  });
}

export function revokeCommitteeMember(
  rpc: RpcPort,
  input: { removed_member_id: string; rotation_id: string }
): Promise<OpResult<{ wraps_removed: number }>> {
  return call<number>(rpc, 'revoke_committee_member', {
    p_removed_member_id: input.removed_member_id,
    p_rotation_id: input.rotation_id
  }).then((r) => (r.ok ? { ok: true, data: { wraps_removed: r.data } } : r));
}
