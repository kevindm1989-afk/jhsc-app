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

// Re-export the KDF_PARAMS so callers can label persisted blobs without
// importing from `./recovery-blob` directly.
export { KDF_PARAMS };
