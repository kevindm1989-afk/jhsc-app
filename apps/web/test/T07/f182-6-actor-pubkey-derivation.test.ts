/**
 * F182-6 / ADR-0030 Amendment C — the `actor_public_key` derivation helper
 * (AC-C13 / Decision C3 / threat-model.md §3.18 F182-6 DESIGN VALIDATION,
 * STRIDE-S :4918 + re-pass #28 :4961).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * WHY THIS TEST EXISTS (the load-bearing invariant it pins):
 *   The rotation composition (`rotateCommitteeKeyOnRemovalViaProduction`) needs
 *   the ACTOR's OWN X25519 public key to seal the fresh committee key to itself
 *   (step-4 self-wrap, production-flows.ts:1165). `LocalIdentityStore` exposes
 *   only `getIdentityPrivateKey` — the public half is `crypto_scalarmult_base(
 *   privateKey)`. Per ADR-0003 Invariant 1 + AC-C13, that derivation TOUCHES the
 *   private key, so it MUST live in the crypto/orchestration layer, NEVER in the
 *   presentational `CommitteeManageMemberCard.svelte`, and the private buffer MUST
 *   be `.fill(0)`'d after derivation.
 *
 * REQUIRED EXPORT (the implementer must add this — the RED signal below):
 *   `deriveActorPublicKey(privateKey: Uint8Array): Uint8Array | Promise<Uint8Array>`
 *   re-exported from `$lib/crypto` (src/lib/crypto/index.ts). It returns
 *   `crypto_scalarmult_base(privateKey)` and zeroizes `privateKey` in place.
 *
 * WHY RED NOW: `deriveActorPublicKey` does not exist on the crypto surface yet.
 *   The `helper()` guard asserts the export is a function — a SPECIFIC red naming
 *   what is missing (mirrors the f182-4b `getComposition()` guard pattern). Every
 *   behavioral assertion below is gated behind that guard.
 *
 * DETERMINISM: real libsodium (the crypto under test) but NO asserting on random
 *   bytes by VALUE — correctness is proven by (a) equality with the keypair's own
 *   public half, (b) a seal→open round-trip, (c) zeroization of the input buffer.
 *   No clock, no network, no RNG assertions. Each test owns its fixtures.
 */

import { describe, expect, it } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { WEB_ROOT } from '../_helpers/paths';
import * as cryptoLib from '../../src/lib/crypto';

await _sodium.ready;
const sodium = _sodium;

// The presentational card — AC-C13 forbids ANY crypto-material touch here.
const CARD_SRC = path.join(WEB_ROOT, 'src/lib/committee/CommitteeManageMemberCard.svelte');

/** Guard: the export exists + is callable. Fails RED with a specific message
 *  until the implementer adds `deriveActorPublicKey` to the crypto surface. */
function helper(): (priv: Uint8Array) => Uint8Array | Promise<Uint8Array> {
  const fn = (cryptoLib as Record<string, unknown>).deriveActorPublicKey;
  expect(
    typeof fn,
    'AC-C13: $lib/crypto must export `deriveActorPublicKey(privateKey)` — the ' +
      'orchestration-layer X25519 pubkey derivation (crypto_scalarmult_base + zeroize). ' +
      'It does not exist yet.'
  ).toBe('function');
  return fn as (priv: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

describe('F182-6 [AC-C13] deriveActorPublicKey — crypto-layer X25519 derivation', () => {
  it('returns the X25519 public half of the identity private key (== crypto_scalarmult_base)', async () => {
    const derive = helper();
    const kp = sodium.crypto_box_keypair(); // publicKey === scalarmult_base(privateKey)
    const privForHelper = Uint8Array.from(kp.privateKey);

    const pub = await derive(privForHelper);

    // Correct pairing: the derived pubkey equals the keypair's own public half
    // AND the raw base-point multiplication of the private key.
    expect(pub, 'derived pubkey must equal the keypair public half').toEqual(kp.publicKey);
    expect(pub, 'derived pubkey must equal crypto_scalarmult_base(priv)').toEqual(
      sodium.crypto_scalarmult_base(kp.privateKey)
    );
    expect(pub.length, 'X25519 public key is 32 bytes').toBe(32);
  });

  it('round-trips: a message sealed to the derived pubkey opens with the original private key', async () => {
    const derive = helper();
    const kp = sodium.crypto_box_keypair();
    const privForHelper = Uint8Array.from(kp.privateKey);

    const pub = await derive(privForHelper);

    const msg = sodium.randombytes_buf(32); // stand-in for a fresh committee key
    const sealed = sodium.crypto_box_seal(msg, pub);
    // The ORIGINAL private key (kp.privateKey, untouched) must open it — proving
    // the derived pubkey is the genuine pairing, not an arbitrary 32-byte value.
    const opened = sodium.crypto_box_seal_open(sealed, kp.publicKey, kp.privateKey);
    expect(opened, 'seal-to-derived-pubkey must open with the paired private key').toEqual(msg);
  });

  it('zeroizes the private-key buffer in place after derivation (.fill(0))', async () => {
    const derive = helper();
    const kp = sodium.crypto_box_keypair();
    const privForHelper = Uint8Array.from(kp.privateKey);
    // Precondition: a real (non-zero) private key went in.
    expect(privForHelper.some((b) => b !== 0), 'precondition: private key is non-zero').toBe(true);

    await derive(privForHelper);

    expect(
      Array.from(privForHelper).every((b) => b === 0),
      'AC-C13: the private-key buffer MUST be wiped to all-zero after derivation'
    ).toBe(true);
  });

  // ── Adversarial F3 / AC-C13 (round-1 closure fix) ──────────────────────────
  // The zeroize must run on the THROW path too. libsodium's crypto_scalarmult_base
  // rejects a wrong-length scalar (it requires EXACTLY crypto_scalarmult_SCALARBYTES
  // = 32 bytes) by THROWING a TypeError. RED today: the impl runs `.fill(0)` AFTER
  // `crypto_scalarmult_base(priv)`, so a throw skips the wipe and the private bytes
  // linger in the caller-owned buffer. Fix: wrap the derivation in try { … } finally
  // { priv.fill(0) } so the buffer is zeroed on BOTH success and throw.
  it('zeroizes the private-key buffer even when the derivation THROWS (try/finally, AC-C13)', async () => {
    const derive = helper();
    // 16 ≠ 32 → crypto_scalarmult_base throws "invalid privateKey length" BEFORE
    // returning; the input buffer is left untouched (still 0xAB) by libsodium.
    const malformed = new Uint8Array(16).fill(0xab);
    expect(malformed.some((b) => b !== 0), 'precondition: malformed buffer is non-zero').toBe(true);

    await expect(
      (async () => derive(malformed))(),
      'a malformed scalar must reject/throw — never a silent success'
    ).rejects.toBeInstanceOf(Error);

    expect(
      Array.from(malformed).every((b) => b === 0),
      'AC-C13: the private-key buffer MUST be wiped even on the throw path (try/finally)'
    ).toBe(true);
  });

  it('does not smuggle the private key out through the return value (returns a distinct pubkey buffer)', async () => {
    const derive = helper();
    const kp = sodium.crypto_box_keypair();
    const privForHelper = Uint8Array.from(kp.privateKey);
    const pub = await derive(privForHelper);
    // The returned buffer is the PUBLIC key, not an alias of the (now-zeroed)
    // private buffer, and is not itself all-zero.
    expect(pub).not.toBe(privForHelper);
    expect(pub.some((b) => b !== 0), 'returned pubkey must be non-zero').toBe(true);
  });
});

describe('F182-6 [AC-C13 / re-pass #28] the derivation lives in the crypto layer, NOT the component', () => {
  const src = readFileSync(CARD_SRC, 'utf8');

  it('CommitteeManageMemberCard.svelte performs NO crypto_scalarmult_base / pubkey derivation', () => {
    expect(src).not.toMatch(/crypto_scalarmult_base/);
    expect(src).not.toMatch(/crypto_box_seal/);
    expect(src, 'the card must not import the derivation helper — it stays orchestration-side').not.toMatch(
      /deriveActorPublicKey/
    );
  });

  it('CommitteeManageMemberCard.svelte imports NO crypto dep (holder / localIdentity / t07 / $lib/crypto)', () => {
    // Structural Invariant-1: no crypto module or key-material dep may be imported
    // into the presentational card (it consumes an opaque status union only).
    expect(src).not.toMatch(/from\s+['"][^'"]*\$lib\/crypto/);
    expect(src).not.toMatch(/getIdentityPrivateKey/);
    expect(src).not.toMatch(/CommitteeKeyHolder|LocalIdentityStore|SupabaseT07Client/);
    expect(src).not.toMatch(/libsodium/);
  });

  it('CommitteeManageMemberCard.svelte emits no console.* (F-176 / AC-C13)', () => {
    expect(src).not.toMatch(/console\.[a-z]+/);
  });
});
