/**
 * t07-op / core tests (Deno-native) — T07.1 increment 2.
 * Run: `deno test supabase/functions/t07-op/test/core.test.ts`.
 *
 * Hermetic: verifies RPC arg forwarding (the 11 SECURITY DEFINER fns from
 * migration 0007) + error-mapping for the T07.1 denial contract:
 *   42501 → rls_denied (every gate),
 *   23505 → duplicate (one identity per user; F-12 second-store),
 *   55P03 → rotation_in_progress (F-04 advisory-lock contention),
 *   P0001 message literals: cap_reached (G-T07-7), already_initialised,
 *                           no_active_members (G-T07-14), rotation_not_started.
 */

import {
  enrollIdentityKeypair,
  finalizeCommitteeDataKeyRotation,
  initCommitteeDataKey,
  issueEnrollmentChallenge,
  issueRecoveryBlobReset,
  mapRpcError,
  recordCommitteeDataKeyUnwrap,
  recordRecoveryBlobRestored,
  recordRecoveryBlobViewed,
  revokeCommitteeMember,
  rotateCommitteeDataKey,
  storeRecoveryBlob,
  verifyAndEnrollIdentityKeypair,
  wrapCommitteeDataKeyForMember,
  type RpcError,
  type RpcPort
} from '../core.ts';

function assert(c: unknown, m = 'assertion failed'): asserts c {
  if (!c) throw new Error(m);
}
function assertEquals(a: unknown, e: unknown, m?: string): void {
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    throw new Error(m ?? `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
  }
}
function fakeRpc(
  result: { data: unknown; error: RpcError | null },
  calls: Array<{ fn: string; args: Record<string, unknown> }>
): RpcPort {
  return async (fn, args) => {
    calls.push({ fn, args });
    return result;
  };
}

// ---- identity_keys ---------------------------------------------------------

Deno.test('enrollIdentityKeypair forwards public_key + fingerprint, returns user_id', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const r = await enrollIdentityKeypair(fakeRpc({ data: 'u-1', error: null }, c), {
    public_key_hex: '\\x' + '42'.repeat(32),
    pubkey_fingerprint: 'a'.repeat(64)
  });
  assert(r.ok);
  assertEquals(r.data, { user_id: 'u-1' });
  assertEquals(c[0], {
    fn: 'enroll_identity_keypair',
    args: { p_public_key: '\\x' + '42'.repeat(32), p_pubkey_fingerprint: 'a'.repeat(64) }
  });
});

// ---- F-02 sealed-box enrollment challenge (G-T07-9) ----------------------

Deno.test('issueEnrollmentChallenge forwards pubkey + fingerprint + raw_nonce + ttl', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const r = await issueEnrollmentChallenge(fakeRpc({ data: 'chal-1', error: null }, c), {
    public_key_hex: '\\x' + '42'.repeat(32),
    pubkey_fingerprint: 'a'.repeat(64),
    raw_nonce_hex: '\\x' + 'cd'.repeat(32),
    ttl_minutes: 10
  });
  assert(r.ok);
  assertEquals(r.data, { challenge_id: 'chal-1' });
  assertEquals(c[0], {
    fn: 'issue_enrollment_challenge',
    args: {
      p_public_key: '\\x' + '42'.repeat(32),
      p_pubkey_fingerprint: 'a'.repeat(64),
      p_raw_nonce: '\\x' + 'cd'.repeat(32),
      p_ttl_minutes: 10
    }
  });
});

Deno.test('issueEnrollmentChallenge defaults ttl_minutes to 10', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  await issueEnrollmentChallenge(fakeRpc({ data: 'chal-1', error: null }, c), {
    public_key_hex: '\\x42',
    pubkey_fingerprint: 'a'.repeat(64),
    raw_nonce_hex: '\\xcd'
  });
  assertEquals((c[0]?.args as { p_ttl_minutes: number }).p_ttl_minutes, 10);
});

Deno.test('verifyAndEnrollIdentityKeypair forwards challenge_id + raw_nonce_observed, returns user_id', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const r = await verifyAndEnrollIdentityKeypair(fakeRpc({ data: 'u-1', error: null }, c), {
    challenge_id: 'chal-1',
    raw_nonce_observed_hex: '\\x' + 'cd'.repeat(32)
  });
  assert(r.ok);
  assertEquals(r.data, { user_id: 'u-1' });
  assertEquals(c[0], {
    fn: 'verify_and_enroll_identity_keypair',
    args: { p_challenge_id: 'chal-1', p_raw_nonce_observed: '\\x' + 'cd'.repeat(32) }
  });
});

Deno.test('verifyAndEnrollIdentityKeypair surfaces wrong_nonce (P0001) as 403', async () => {
  const r = await verifyAndEnrollIdentityKeypair(
    fakeRpc({ data: null, error: { code: 'P0001', message: 'wrong_nonce' } }, []),
    { challenge_id: 'chal-1', raw_nonce_observed_hex: '\\x00' }
  );
  assert(!r.ok);
  assertEquals(r.reason, 'wrong_nonce');
  assertEquals(r.status, 403);
});

Deno.test('verifyAndEnrollIdentityKeypair surfaces challenge_expired (P0001) as 410', async () => {
  const r = await verifyAndEnrollIdentityKeypair(
    fakeRpc({ data: null, error: { code: 'P0001', message: 'challenge_expired' } }, []),
    { challenge_id: 'chal-1', raw_nonce_observed_hex: '\\xcd' }
  );
  assert(!r.ok);
  assertEquals(r.reason, 'challenge_expired');
  assertEquals(r.status, 410);
});

Deno.test('verifyAndEnrollIdentityKeypair surfaces challenge_consumed (P0001) as 409', async () => {
  const r = await verifyAndEnrollIdentityKeypair(
    fakeRpc({ data: null, error: { code: 'P0001', message: 'challenge_consumed' } }, []),
    { challenge_id: 'chal-1', raw_nonce_observed_hex: '\\xcd' }
  );
  assert(!r.ok);
  assertEquals(r.reason, 'challenge_consumed');
  assertEquals(r.status, 409);
});

Deno.test('enrollIdentityKeypair surfaces duplicate (23505) — F-12 / Invariant 1', async () => {
  const r = await enrollIdentityKeypair(
    fakeRpc({ data: null, error: { code: '23505', message: 'duplicate' } }, []),
    { public_key_hex: '\\x' + '42'.repeat(32), pubkey_fingerprint: 'a'.repeat(64) }
  );
  assert(!r.ok);
  assertEquals(r.reason, 'duplicate');
  assertEquals(r.status, 409);
});

// ---- recovery blob ---------------------------------------------------------

Deno.test('storeRecoveryBlob forwards ciphertext + kdf_params', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const kdf = { alg: 'argon2id13', version: 1, ops: 4, mem_bytes: 536870912 };
  await storeRecoveryBlob(fakeRpc({ data: null, error: null }, c), {
    blob_ciphertext_hex: '\\xDEADBEEF',
    kdf_params: kdf
  });
  assertEquals(c[0], {
    fn: 'store_recovery_blob',
    args: { p_blob_ciphertext: '\\xDEADBEEF', p_kdf_params: kdf }
  });
});

Deno.test('storeRecoveryBlob surfaces duplicate as 409 (F-12 single-POST)', async () => {
  const r = await storeRecoveryBlob(
    fakeRpc({ data: null, error: { code: '23505', message: 'duplicate' } }, []),
    { blob_ciphertext_hex: '\\xAA', kdf_params: { alg: 'argon2id13', version: 1 } }
  );
  assert(!r.ok);
  assertEquals(r.reason, 'duplicate');
  assertEquals(r.status, 409);
});

Deno.test('recordRecoveryBlobRestored forwards pre-hashed device fingerprint', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  await recordRecoveryBlobRestored(fakeRpc({ data: null, error: null }, c), {
    device_fingerprint_hashed: 'e'.repeat(64)
  });
  assertEquals(c[0], {
    fn: 'record_recovery_blob_restored',
    args: { p_device_fingerprint_hashed: 'e'.repeat(64) }
  });
});

Deno.test('recordRecoveryBlobViewed returns the server-derived reveal_count_in_session', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const r = await recordRecoveryBlobViewed(fakeRpc({ data: 2, error: null }, c), {
    enrollment_session_id: 'sess-A'
  });
  assert(r.ok);
  assertEquals(r.data, { reveal_count_in_session: 2 });
  assertEquals(c[0].args, { p_enrollment_session_id: 'sess-A' });
});

Deno.test('recordRecoveryBlobViewed surfaces G-T07-7 cap_reached as 409', async () => {
  const r = await recordRecoveryBlobViewed(
    fakeRpc({ data: null, error: { code: 'P0001', message: 'cap_reached' } }, []),
    { enrollment_session_id: 'sess-A' }
  );
  assert(!r.ok);
  assertEquals(r.reason, 'cap_reached');
  assertEquals(r.status, 409);
});

Deno.test('issueRecoveryBlobReset forwards target_user_id, returns reset_id (G-T07-8)', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const r = await issueRecoveryBlobReset(fakeRpc({ data: 'rst-1', error: null }, c), {
    target_user_id: 'u-2'
  });
  assert(r.ok);
  assertEquals(r.data, { reset_id: 'rst-1' });
  assertEquals(c[0].args, { p_target_user_id: 'u-2' });
});

Deno.test('issueRecoveryBlobReset surfaces co-chair-gate denial (42501) as rls_denied/403', async () => {
  const r = await issueRecoveryBlobReset(
    fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []),
    { target_user_id: 'u-2' }
  );
  assert(!r.ok);
  assertEquals(r.reason, 'rls_denied');
  assertEquals(r.status, 403);
});

// ---- committee data key ----------------------------------------------------

Deno.test('initCommitteeDataKey returns the first row {key_id, epoch}', async () => {
  const r = await initCommitteeDataKey(
    fakeRpc({ data: [{ key_id: 'k-1', epoch: 1 }], error: null }, [])
  );
  assert(r.ok);
  assertEquals(r.data, { key_id: 'k-1', epoch: 1 });
});

Deno.test('initCommitteeDataKey surfaces already_initialised (P0001) as 409', async () => {
  const r = await initCommitteeDataKey(
    fakeRpc({ data: null, error: { code: 'P0001', message: 'already_initialised' } }, [])
  );
  assert(!r.ok);
  assertEquals(r.reason, 'already_initialised');
  assertEquals(r.status, 409);
});

Deno.test('wrapCommitteeDataKeyForMember forwards rotation_id (NULL when omitted)', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  await wrapCommitteeDataKeyForMember(fakeRpc({ data: null, error: null }, c), {
    member_user_id: 'u-2',
    key_id: 'k-1',
    wrapped_ciphertext_hex: '\\xCAFEBABE'
  });
  assertEquals(c[0].args, {
    p_member_user_id: 'u-2',
    p_key_id: 'k-1',
    p_wrapped_ciphertext: '\\xCAFEBABE',
    p_rotation_id: null
  });

  const c2: Array<{ fn: string; args: Record<string, unknown> }> = [];
  await wrapCommitteeDataKeyForMember(fakeRpc({ data: null, error: null }, c2), {
    member_user_id: 'u-2',
    key_id: 'k-2',
    wrapped_ciphertext_hex: '\\xAA',
    rotation_id: 'rot-1'
  });
  assertEquals(c2[0].args, {
    p_member_user_id: 'u-2',
    p_key_id: 'k-2',
    p_wrapped_ciphertext: '\\xAA',
    p_rotation_id: 'rot-1'
  });
});

Deno.test('recordCommitteeDataKeyUnwrap forwards key_id', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  await recordCommitteeDataKeyUnwrap(fakeRpc({ data: null, error: null }, c), { key_id: 'k-1' });
  assertEquals(c[0], { fn: 'record_committee_data_key_unwrap', args: { p_key_id: 'k-1' } });
});

Deno.test('rotateCommitteeDataKey returns first row {rotation_id, new_key_id}', async () => {
  const r = await rotateCommitteeDataKey(
    fakeRpc({ data: [{ rotation_id: 'rot-1', new_key_id: 'k-2' }], error: null }, []),
    { trigger: 'scheduled' }
  );
  assert(r.ok);
  assertEquals(r.data, { rotation_id: 'rot-1', new_key_id: 'k-2' });
});

Deno.test('rotateCommitteeDataKey surfaces F-04 advisory-lock contention (55P03 → 423)', async () => {
  const r = await rotateCommitteeDataKey(
    fakeRpc({ data: null, error: { code: '55P03', message: 'rotation_in_progress' } }, []),
    { trigger: 'incident' }
  );
  assert(!r.ok);
  assertEquals(r.reason, 'rotation_in_progress');
  assertEquals(r.status, 423);
});

Deno.test('rotateCommitteeDataKey surfaces G-T07-14 no_active_members (P0001 → 422)', async () => {
  const r = await rotateCommitteeDataKey(
    fakeRpc({ data: null, error: { code: 'P0001', message: 'no_active_members' } }, []),
    { trigger: 'member_removal' }
  );
  assert(!r.ok);
  assertEquals(r.reason, 'no_active_members');
  assertEquals(r.status, 422);
});

Deno.test('finalizeCommitteeDataKeyRotation forwards all three params', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  await finalizeCommitteeDataKeyRotation(fakeRpc({ data: null, error: null }, c), {
    rotation_id: 'rot-1',
    new_key_id: 'k-2',
    members_rewrapped_count: 3
  });
  assertEquals(c[0].args, {
    p_rotation_id: 'rot-1',
    p_new_key_id: 'k-2',
    p_members_rewrapped_count: 3
  });
});

Deno.test('revokeCommitteeMember returns wraps_removed count, threads rotation_id', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const r = await revokeCommitteeMember(fakeRpc({ data: 2, error: null }, c), {
    removed_member_id: 'u-3',
    rotation_id: 'rot-1'
  });
  assert(r.ok);
  assertEquals(r.data, { wraps_removed: 2 });
  assertEquals(c[0].args, { p_removed_member_id: 'u-3', p_rotation_id: 'rot-1' });
});

Deno.test('revokeCommitteeMember surfaces 4eyes_required (42501) as rls_denied/403', async () => {
  const r = await revokeCommitteeMember(
    fakeRpc({ data: null, error: { code: '42501', message: '4eyes_required' } }, []),
    { removed_member_id: 'u-3', rotation_id: 'rot-1' }
  );
  assert(!r.ok);
  assertEquals(r.reason, 'rls_denied');
  assertEquals(r.status, 403);
});

// ---- error mapping ---------------------------------------------------------

Deno.test('mapRpcError honors message literal first, then ERRCODE fallback', () => {
  const cases: Array<[RpcError, string, number]> = [
    // Message literals — pinned to the T07.1 reason set.
    [{ code: '42501', message: 'rls_denied' }, 'rls_denied', 403],
    [{ code: '23505', message: 'duplicate' }, 'duplicate', 409],
    [{ code: 'P0001', message: 'cap_reached' }, 'cap_reached', 409],
    [{ code: 'P0001', message: 'already_initialised' }, 'already_initialised', 409],
    [{ code: 'P0001', message: 'no_active_members' }, 'no_active_members', 422],
    [{ code: '55P03', message: 'rotation_in_progress' }, 'rotation_in_progress', 423],
    [{ code: 'P0001', message: 'rotation_not_started' }, 'rotation_not_started', 422],
    // F-02 (G-T07-9) reasons.
    [{ code: 'P0001', message: 'wrong_nonce' }, 'wrong_nonce', 403],
    [{ code: 'P0001', message: 'challenge_expired' }, 'challenge_expired', 410],
    [{ code: 'P0001', message: 'challenge_consumed' }, 'challenge_consumed', 409],
    [{ code: 'P0001', message: 'invalid_nonce' }, 'invalid_input', 422],
    [{ code: 'P0001', message: 'invalid_ttl' }, 'invalid_input', 422],
    // Validation literals collapse to invalid_input.
    [{ code: 'P0001', message: 'invalid_pubkey' }, 'invalid_input', 422],
    [{ code: 'P0001', message: 'invalid_blob' }, 'invalid_input', 422],
    [{ code: 'P0001', message: 'invalid_kdf_params' }, 'invalid_input', 422],
    [{ code: 'P0001', message: 'invalid_fingerprint' }, 'invalid_input', 422],
    [{ code: 'P0001', message: 'invalid_session_id' }, 'invalid_input', 422],
    [{ code: 'P0001', message: 'invalid_args' }, 'invalid_input', 422],
    [{ code: 'P0001', message: 'invalid_trigger' }, 'invalid_input', 422],
    [{ code: 'P0001', message: 'invalid_new_key' }, 'invalid_input', 422],
    // ERRCODE fallback when message is opaque.
    [{ code: '42501', message: 'permission denied' }, 'rls_denied', 403],
    [{ code: '23505', message: 'unique violation' }, 'duplicate', 409],
    [{ code: '23514', message: 'check constraint' }, 'invalid_input', 422],
    [{ code: '08006', message: 'conn failure' }, 'unknown', 400]
  ];
  for (const [err, reason, status] of cases) assertEquals(mapRpcError(err), { reason, status });
});
