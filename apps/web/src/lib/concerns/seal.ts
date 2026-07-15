/**
 * Concern seal/open primitives (ADR-0027 Decision 3 / P2a-5).
 *
 * Extracted from `concern-core.ts` (previously file-private at :56-89) so the
 * production compositions (`submitConcernViaProduction` /
 * `listConcernsViaProduction` / `revealConcernSourceViaProduction`) and the
 * test-shaped `concern-core` operations can share ONE seal implementation
 * (rule of three: test core + production compositions are the second and
 * third consumers).
 *
 * Contract (carried forward verbatim from concern-core's file-private
 * helpers):
 *   - `sealUtf8(plaintext, key)` → `[nonce(24)][crypto_secretbox_easy ct]`.
 *     Each call uses a FRESH random nonce; two seals of the same plaintext
 *     under the same key produce different ciphertexts. The plaintext is
 *     UTF-8 encoded via `new Uint8Array(new TextEncoder().encode(plaintext))`.
 *     The outer `new Uint8Array(...)` re-wrap is load-bearing: it normalises
 *     the encoder output into the runtime's own Uint8Array constructor so the
 *     libsodium wasm bridge's strict cross-realm typeof check accepts it under
 *     jsdom (the workaround formerly documented in concern-core:60-62).
 *     TextEncoder is browser-native (a global in browsers, Node 11+, jsdom,
 *     and Deno); `Buffer` is NOT defined in the Vite browser bundle, so the
 *     prior `Buffer.from(...)` form threw a ReferenceError in-browser.
 *   - `openUtf8(ciphertext, key)` → UTF-8 plaintext. AEAD verification
 *     failures (wrong key / tampered ct / too-short input) THROW a libsodium
 *     error — never a silent mis-decrypt (F-147 carry-forward). Callers in
 *     the production compositions catch and surface a typed failure so the
 *     thrown libsodium error never propagates with buffer bytes in its
 *     message/stack (F-148).
 *
 * libsodium-only (ADR-0003 Invariant 4). Never logs key material or
 * plaintext (F-148).
 */

import { ready, type Sodium } from '../crypto/sodium';

/**
 * libsodium secretbox MAC overhead — 16 bytes. The constant is part of the
 * NaCl/libsodium spec (`crypto_secretbox_MACBYTES === 16`) and is fixed for
 * the lifetime of the library. Duplicated from concern-core because the
 * project's `libsodium-wrappers.d.ts` does not currently expose the constant
 * as a value the TypeScript surface can read.
 */
const SECRETBOX_MAC_LEN = 16;

/**
 * SYNCHRONOUS secretbox seal over an ALREADY-ready libsodium instance `s`.
 *
 * F-190 / re-pass trigger #13: the async `sealUtf8` below does `await ready()`
 * BEFORE the synchronous `crypto_secretbox_easy`, and that internal `await` is a
 * TOCTOU window — a mid-`await` wipe / rotation-observing `populate()` can zero
 * the captured data-key buffer BY REFERENCE, so the resuming secretbox seals
 * under an all-zero key (world-readable). Seal paths must resolve `ready()` ONCE
 * up front, re-check liveness, RE-READ `getDataKey()`, then call THIS variant
 * with NO `await` between the re-read and the primitive — because
 * `crypto_secretbox_easy` is synchronous, that block is atomic and no
 * wipe/populate can interleave. Byte format is IDENTICAL to `sealUtf8`:
 * `[nonce(24)][crypto_secretbox_easy ct]` with a FRESH random nonce per call.
 */
export function sealUtf8Sync(plaintext: string, key: Uint8Array, s: Sodium): Uint8Array {
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  // Re-wrap the encoder output in a fresh `new Uint8Array(...)`: jsdom's
  // TextEncoder output sometimes fails the wasm bridge's strict cross-realm
  // typeof check, and the re-wrap normalises it into the runtime's own
  // Uint8Array constructor so the bridge accepts it. (Browser-native:
  // TextEncoder is a global in browsers, Node 11+, jsdom, and Deno —
  // unlike `Buffer`, which is undefined in the Vite browser bundle.)
  const ptBytes = new Uint8Array(new TextEncoder().encode(plaintext));
  const ct = s.crypto_secretbox_easy(ptBytes, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

export async function sealUtf8(plaintext: string, key: Uint8Array): Promise<Uint8Array> {
  const s = await ready();
  return sealUtf8Sync(plaintext, key, s);
}

export async function openUtf8(ciphertext: Uint8Array, key: Uint8Array): Promise<string> {
  const s = await ready();
  const nonceLen = s.crypto_secretbox_NONCEBYTES;
  if (ciphertext.length < nonceLen + SECRETBOX_MAC_LEN) {
    throw new Error('concerns/seal: ciphertext too short to contain nonce + MAC');
  }
  const nonce = ciphertext.slice(0, nonceLen);
  const ct = ciphertext.slice(nonceLen);
  const pt = s.crypto_secretbox_open_easy(ct, nonce, key);
  return new TextDecoder().decode(pt);
}
