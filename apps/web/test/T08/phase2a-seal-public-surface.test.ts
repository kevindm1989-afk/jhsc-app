/**
 * Phase 2a PR2 / P2a-5 — `sealUtf8` / `openUtf8` extraction + public export
 * (ADR-0027 Decision 3 rule-of-three: test core + production compositions are
 * the 2nd and 3rd consumers of the seal primitives, so they must leave
 * file-private scope).
 *
 * RED-FIRST (TDD). Today `sealUtf8` / `openUtf8` are FILE-PRIVATE inside
 * `apps/web/src/lib/concerns/concern-core.ts:56-89`. The implementer extracts
 * them to a sibling `apps/web/src/lib/concerns/seal.ts` (per the ADR's
 * extraction note) and re-exports the surface from `$lib/concerns/index.ts`
 * so the three production compositions can import them. This file asserts the
 * public surface and round-trip correctness; the implementer treats it as
 * READ-ONLY.
 *
 * TEST → AC / FINDING MAP
 *   P2a-5 / Decision 3 — sealUtf8 + openUtf8 importable from `$lib/concerns`
 *                        (and also from the deeper `$lib/concerns/seal` path).
 *   P2a-5             — round-trip byte/utf-8 fidelity under a real libsodium
 *                       secretbox key (the contract concern-core today encodes).
 *   F-147 (carry-forward) — a corrupted ciphertext throws a TYPED libsodium
 *                       failure, never a silent mis-decrypt.
 *
 * Hermetic: real libsodium; no transport; no clock.
 */

import { describe, expect, it } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
// RED-FIRST: these imports do not resolve yet — the implementer adds the
// extraction + re-exports. Importing them here pins the public name + path.
import { sealUtf8, openUtf8 } from '../../src/lib/concerns';
import * as sealModule from '../../src/lib/concerns/seal';

await _sodium.ready;
const sodium = _sodium;

function freshKey(): Uint8Array {
  return sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
}

describe('Phase 2a PR2 — sealUtf8 / openUtf8 public surface (P2a-5)', () => {
  it('both helpers are exported from the concerns library index (importable for the production compositions)', () => {
    expect(typeof sealUtf8).toBe('function');
    expect(typeof openUtf8).toBe('function');
  });

  it('the helpers are ALSO importable from the deeper `$lib/concerns/seal` module (the extraction site per Decision 3)', () => {
    expect(typeof sealModule.sealUtf8).toBe('function');
    expect(typeof sealModule.openUtf8).toBe('function');
    // Same function identities — the index re-exports the seal module's
    // bindings (not a fresh re-implementation that could drift).
    expect(sealModule.sealUtf8).toBe(sealUtf8);
    expect(sealModule.openUtf8).toBe(openUtf8);
  });

  it('round-trips ASCII plaintext under a fresh secretbox key (byte-for-byte)', async () => {
    const key = freshKey();
    const pt = 'forklift in aisle 3 was leaking hydraulic fluid';
    const ct = await sealUtf8(pt, key);
    expect(ct).toBeInstanceOf(Uint8Array);
    // Includes the nonce prefix — strictly longer than the plaintext.
    expect(ct.length).toBeGreaterThan(pt.length);
    const recovered = await openUtf8(ct, key);
    expect(recovered).toBe(pt);
  });

  it('round-trips multi-byte UTF-8 (emoji + accents) without truncation', async () => {
    const key = freshKey();
    const pt = 'incident — opérateur a vu un risque ⚠️ près du poste #4';
    const ct = await sealUtf8(pt, key);
    const recovered = await openUtf8(ct, key);
    expect(recovered).toBe(pt);
  });

  it('two seals of the SAME plaintext under the SAME key produce different ciphertexts (random nonce)', async () => {
    const key = freshKey();
    const pt = 'concern body text';
    const ct1 = await sealUtf8(pt, key);
    const ct2 = await sealUtf8(pt, key);
    // libsodium prepends a fresh random nonce on each call — ciphertexts differ.
    expect(Array.from(ct1)).not.toEqual(Array.from(ct2));
    // Both still open to the same plaintext.
    expect(await openUtf8(ct1, key)).toBe(pt);
    expect(await openUtf8(ct2, key)).toBe(pt);
  });

  it('opening with the WRONG key fails (AEAD verification) — never silently mis-decrypts (F-147 carry-forward)', async () => {
    const keyA = freshKey();
    const keyB = freshKey();
    const ct = await sealUtf8('payload', keyA);
    // libsodium throws on a failed open — that is fail-closed (good).
    await expect(openUtf8(ct, keyB)).rejects.toBeDefined();
  });

  it('opening a too-short ciphertext (less than nonce + MAC) is rejected, not silently truncated', async () => {
    const key = freshKey();
    const tooShort = new Uint8Array(8); // nowhere near nonce(24) + MAC(16)
    await expect(openUtf8(tooShort, key)).rejects.toBeDefined();
  });
});
