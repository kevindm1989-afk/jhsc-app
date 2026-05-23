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
 * BLAKE2b fingerprint of the identity public key. Hex; used as
 * `ident_pubkey_fingerprint` in `identity_keypair.created` audit rows
 * (Amendment A meta requirement).
 */
export async function pubkeyFingerprint(public_key: Uint8Array): Promise<string> {
  const s = await ready();
  return s.to_hex(s.crypto_generichash(16, public_key));
}
