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
 *     UTF-8 encoded via `Buffer.from(plaintext, 'utf8')` (the jsdom-bridge
 *     workaround documented in concern-core:60-62).
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

import { ready } from '../crypto/sodium';

/**
 * libsodium secretbox MAC overhead — 16 bytes. The constant is part of the
 * NaCl/libsodium spec (`crypto_secretbox_MACBYTES === 16`) and is fixed for
 * the lifetime of the library. Duplicated from concern-core because the
 * project's `libsodium-wrappers.d.ts` does not currently expose the constant
 * as a value the TypeScript surface can read.
 */
const SECRETBOX_MAC_LEN = 16;

export async function sealUtf8(plaintext: string, key: Uint8Array): Promise<Uint8Array> {
  const s = await ready();
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  // jsdom's TextEncoder output sometimes fails the wasm bridge's strict
  // typeof check; Buffer is a Uint8Array subclass that bridges cleanly.
  const ptBytes = new Uint8Array(Buffer.from(plaintext, 'utf8'));
  const ct = s.crypto_secretbox_easy(ptBytes, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
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
  return Buffer.from(pt).toString('utf8');
}
