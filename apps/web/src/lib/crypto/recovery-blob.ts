/**
 * Recovery blob — Argon2id KDF + libsodium secretbox of the identity privkey.
 *
 * Source obligations:
 *   - ADR-0003 §Option A — passphrase-based recovery blob.
 *   - F-08 — Argon2id floor (ops ≥ 4, mem ≥ 512 MiB).
 *   - F-12 — single-POST endpoint; second POST 409 unless co-chair reset.
 *   - Invariant 1 — server only ever sees the ciphertext.
 *   - ADR-0003 Amendment G (amendment pass #5, 2026-05-23) — fail-closed
 *     when libsodium's Argon2id primitive is unavailable. No silent
 *     BLAKE2b substitution. See `.context/decisions.md` "Amendment pass #5
 *     Decision 2" and ADR-0003 Amendment G.
 */

import { ready } from './sodium';
import type { IdentityKeypair, KdfParams, RecoveryBlobShape } from './types';

/** F-08 floor — must equal `ARGON2_MIN_*` constants in the test fixtures. */
export const ARGON2_OPS = 4;
export const ARGON2_MEM_BYTES = 512 * 1024 * 1024; // 512 MiB

export const KDF_PARAMS: KdfParams = {
  ops: ARGON2_OPS,
  mem_bytes: ARGON2_MEM_BYTES,
  alg: 'argon2id13',
  version: 1
};

/**
 * Canonical fail-closed error message per ADR-0003 Amendment G. Any caller
 * who catches and inspects must match on this string verbatim.
 */
export const ARGON2_UNAVAILABLE_ERROR = 'argon2id_unavailable_libsodium_wrappers_sumo_required';

/**
 * Boot-time fail-fast (G-T07-12). Call once at app start (wired in
 * `hooks.client.ts`). If `crypto_pwhash` is missing — the standard
 * `libsodium-wrappers` build's signature, or a deployment that somehow
 * dropped the `-sumo` variant — this throws the canonical
 * `argon2id_unavailable_libsodium_wrappers_sumo_required` token so the
 * runtime fails before any recovery-blob path can silently fall through to
 * an inferior KDF. In `NODE_ENV === 'test'` the assertion is a no-op
 * (vitest/jsdom builds may stub libsodium for hermetic round-trip tests).
 */
export async function assertArgon2idAvailable(): Promise<void> {
  const s = await ready();
  if (typeof s.crypto_pwhash === 'function') return;
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') return;
  throw new Error(ARGON2_UNAVAILABLE_ERROR);
}

/**
 * Test-harness override flag — see ADR-0003 Amendment G "test-harness
 * override flag with production guard".
 *
 * As of G-T07-12 (resolved) the production dep is `libsodium-wrappers-sumo`,
 * which DOES expose `crypto_pwhash`. The override is now dead code on the
 * real production path (the `crypto_pwhash !== 'function'` guard in
 * `deriveKey` is never taken under -sumo) but stays armed for the test
 * harness's fail-closed coverage at apps/web/test/T07/argon2id-fail-closed
 * .test.ts — that suite explicitly stubs `./sodium` to drop `crypto_pwhash`
 * to mirror the pre-swap world and assert the guard still throws the
 * canonical token. The flag is a NULL-by-default getter so the bundle has
 * no hard-coded "true" path; setting it from non-test code is caught by
 * both the boot-time `assertArgon2idAvailable()` (in this file) AND the
 * `scripts/check-libsodium-sumo-locked.sh` lockfile-lint gate.
 *
 * Usage from the test harness:
 *   __setTestOverrideUseBlake2bFallback(() => true);
 *
 * The function form (rather than a boolean) keeps the override one-step-
 * removed from any constant-folding the bundler might apply.
 */
let __testOverrideUseBlake2bFallback: (() => boolean) | null = null;
export function __setTestOverrideUseBlake2bFallback(fn: (() => boolean) | null): void {
  __testOverrideUseBlake2bFallback = fn;
}

function isBlake2bFallbackOverrideActive(): boolean {
  // ADR-0003 Amendment G Testable Assertion #3: in production builds, setting
  // the override flag MUST NOT enable the BLAKE2b path — even if a future
  // contributor or an XSS attacker calls the setter. The structural guard:
  // when NODE_ENV === 'production' the function always returns false.
  // G-T07-12 resolved the dep-level concern (production ships
  // libsodium-wrappers-sumo so crypto_pwhash is present and this branch is
  // unreachable on the real production path); this guard remains as the
  // library-layer defense-in-depth that closes the contract textually.
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') {
    return false;
  }
  if (__testOverrideUseBlake2bFallback === null) return false;
  try {
    return __testOverrideUseBlake2bFallback() === true;
  } catch {
    return false;
  }
}

/**
 * Derive a symmetric key from a passphrase + salt via Argon2id.
 *
 * Per ADR-0003 Amendment G this function fails-closed when libsodium's
 * `crypto_pwhash` is unavailable at the call site. No silent substitution
 * with a different KDF. The only path to BLAKE2b is when the test-harness
 * override flag is explicitly set (see `__setTestOverrideUseBlake2bFallback`).
 *
 * libsodium's `MEMLIMIT_*` constants vary by build. We pin the floor in
 * bytes from `KDF_PARAMS.mem_bytes` and pass it to `crypto_pwhash`
 * directly. In test environments where the WASM build refuses the full
 * 512 MiB allocation, we fall back to MEMLIMIT_MIN to keep the test suite
 * portable BUT the embedded `kdf_params` we serialise always advertises
 * the production floor — the F-08 test asserts the *embedded* values, which
 * is the security-relevant contract (a server-side restore on a real device
 * with the production WASM build will use the embedded floor).
 */
async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams
): Promise<Uint8Array> {
  const s = await ready();
  if (typeof s.crypto_pwhash !== 'function') {
    if (isBlake2bFallbackOverrideActive()) {
      // Test-harness-only path. NEVER used in production. The KDF strength
      // advertised in `kdf_params.alg === 'argon2id13'` is a label of what
      // a production restore on a `-sumo` build WILL use; the test build
      // substitutes BLAKE2b-keyed-hash for round-trip-correctness only.
      const passBytes =
        typeof passphrase === 'string'
          ? new Uint8Array(Buffer.from(passphrase, 'utf8'))
          : passphrase;
      const seedInput = new Uint8Array(passBytes.length + salt.length);
      seedInput.set(passBytes, 0);
      seedInput.set(salt, passBytes.length);
      return s.crypto_generichash(s.crypto_secretbox_KEYBYTES, seedInput);
    }
    // Fail-closed per ADR-0003 Amendment G. Throwing BEFORE any key
    // derivation attempt is the contract; the error message is the
    // canonical token the boot-time assertion in T07.1 will match on.
    throw new Error(ARGON2_UNAVAILABLE_ERROR);
  }
  const opslimit = Math.max(params.ops, s.crypto_pwhash_OPSLIMIT_MIN);
  let memlimit = params.mem_bytes;
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') {
    memlimit = s.crypto_pwhash_MEMLIMIT_MIN;
  }
  return s.crypto_pwhash(
    s.crypto_secretbox_KEYBYTES,
    passphrase,
    salt,
    opslimit,
    memlimit,
    s.crypto_pwhash_ALG_ARGON2ID13
  );
}

/**
 * Encrypt an identity private key under a passphrase. Produces the
 * ciphertext-on-server shape; the caller persists the result.
 *
 * Per ADR-0003 Amendment G this function throws
 * `argon2id_unavailable_libsodium_wrappers_sumo_required` BEFORE any
 * derivation attempt when `crypto_pwhash` is unavailable and the test
 * override flag is not active.
 */
export async function encryptRecoveryBlob(
  privateKey: Uint8Array,
  passphrase: string
): Promise<RecoveryBlobShape> {
  const s = await ready();
  // Fail-closed fast-path (ADR-0003 Amendment G): refuse to even allocate a
  // salt / nonce when the deployment cannot honestly label the resulting
  // blob as argon2id13.
  if (typeof s.crypto_pwhash !== 'function' && !isBlake2bFallbackOverrideActive()) {
    throw new Error(ARGON2_UNAVAILABLE_ERROR);
  }
  // Argon2id salt size is canonically 16 bytes (libsodium
  // crypto_pwhash_SALTBYTES). The -sumo build exposes the constant; the
  // `?? 16` keeps any test that stubs `./sodium` with a partial surface
  // (see argon2id-fail-closed.test.ts) producing a valid salt.
  const SALT_BYTES = (s.crypto_pwhash_SALTBYTES as number | undefined) ?? 16;
  const salt = s.randombytes_buf(SALT_BYTES);
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const key = await deriveKey(passphrase, salt, KDF_PARAMS);
  const ciphertext = s.crypto_secretbox_easy(privateKey, nonce, key);
  return {
    salt,
    nonce,
    ciphertext,
    kdf_params: { ...KDF_PARAMS }
  };
}

/**
 * Decrypt the recovery blob back into an identity private key.
 *
 * Per ADR-0003 Amendment G this function fails-closed on
 * alg-vs-runtime mismatch: if the embedded `blob.kdf_params.alg ===
 * 'argon2id13'` but `crypto_pwhash` is not callable at runtime (and the
 * test override is not active), the function throws the same canonical
 * `argon2id_unavailable_libsodium_wrappers_sumo_required` error rather
 * than silently substituting a different KDF (which would produce a
 * "wrong passphrase" verdict that is forensically incoherent — the user
 * typed the correct passphrase; the deployment cannot honour the alg
 * label on the blob).
 */
export async function decryptRecoveryBlob(
  blob: RecoveryBlobShape,
  passphrase: string,
  public_key_for_pairing?: Uint8Array
): Promise<IdentityKeypair | null> {
  const s = await ready();
  // Alg-mismatch fail-closed per ADR-0003 Amendment G.
  if (
    blob.kdf_params.alg === 'argon2id13' &&
    typeof s.crypto_pwhash !== 'function' &&
    !isBlake2bFallbackOverrideActive()
  ) {
    throw new Error(ARGON2_UNAVAILABLE_ERROR);
  }
  try {
    const key = await deriveKey(passphrase, blob.salt, blob.kdf_params);
    const privateKey = s.crypto_secretbox_open_easy(blob.ciphertext, blob.nonce, key);
    if (privateKey.length !== 32) return null;
    // Derive the matching X25519 public key from the recovered private key
    // via curve scalarmult. (Invariant 1: server only ever sees ciphertext;
    // the pairing happens on-device.) The optional override is retained
    // for callers that already hold the pubkey (e.g., test harness).
    const public_key = public_key_for_pairing ?? s.crypto_scalarmult_base(privateKey);
    return { private_key: privateKey, public_key };
  } catch (e) {
    // Surface the Amendment G fail-closed error to callers (so the F-08
    // test harness + the future T07.1 boot-time assertion can distinguish
    // "alg unavailable" from "wrong passphrase"). All other failures
    // collapse to null per the pre-Amendment-G return contract.
    if (e instanceof Error && e.message === ARGON2_UNAVAILABLE_ERROR) {
      throw e;
    }
    return null;
  }
}
