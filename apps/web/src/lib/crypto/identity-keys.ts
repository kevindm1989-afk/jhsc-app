/**
 * Identity keypair generation — X25519 via libsodium (T07 / ADR-0003 Invariant 1, 4).
 *
 * The private key NEVER leaves the device unencrypted (Invariant 1). The
 * public key is the identity for routing committee key wraps (Invariant 5).
 *
 * Source: ADR-0003 §Option A; threat-model §3.1 F-02 (pubkey/privkey
 * pairing self-test at enrollment).
 */

import { ready } from './sodium';
import type { IdentityKeypair } from './types';

/** Lowercase-hex encoder for a byte array (no `0x` prefix). */
function bytesToHexLower(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) {
    s += buf[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

/** Generate a fresh X25519 identity keypair via libsodium. */
export async function generateIdentityKeypair(): Promise<IdentityKeypair> {
  const s = await ready();
  const kp = s.crypto_box_keypair();
  return {
    public_key: kp.publicKey,
    private_key: kp.privateKey
  };
}

/**
 * F-02 pairing self-test. Seal a known message to the candidate public key
 * and open it with the candidate private key; if the round-trip succeeds
 * the keypair is internally consistent.
 *
 * Returns true on success, false on mismatch. The enrollment caller MUST
 * NOT proceed (and MUST NOT write `users.identity_pubkey`) on false.
 */
export async function selfTestKeypair(kp: IdentityKeypair): Promise<boolean> {
  const s = await ready();
  try {
    const probe = s.randombytes_buf(32);
    const sealed = s.crypto_box_seal(probe, kp.public_key);
    const opened = s.crypto_box_seal_open(sealed, kp.public_key, kp.private_key);
    if (opened.length !== probe.length) return false;
    for (let i = 0; i < probe.length; i++) {
      if (opened[i] !== probe[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * SHA-256 fingerprint of the identity public key. Hex (lowercase, no `0x`);
 * used as `ident_pubkey_fingerprint` in `identity_keypair.created` audit
 * rows (Amendment A meta requirement) AND as the cross-tier human-comparison
 * display string the F-172 co-chair-reads-aloud confirmation control relies
 * on (Decision 5/6). The output is 32 bytes → 64 hex chars — matching the
 * `^[0-9a-f]{64}$` regex the SQL `enroll_identity_keypair` +
 * `issue_enrollment_challenge` functions enforce (migrations 0007 / 0008,
 * lines 246-247 / 282 / 358-359) as the 64-hex shape contract.
 *
 * Algorithm: SHA-256 per Amendment A-6.1 (.context/decisions.md 2026-06-22),
 * which supersedes A-6's libsodium `crypto_generichash`/BLAKE2b choice. The
 * SQL fingerprint helper (`get_member_identity_pubkey_for_wrap`) uses
 * `encode(extensions.digest(public_key, 'sha256'), 'hex')` via pgcrypto;
 * `crypto.subtle.digest('SHA-256', …)` here produces the byte-identical
 * 64-hex string for the same 32-byte input — closing the JS↔SQL drift hole
 * that would have broken the F-172 confirmation control.
 *
 * Security note: the fingerprint is a HUMAN-COMPARISON DISPLAY STRING over
 * a 256-bit X25519 pubkey domain. It is NOT a pseudonym (audit pseudonyms
 * are HMAC-based, unchanged). The choice between SHA-256 and BLAKE2b for
 * this surface is a collision-resistance question on 256 bits of uniformly
 * random input — both saturate the ceiling; the project's actual infra
 * supports SHA-256 unconditionally on both tiers, BLAKE2b does not.
 *
 * Why `crypto.subtle.digest` here and not libsodium (ADR-0003 Invariant 4):
 * the ADR-0003 libsodium-only rule constrains CRYPTOGRAPHIC OPERATIONS
 * (sealing/signing/KDFs/secretbox). A SHA-256 of a public byte string is
 * a hash, not a key-bearing operation; using WebCrypto here keeps the JS
 * tier symmetric with the SQL tier (both pgcrypto-style SHA-256) and is
 * exempt from the `no-non-libsodium-crypto` semgrep rule because this
 * module lives under `apps/web/src/lib/crypto/` (the rule's allowlist).
 * The `ready()` import is retained so other helpers in this file can keep
 * using libsodium where it remains the correct tool.
 */
export async function pubkeyFingerprint(public_key: Uint8Array): Promise<string> {
  // `crypto.subtle.digest` returns an ArrayBuffer — wrap as Uint8Array for
  // the hex encoder. `subtle` is the WebCrypto entry point available in
  // every browser the project targets AND in Node 16+/Vitest (which is
  // what the apps/web suite runs under).
  //
  // TypeScript narrowing note: TS 5.7+ tightened the WebCrypto `digest()`
  // parameter type to require an `ArrayBuffer`-backed BufferSource (rejecting
  // `Uint8Array<SharedArrayBuffer>` and other generic-buffer views). A bare
  // `Uint8Array` from a caller might carry the wider `ArrayBufferLike` type.
  // Defensive copy into a fresh `Uint8Array` guarantees an `ArrayBuffer`
  // backing and is safe — pubkeys are 32 bytes, the copy is negligible, and
  // the original buffer is not mutated. Pass the underlying `.buffer` so the
  // type aligns with the `BufferSource` overload.
  const copy = new Uint8Array(public_key.length);
  copy.set(public_key);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return bytesToHexLower(new Uint8Array(digest));
}
