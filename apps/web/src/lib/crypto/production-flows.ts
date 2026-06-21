/**
 * Production composition layer — high-level onboarding/restore flows
 * routed through `SupabaseT07Client` + `BrowserLocalIdentityStore` +
 * libsodium (T07.1 / G-T07-2 follow-up).
 *
 * Three flows mirror the test-orchestrator entry points in `./index.ts`
 * (`enrollIdentityKeypair`, `storeRecoveryBlob`, `restoreFromRecoveryBlob`)
 * but route through the production client instead of `MemoryKeyStore`:
 *
 *   - enrollIdentityViaProduction:
 *       generate keypair → F-02 self-test → drive the sealed-box
 *       challenge (init → unseal → finalize); on success the public half
 *       lands in `identity_keys` server-side and the private half lands
 *       in IndexedDB device-side.
 *
 *   - storeRecoveryBlobViaProduction:
 *       read privkey from `localIdentity` → Argon2id-KDF +
 *       secretbox-seal under the passphrase → envelope as
 *       [salt][nonce][ciphertext] → POST via
 *       `client.storeRecoveryBlob`. F-08 floor enforced by
 *       `encryptRecoveryBlob`.
 *
 *   - restoreRecoveryBlobViaProduction:
 *       `client.getRecoveryBlob` (migration 0010, PR #33) → slice the
 *       envelope back → `decryptRecoveryBlob` under the passphrase → on
 *       success, persist the recovered privkey to `localIdentity` and
 *       POST `client.recordRecoveryBlobRestored` so the server-side
 *       audit-trail records the restore. The device-fingerprint hashing
 *       happens here (libsodium BLAKE2b-32) so the production callers
 *       just pass the raw fingerprint string and we forward only the
 *       hash.
 *
 * Every flow is wire-shaped: failures route through a discriminated
 * union return so UI callers can pattern-match on a single value.
 * Test surface: hermetic with a mock transport + a real
 * BrowserLocalIdentityStore (SSR-fallback Map) + real libsodium.
 */

import { decryptRecoveryBlob, encryptRecoveryBlob, KDF_PARAMS } from './recovery-blob';
import { generateIdentityKeypair, pubkeyFingerprint, selfTestKeypair } from './identity-keys';
import { ready } from './sodium';
import { SupabaseT07Client, type T07OpReason } from './supabase-t07-client';
import type { LocalIdentityStore } from './key-store';
import type { KdfParams } from './types';

// ---------------------------------------------------------------------------
// Enrollment (F-02 sealed-box challenge end-to-end)
// ---------------------------------------------------------------------------

export type EnrollProductionResult =
  | { status: 'ok'; user_id: string; public_key: Uint8Array; fingerprint: string }
  | { status: 'rejected'; reason: 'pairing_self_test_failed' }
  | { status: 'failed'; reason: T07OpReason; http: number };

/**
 * End-to-end production enrollment.
 *
 * 1. Generate identity keypair (libsodium `crypto_box_keypair` —
 *    Invariant 4: libsodium only; never `Math.random` etc.).
 * 2. F-02 client-side self-test (`selfTestKeypair`). On failure we
 *    REFUSE to touch the server (the keypair is internally inconsistent;
 *    no audit row should land for a doomed enrollment).
 * 3. Drive the sealed-box challenge through `client.enrollIdentityViaChallenge`,
 *    supplying a libsodium `crypto_box_seal_open` callback. The client
 *    persists the privkey to `localIdentity` only after the server
 *    accepts the unsealed nonce.
 */
export async function enrollIdentityViaProduction(opts: {
  client: SupabaseT07Client;
  user_id: string;
}): Promise<EnrollProductionResult> {
  const kp = await generateIdentityKeypair();
  const passes = await selfTestKeypair(kp);
  if (!passes) return { status: 'rejected', reason: 'pairing_self_test_failed' };
  const fp = await pubkeyFingerprint(kp.public_key);

  const r = await opts.client.enrollIdentityViaChallenge({
    user_id: opts.user_id,
    public_key: kp.public_key,
    private_key: kp.private_key,
    pubkey_fingerprint: fp,
    unsealNonce: async (sealed, pk, sk) => {
      const s = await ready();
      return s.crypto_box_seal_open(sealed, pk, sk);
    }
  });
  if (!r.ok) return { status: 'failed', reason: r.reason, http: r.status };
  return { status: 'ok', user_id: r.user_id, public_key: kp.public_key, fingerprint: fp };
}

// ---------------------------------------------------------------------------
// Recovery blob — store (write the sealed envelope)
// ---------------------------------------------------------------------------

export type StoreRecoveryProductionResult =
  | { status: 'ok'; kdf_params: KdfParams }
  | { status: 'failed'; reason: T07OpReason; http: number };

/**
 * Read the privkey from the device-local store, encrypt it under the
 * passphrase, and post the envelope. The on-wire format is
 * `[salt(16)][nonce(24)][ciphertext]` — matching the slice arithmetic in
 * the restore flow below.
 */
export async function storeRecoveryBlobViaProduction(opts: {
  client: SupabaseT07Client;
  localIdentity: LocalIdentityStore;
  user_id: string;
  passphrase: string;
}): Promise<StoreRecoveryProductionResult> {
  const priv = await opts.localIdentity.getIdentityPrivateKey(opts.user_id);
  const blob = await encryptRecoveryBlob(priv, opts.passphrase);
  const envelope = new Uint8Array(blob.salt.length + blob.nonce.length + blob.ciphertext.length);
  envelope.set(blob.salt, 0);
  envelope.set(blob.nonce, blob.salt.length);
  envelope.set(blob.ciphertext, blob.salt.length + blob.nonce.length);

  const r = await opts.client.storeRecoveryBlob({
    blob_ciphertext: envelope,
    kdf_params: blob.kdf_params as unknown as Record<string, unknown>
  });
  if (!r.ok) return { status: 'failed', reason: r.reason, http: r.status };
  return { status: 'ok', kdf_params: blob.kdf_params };
}

// ---------------------------------------------------------------------------
// Recovery blob — restore (decrypt on a new device + audit)
// ---------------------------------------------------------------------------

export type RestoreRecoveryProductionResult =
  | {
      status: 'ok';
      public_key: Uint8Array;
      private_key: Uint8Array;
    }
  | { status: 'not_found' }
  | { status: 'wrong_passphrase' }
  | { status: 'failed'; reason: T07OpReason; http: number };

/**
 * Restore an identity from a server-stored recovery blob.
 *
 * 1. `client.getRecoveryBlob()` — structurally self-only (migration 0010).
 *    Null → `{ status: 'not_found' }`.
 * 2. Slice the envelope into `{ salt, nonce, ciphertext }`.
 * 3. `decryptRecoveryBlob` under the passphrase.
 *    Null → `{ status: 'wrong_passphrase' }`.
 * 4. On success: persist the recovered privkey to `localIdentity`,
 *    BLAKE2b-hash the device-fingerprint argument, post
 *    `client.recordRecoveryBlobRestored` so the audit row lands with
 *    a hashed device fingerprint (Amendment A: no raw UA).
 */
export async function restoreRecoveryBlobViaProduction(opts: {
  client: SupabaseT07Client;
  localIdentity: LocalIdentityStore;
  user_id: string;
  passphrase: string;
  device_fingerprint_raw: string;
}): Promise<RestoreRecoveryProductionResult> {
  const fetched = await opts.client.getRecoveryBlob();
  if (!fetched.ok) {
    return { status: 'failed', reason: fetched.reason, http: fetched.status };
  }
  if (!fetched.data) return { status: 'not_found' };

  const envelope = fetched.data.blob_ciphertext;
  const SALT = 16;
  const NONCE = 24;
  if (envelope.length < SALT + NONCE + 1) {
    // Envelope shape violation — treat as not_found so the UI surfaces a
    // useful "no recovery blob" path instead of a stack trace.
    return { status: 'not_found' };
  }
  const recovered = await decryptRecoveryBlob(
    {
      salt: envelope.slice(0, SALT),
      nonce: envelope.slice(SALT, SALT + NONCE),
      ciphertext: envelope.slice(SALT + NONCE),
      kdf_params: fetched.data.kdf_params as unknown as KdfParams
    },
    opts.passphrase
  );
  if (!recovered) return { status: 'wrong_passphrase' };

  // Persist the recovered privkey to the device-local store BEFORE
  // posting the restore audit row — so the audit row only fires when the
  // on-device state is consistent with the server-side claim.
  await opts.localIdentity.storeIdentityPrivateKey(opts.user_id, recovered.private_key);

  const s = await ready();
  const fpBytes = s.crypto_generichash(
    32,
    new Uint8Array(Buffer.from(opts.device_fingerprint_raw, 'utf8'))
  );
  const fpHex = s.to_hex(fpBytes);

  const audit = await opts.client.recordRecoveryBlobRestored({
    device_fingerprint_hashed: fpHex
  });
  if (!audit.ok) {
    return { status: 'failed', reason: audit.reason, http: audit.status };
  }

  return {
    status: 'ok',
    public_key: recovered.public_key,
    private_key: recovered.private_key
  };
}

// ---------------------------------------------------------------------------
// Committee data key — init + self-wrap (ADR-0026 Decision 2 + Amendment A)
// ---------------------------------------------------------------------------

export type InitCommitteeKeyProductionResult =
  | { status: 'ok'; key_id: string; epoch: number }
  // The live key already carries a confirmed actor wrap — nothing to do
  // (resume success-equivalent; AC-4 / AC-5d).
  | { status: 'already_initialised' }
  // Edge-A sub-case (a): a live key exists, some OTHER member holds a wrap,
  // the actor does not — and the actor holds no key material to self-wrap.
  // Recoverable: another key-holder must grant access, or the actor restores
  // their own prior access (Amendment A Ruling 2; AC-5c).
  | { status: 'foreign_held'; key_id: string }
  | { status: 'failed'; reason: T07OpReason; http: number };

/**
 * The one net-new production composition function (ADR-0026 Decision 2,
 * corrected by Amendment A). Composes `SupabaseT07Client.initCommitteeDataKey`
 * / `wrapCommitteeDataKeyForMember` / `rotateCommitteeDataKey` /
 * `finalizeCommitteeDataKeyRotation` + the client-side data-key generation +
 * seal-to-pubkey that `committee-key.ts:initCommitteeDataKey` does against the
 * test-only `KeyStore`. Unlike that test-only path this one ZEROIZES the
 * plaintext data key before returning (F-132 / AC-8 — the test path omits it)
 * and delegates audit emission to the SECURITY DEFINER SQL (Amendment A
 * single-emission-path).
 *
 * Resume semantics (Amendment A — branch on WRAP COUNT, never actor-wrap
 * presence):
 *  - probe the live (`rotated_at IS NULL`) key FIRST (a pure read):
 *      • no live key            → fresh init (generate → wrap under new key).
 *      • live key, actor wrapped → `already_initialised` (confirmed actor wrap;
 *                                  never reported "done" without one — AC-5d).
 *      • live key, zero wraps    → TRUE edge-A: rotate('incident') retires the
 *                                  dead key, then init-equivalent under the
 *                                  fresh key_id; finalize the rotation (AC-5b).
 *      • live key, foreign-held  → `foreign_held` recoverable error; no init,
 *                                  no rotate, no self-wrap (AC-5c).
 *
 * The plaintext 32-byte data key exists ONLY in this function's local scope,
 * crosses no trust boundary in cleartext, and is `.fill(0)`-zeroized on every
 * exit path that generated one.
 *
 * `actor_public_key` is passed in (not re-fetched) — the orchestrator already
 * holds the freshly-enrolled pubkey from the enroll step. The sealed-box wrap
 * needs only the recipient PUBLIC key, so no privkey read happens here;
 * `localIdentity` is threaded for symmetry with the sibling flows.
 */
export async function initCommitteeDataKeyViaProduction(opts: {
  client: SupabaseT07Client;
  localIdentity: LocalIdentityStore;
  user_id: string;
  actor_public_key: Uint8Array;
}): Promise<InitCommitteeKeyProductionResult> {
  // 0. F-138 / AC-5d load-bearing invariant: a non-32-byte actor pubkey can
  //    NEVER create a server-side key it cannot wrap. libsodium's
  //    `crypto_box_seal` rejects any recipient key whose length !== 32, and it
  //    does so only AFTER we'd already minted (init_key) or rotated a live key
  //    — leaving a permanent zero-wrap dead key + an unrecoverable retry loop.
  //    Validate the pubkey BEFORE any state-mutating RPC (or even the probe):
  //    return the wire-shaped failure, never throw, never call init_key/rotate.
  if (opts.actor_public_key.length !== 32) {
    return { status: 'failed', reason: 'invalid_input', http: 422 };
  }

  // 1. Probe the live key state FIRST. The wrap COUNT is the discriminator
  //    the resume branch needs (Amendment A Ruling 1); a failed probe (401 /
  //    403) is surfaced verbatim so the card can split session-required from
  //    rls-denied (AC-6 / F-130).
  const probe = await opts.client.getCommitteeKeyState({ actor_user_id: opts.user_id });
  if (!probe.ok) return { status: 'failed', reason: probe.reason, http: probe.status };

  if (probe.data) {
    // A live key already exists — resume branch.
    if (probe.data.actor_has_wrap) {
      // AC-4 / AC-5d: confirmed actor wrap under the current (non-retired)
      // key — success-equivalent. No data key minted, no rotation.
      return { status: 'already_initialised' };
    }
    if (probe.data.wrap_count > 0) {
      // AC-5c: foreign-held. The actor holds no plaintext key to self-wrap.
      // Explicit recoverable error — never init/rotate/self-wrap, never a
      // silent "done".
      return { status: 'foreign_held', key_id: probe.data.key_id };
    }
    // AC-5b — TRUE edge-A: zero wraps for ANY member. The dead key's bytes
    // are irretrievably lost (process died between init_key and the first
    // wrap). Retire it via rotation and re-init under the fresh key_id; never
    // wrap_member against the dead key_id (no divergent key under a stale id).
    return repairZeroWrapKey({ ...opts, dead_epoch: probe.data.epoch });
  }

  // 2. No live key — fresh init.
  return freshInit(opts);
}

/**
 * Fresh-init path (AC-2 / AC-5a): mint the metadata via `init_key`, generate a
 * 32-byte data key client-side, seal it to the actor's pubkey, persist the
 * self-wrap, then zeroize. A concurrent init that already landed surfaces as
 * `already_initialised` (P0001) — mapped to the resume success-equivalent.
 */
async function freshInit(opts: {
  client: SupabaseT07Client;
  user_id: string;
  actor_public_key: Uint8Array;
}): Promise<InitCommitteeKeyProductionResult> {
  // F-138 / AC-5d defense-in-depth: never call init_key toward a wrap we cannot
  // perform. A non-32-byte pubkey would make `crypto_box_seal` throw AFTER
  // init_key already minted a live key — the exact zero-wrap dead key F-138
  // forbids. Validate BEFORE init_key. (The public entry point guards too; this
  // keeps the invariant local to every state-mutating path.)
  if (opts.actor_public_key.length !== 32) {
    return { status: 'failed', reason: 'invalid_input', http: 422 };
  }

  const init = await opts.client.initCommitteeDataKey();
  if (!init.ok) {
    // A racing init that already initialised the key maps to the resume
    // success-equivalent; everything else (401 / 403 / 422 …) is a failure.
    if (init.reason === 'already_initialised') return { status: 'already_initialised' };
    return { status: 'failed', reason: init.reason, http: init.status };
  }

  const s = await ready();
  const dataKey = s.randombytes_buf(s.crypto_secretbox_KEYBYTES);
  try {
    const wrap = s.crypto_box_seal(dataKey, opts.actor_public_key);
    const wrapped = await opts.client.wrapCommitteeDataKeyForMember({
      member_user_id: opts.user_id,
      key_id: init.data.key_id,
      wrapped_ciphertext: wrap,
      rotation_id: null
    });
    if (!wrapped.ok) {
      // F-138 edge-A mitigation at the source: `init_key` minted a key but the
      // self-wrap failed, so we are ONE step from leaving a zero-wrap dead key
      // (the exact F-138 hazard). When the failure is NOT an auth failure
      // (a 401/403 means the session/permission is gone — a follow-on retire
      // would be denied too, and the resume path repairs it), proactively
      // retire the stillborn key so no silent zero-wrap key is left behind.
      // Best-effort: if the retire itself fails we still surface the original
      // wrap failure (the resume path's wrap-count probe is the backstop).
      if (wrapped.status !== 401 && wrapped.status !== 403) {
        try {
          await opts.client.rotateCommitteeDataKey({ trigger: 'incident' });
        } catch {
          // Swallow — the original failure below is the user-facing outcome;
          // the resume probe (Amendment A Ruling 1) is the durable backstop.
        }
      }
      return { status: 'failed', reason: wrapped.reason, http: wrapped.status };
    }
    return { status: 'ok', key_id: init.data.key_id, epoch: init.data.epoch };
  } finally {
    // F-132 / AC-8: the plaintext data key must not linger for GC.
    dataKey.fill(0);
  }
}

/**
 * Edge-A repair (AC-5b / Amendment A Ruling 3): the live key has zero wraps,
 * so its bytes are unrecoverable. Retire it via `rotate('incident')`, generate
 * a FRESH 32-byte key, self-wrap under the NEW key_id, and finalize the
 * rotation. Confirmation that abandoning the dead key loses nothing: in the
 * Phase-0a ceremony no committee data can ever be sealed under a not-yet-
 * wrapped key (Ruling 3's load-bearing invariant), so a zero-wrap key has zero
 * ciphertext beneath it.
 */
async function repairZeroWrapKey(opts: {
  client: SupabaseT07Client;
  user_id: string;
  actor_public_key: Uint8Array;
  dead_epoch: number;
}): Promise<InitCommitteeKeyProductionResult> {
  // F-138 / AC-5d defense-in-depth: never rotate (a state-mutating RPC) toward
  // a wrap we cannot perform. A non-32-byte pubkey would make `crypto_box_seal`
  // throw AFTER the rotate already retired the dead key and minted a new one —
  // a fresh zero-wrap key. Validate BEFORE rotate so the repair can never
  // compound the very condition it exists to clear. (The public entry point
  // guards too; this keeps the invariant local to this state-mutating path.)
  if (opts.actor_public_key.length !== 32) {
    return { status: 'failed', reason: 'invalid_input', http: 422 };
  }

  // 'incident' is the closest honest trigger value (Amendment A's trigger-gap
  // note); a dedicated 'stillborn_init' value is explicitly out of scope.
  const rotation = await opts.client.rotateCommitteeDataKey({ trigger: 'incident' });
  if (!rotation.ok) return { status: 'failed', reason: rotation.reason, http: rotation.status };

  const s = await ready();
  const dataKey = s.randombytes_buf(s.crypto_secretbox_KEYBYTES);
  try {
    const wrap = s.crypto_box_seal(dataKey, opts.actor_public_key);
    const wrapped = await opts.client.wrapCommitteeDataKeyForMember({
      member_user_id: opts.user_id,
      key_id: rotation.data.new_key_id,
      wrapped_ciphertext: wrap,
      rotation_id: rotation.data.rotation_id
    });
    if (!wrapped.ok) return { status: 'failed', reason: wrapped.reason, http: wrapped.status };

    const finalized = await opts.client.finalizeCommitteeDataKeyRotation({
      rotation_id: rotation.data.rotation_id,
      new_key_id: rotation.data.new_key_id,
      members_rewrapped_count: 1
    });
    if (!finalized.ok)
      return { status: 'failed', reason: finalized.reason, http: finalized.status };

    // `rotate_committee_data_key` mints the new key at dead_epoch + 1 (the
    // SQL allocates epoch = max(epoch)+1, and the dead key was the max). The
    // epoch is metadata only (F-135); the card round-trips via the wrap.
    return { status: 'ok', key_id: rotation.data.new_key_id, epoch: opts.dead_epoch + 1 };
  } finally {
    // F-132 / AC-8: zeroize the fresh plaintext key on every exit.
    dataKey.fill(0);
  }
}

// Re-export the KDF_PARAMS so callers can label persisted blobs without
// importing from `./recovery-blob` directly.
export { KDF_PARAMS };
