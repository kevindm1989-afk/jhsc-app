/**
 * F182-6 / ADR-0030 Amendment C — the actor X25519 public-key derivation
 * helper (Decision C3 / AC-C13; threat-model.md §3.18 F182-6 DESIGN
 * VALIDATION, STRIDE-S :4918 / re-pass #28 :4961).
 *
 * `rotateCommitteeKeyOnRemovalViaProduction` seals the fresh committee key to
 * the ACTOR's OWN X25519 public key (step-4 self-wrap, production-flows.ts:1165).
 * `LocalIdentityStore` exposes only `getIdentityPrivateKey`; the public half is
 * `crypto_scalarmult_base(privateKey)`. Per ADR-0003 Invariant 1 this derivation
 * TOUCHES the private key, so it MUST live in the crypto / orchestration layer,
 * NEVER in the presentational `CommitteeManageMemberCard.svelte`. The private
 * buffer is zeroized in place after derivation (mirrors the recovery-blob
 * scalarmult-base site, recovery-blob.ts:232).
 */
import { ready } from './sodium';

/**
 * Derive the actor's X25519 public key from their identity private key.
 *
 * Returns `crypto_scalarmult_base(privateKey)` (32 bytes) and `.fill(0)`s the
 * caller-owned `privateKey` buffer in place — the private half never lingers
 * past the single derivation it is needed for (AC-C13).
 */
export async function deriveActorPublicKey(privateKey: Uint8Array): Promise<Uint8Array> {
  const s = await ready();
  try {
    // Derive the public half; a malformed (wrong-length) scalar makes libsodium
    // throw BEFORE returning.
    return s.crypto_scalarmult_base(privateKey);
  } finally {
    // AC-C13: zeroize the private-key buffer in place on BOTH the success and the
    // throw path (mirrors recovery-blob.ts) — the private half never lingers.
    privateKey.fill(0);
  }
}
