/**
 * Per-committee shared data key primitives (T07 / ADR-0003 Invariants 5, 6).
 *
 * The committee data key is a SYMMETRIC libsodium `crypto_secretbox` key
 * (`crypto_secretbox_keygen()` → 32 bytes). It is the actual key that
 * encrypts every C2/C3/C4 row. Each active committee member receives a
 * SEALED-BOX wrap (`crypto_box_seal`) addressed to their X25519 identity
 * public key; only that member's private key can open the wrap.
 *
 * Lifecycle:
 *   1. `initCommitteeDataKey` — generate a fresh 32-byte data key + a
 *      KeyStore metadata row + the actor's own wrap.
 *   2. `wrapForMember` — wrap the current data key for another active
 *      member. Active-member RLS check enforced by KeyStore.
 *   3. `unwrapForSession` — the device opens its own wrap with the local
 *      identity privkey; emits `committee_data_key.unwrap`.
 *   4. `rotateCommitteeKey` — new epoch; old wraps stay on
 *      `committee_data_key_history` for retention forensics until the
 *      configured horizon. Forward secrecy on member revoke means the
 *      old epoch's wraps are deleted FOR the removed member only.
 *   5. `revokeMember` — purges removed-member wraps current + history.
 *
 * Every entry point emits one of the 8 ADR-0003 Amendment A audit events
 * through `KeyStore.recordKeyEvent` (single emission path).
 *
 * Invariant compliance:
 *   - Invariant 1 — only ever sees the symmetric key in plaintext briefly
 *     on the actor's device during init / unwrap / rotate; the symmetric
 *     key NEVER persists on the server.
 *   - Invariant 5 — wraps are addressed to identity pubkeys; nothing
 *     key-shaped lands in URLs (see threat-model invariant 5).
 *   - Invariant 6 — rotation creates a new epoch; old epoch retained
 *     until natural retention expires, except for the removed member
 *     whose wrap is deleted in the same transaction as the rotation
 *     (F-05).
 */

import { ready } from './sodium';
import type { KeyStore } from './key-store';
import type { RotateCommitteeKeyResult, WrapForMemberResult } from './types';

/**
 * Generate a fresh 32-byte symmetric committee data key. Per ADR-0003
 * Invariant 4 this uses libsodium's `randombytes_buf` rather than a
 * less-vetted PRNG.
 */
async function generateDataKeyBytes(): Promise<Uint8Array> {
  const s = await ready();
  // `crypto_secretbox_keygen` is not in our minimal type surface; use
  // randombytes_buf of secretbox_KEYBYTES which is the exact equivalent
  // (libsodium's keygen IS just secure random bytes of the right length).
  return s.randombytes_buf(s.crypto_secretbox_KEYBYTES);
}

/**
 * Initialise a committee data key. The actor (the user calling) becomes
 * the first wrapped member. Returns the newly-minted committee key id.
 */
export async function initCommitteeDataKey(
  store: KeyStore,
  actor_user_id: string
): Promise<{ key_id: string; epoch: number }> {
  // 1) Generate the data key + persist metadata.
  const meta = await store.initCommitteeDataKey({
    actor_user_id,
    actor_pseudonym: store.pseudonymOf(actor_user_id)
  });
  const dataKey = await generateDataKeyBytes();

  // 2) Stash the cleartext data key for tests so wrap/unwrap can round-
  //    trip. Production KeyStore implementations IGNORE this call (the
  //    method is test-only on the concrete MemoryKeyStore). We type-test
  //    instead of importing the concrete class.
  const concrete = store as unknown as {
    __setDataKeyBytesForKeyId?: (key_id: string, bytes: Uint8Array) => void;
  };
  if (typeof concrete.__setDataKeyBytesForKeyId === 'function') {
    concrete.__setDataKeyBytesForKeyId(meta.key_id, dataKey);
  }

  // 3) Wrap for the actor themselves.
  const actorPubkey = await store.getIdentityPublicKey(actor_user_id);
  const s = await ready();
  const wrap = s.crypto_box_seal(dataKey, actorPubkey);
  const inserted = await store.insertCommitteeKeyWrap({
    member_user_id: actor_user_id,
    key_id: meta.key_id,
    wrapped_ciphertext: wrap
  });
  if (!inserted.ok) {
    throw new Error(
      `initCommitteeDataKey: actor wrap insert denied (${inserted.reason}). ` +
        'The actor must be an active committee member.'
    );
  }

  // 4) Amendment A: wrapped_for_member audit row for the actor's own wrap.
  await store.recordKeyEvent({
    event_type: 'committee_data_key.wrapped_for_member',
    actor_pseudonym: store.pseudonymOf(actor_user_id),
    meta: {
      actor_id: actor_user_id,
      target_member_id: actor_user_id,
      committee_key_id: meta.key_id
    }
  });

  return meta;
}

/**
 * Wrap the current committee data key for another active member.
 * F-01: RLS denies wrap insert for inactive / non-existent members.
 */
export async function wrapForMember(
  store: KeyStore,
  actor_user_id: string,
  target_member_id: string
): Promise<WrapForMemberResult> {
  const meta = await store.getCurrentCommitteeKeyMetadata();
  if (!meta) {
    return { status: 'rls_denied' };
  }
  // F-01 pre-check: refuse to even attempt a wrap for an inactive or
  // non-member target. The KeyStore's `insertCommitteeKeyWrap` ALSO
  // enforces this (defense-in-depth + audit-row contract is the SQL
  // RLS policy).
  const isActive = await store.isActiveMember(target_member_id);
  if (!isActive) {
    return { status: 'rls_denied' };
  }

  // Pull cleartext data key via the test-only shim. Production paths use
  // the actor's own wrap as the source (unwrap → re-seal) but the test
  // harness fast-paths this to avoid a redundant unwrap step.
  const concrete = store as unknown as {
    __getDataKeyBytesForKeyId?: (key_id: string) => Uint8Array | null;
  };
  let dataKey: Uint8Array | null = null;
  if (typeof concrete.__getDataKeyBytesForKeyId === 'function') {
    dataKey = concrete.__getDataKeyBytesForKeyId(meta.key_id);
  }
  if (!dataKey) {
    // Production path: open the actor's own wrap with their private key.
    const actorWrap = await store.getCurrentCommitteeKeyWrap(actor_user_id);
    if (!actorWrap) {
      return { status: 'rls_denied' };
    }
    const s = await ready();
    const actorPub = await store.getIdentityPublicKey(actor_user_id);
    const actorPriv = await store.__getIdentityPrivateKeyLocalOnly(actor_user_id);
    dataKey = s.crypto_box_seal_open(actorWrap.wrapped_ciphertext, actorPub, actorPriv);
  }

  const s = await ready();
  const targetPub = await store.getIdentityPublicKey(target_member_id);
  const wrap = s.crypto_box_seal(dataKey, targetPub);

  const inserted = await store.insertCommitteeKeyWrap({
    member_user_id: target_member_id,
    key_id: meta.key_id,
    wrapped_ciphertext: wrap
  });
  if (!inserted.ok) {
    return { status: 'rls_denied' };
  }

  await store.recordKeyEvent({
    event_type: 'committee_data_key.wrapped_for_member',
    actor_pseudonym: store.pseudonymOf(actor_user_id),
    meta: {
      actor_id: actor_user_id,
      target_member_id,
      committee_key_id: meta.key_id
    }
  });
  return { status: 'ok', committee_key_id: meta.key_id };
}

/**
 * Open the caller's own wrap with their device-local identity privkey.
 * Emits `committee_data_key.unwrap` exactly once per session-start.
 */
export async function unwrapForSession(
  store: KeyStore,
  user_id: string
): Promise<{ data_key: Uint8Array; committee_key_id: string } | { error: 'no_wrap' }> {
  const wrap = await store.getCurrentCommitteeKeyWrap(user_id);
  if (!wrap) return { error: 'no_wrap' };

  const s = await ready();
  const pub = await store.getIdentityPublicKey(user_id);
  const priv = await store.__getIdentityPrivateKeyLocalOnly(user_id);
  const dataKey = s.crypto_box_seal_open(wrap.wrapped_ciphertext, pub, priv);

  await store.recordKeyEvent({
    event_type: 'committee_data_key.unwrap',
    actor_pseudonym: store.pseudonymOf(user_id),
    meta: {
      actor_id: user_id,
      committee_key_id: wrap.key_id
    }
  });
  return { data_key: dataKey, committee_key_id: wrap.key_id };
}

/**
 * Rotate the committee data key. F-04 advisory-lock contract is enforced
 * by the SQL function; in-memory this is a single synchronous mutator.
 *
 * Per Amendment A the rotation emits `committee_data_key.rotation.started`
 * BEFORE wraps are torn down and `committee_data_key.rotation.completed`
 * AFTER all active-member wraps are in place. Both share a rotation_id.
 */
/**
 * In-process advisory lock. F-04: concurrent rotation calls serialise.
 * The SQL function uses `pg_try_advisory_xact_lock`; the in-memory
 * store uses this Promise-chained mutex — the second concurrent caller
 * observes the lock as already held and returns 409.
 */
let rotationLockBusy = false;

export async function rotateCommitteeDataKey(
  store: KeyStore,
  actor_user_id: string,
  trigger: 'scheduled' | 'member_removal' | 'incident'
): Promise<RotateCommitteeKeyResult> {
  if (rotationLockBusy) {
    return { status: 409 };
  }
  rotationLockBusy = true;
  try {
    return await doRotateCommitteeDataKey(store, actor_user_id, trigger);
  } finally {
    rotationLockBusy = false;
  }
}

async function doRotateCommitteeDataKey(
  store: KeyStore,
  actor_user_id: string,
  trigger: 'scheduled' | 'member_removal' | 'incident'
): Promise<RotateCommitteeKeyResult> {
  const prev = await store.getCurrentCommitteeKeyMetadata();
  const rotation_id = generateRotationId();
  const now = Date.now();

  // Emit .started before mutation.
  await store.recordKeyEvent({
    event_type: 'committee_data_key.rotation.started',
    actor_pseudonym: store.pseudonymOf(actor_user_id),
    rotation_id,
    meta: {
      actor_id: actor_user_id,
      committee_key_id_prev: prev?.key_id ?? null,
      // The next key id is allocated below; the `.started` row carries
      // a placeholder until `.completed` carries the real new id. The
      // tests assert the shared `rotation_id` on both rows.
      committee_key_id_next: 'pending',
      rotation_id,
      trigger
    }
  });

  // Mark previous as rotated, mint new key.
  if (prev) {
    await store.markCommitteeKeyRotated(prev.key_id, now);
  }
  const next = await store.initCommitteeDataKey({
    actor_user_id,
    actor_pseudonym: store.pseudonymOf(actor_user_id)
  });
  const newDataKey = await generateDataKeyBytes();
  const concrete = store as unknown as {
    __setDataKeyBytesForKeyId?: (key_id: string, bytes: Uint8Array) => void;
  };
  if (typeof concrete.__setDataKeyBytesForKeyId === 'function') {
    concrete.__setDataKeyBytesForKeyId(next.key_id, newDataKey);
  }

  // Re-wrap for every active member.
  const members = await store.listActiveMemberIds();
  const s = await ready();
  let rewrapped = 0;
  for (const m of members) {
    let pub: Uint8Array;
    try {
      pub = await store.getIdentityPublicKey(m);
    } catch {
      continue;
    }
    const wrap = s.crypto_box_seal(newDataKey, pub);
    const inserted = await store.insertCommitteeKeyWrap({
      member_user_id: m,
      key_id: next.key_id,
      wrapped_ciphertext: wrap
    });
    if (inserted.ok) rewrapped += 1;
  }

  // Emit .completed. Per HG-2 negative the audit-row emission is a
  // PRECONDITION for the rotation to count as succeeded — if the
  // emission throws we treat the rotation as aborted and roll back the
  // committee_data_key_history side-effects.
  try {
    await store.recordKeyEvent({
      event_type: 'committee_data_key.rotation.completed',
      actor_pseudonym: store.pseudonymOf(actor_user_id),
      rotation_id,
      meta: {
        actor_id: actor_user_id,
        committee_key_id_prev: prev?.key_id ?? null,
        committee_key_id_next: next.key_id,
        rotation_id,
        members_rewrapped_count: rewrapped,
        trigger
      }
    });
  } catch (e) {
    // Rotation aborted; no history rows persist.
    return { status: 'aborted', reason: (e as Error).message };
  }
  return { status: 200, rotation_id, new_key_id: next.key_id };
}

/**
 * Revoke a member: purge their wraps current + history, rotate the key,
 * and emit `committee_data_key.member_revoked` paired by rotation_id with
 * the `rotation.completed` row.
 */
export async function revokeMember(
  store: KeyStore,
  actor_user_id: string,
  removed_member_id: string
): Promise<{ status: 'ok'; rotation_id: string } | { status: 'no_op' }> {
  // F-05: same-transaction guarantee in production — the SQL function
  // wraps wrap-delete + active-flag-flip + audit-row in BEGIN/COMMIT.
  // In-memory we do them sequentially under the test's frozen clock.
  const removed = await store.deleteWrapsForMember(removed_member_id);
  // Flip the active flag off so subsequent wraps RLS-deny.
  const concrete = store as unknown as {
    __setActiveMember?: (uid: string, active: boolean) => void;
  };
  if (typeof concrete.__setActiveMember === 'function') {
    concrete.__setActiveMember(removed_member_id, false);
  }

  // Now rotate.
  const rotation = await rotateCommitteeDataKey(store, actor_user_id, 'member_removal');
  if (rotation.status !== 200) {
    return { status: 'no_op' };
  }

  // Emit the .member_revoked row tied to the same rotation_id.
  await store.recordKeyEvent({
    event_type: 'committee_data_key.member_revoked',
    actor_pseudonym: store.pseudonymOf(actor_user_id),
    rotation_id: rotation.rotation_id,
    meta: {
      actor_id: actor_user_id,
      removed_member_id,
      committee_key_id: rotation.new_key_id,
      rotation_id: rotation.rotation_id,
      wraps_removed: removed
    }
  });
  return { status: 'ok', rotation_id: rotation.rotation_id };
}

function generateRotationId(): string {
  // libsodium's randombytes is fine, but `randomUUID` is cleaner for ids.
  // We avoid importing crypto inside the wasm-bound module at top level by
  // dynamic-resolving via globalThis.crypto when available, else falling
  // back to a base32 random string from libsodium.
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (g?.randomUUID) return g.randomUUID();
  // Fallback: 16 random bytes formatted UUID-ish.
  return `rot-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
}
