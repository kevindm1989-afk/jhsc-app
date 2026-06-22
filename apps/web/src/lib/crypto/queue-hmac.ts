/**
 * Queue HMAC integrity primitives (T10 — HG-4 / ADR-0014).
 *
 * Source obligations:
 *   - ADR-0014: BLAKE2b-256 keyed MAC over (sequence_number || user_id ||
 *     ciphertext). Key derived via single-step KDF using BLAKE2b's keyed
 *     mode with personalisation `jhsc.queue.hmac.v1`.
 *   - threat-model §3.5 F-44 (tamper) / F-45 (no plaintext residue).
 *   - audit-log.md §1 — `queue.integrity_fail` (canonical per ADR-0010
 *     Amendment F-B).
 *
 * Algorithm (single-step BLAKE2b KDF, matching libsodium's keyed-hash
 * sub-key construction):
 *
 *   K_hmac = BLAKE2b(
 *     outlen   = 32,
 *     key      = identity_privkey,            // 32 bytes
 *     message  = personalisation || user_id   // salt-version || uuid-bytes
 *   )
 *
 *   tag = BLAKE2b(
 *     outlen   = 32,
 *     key      = K_hmac,
 *     message  = u64_be(seq) || user_id || ciphertext
 *   )
 *
 * The personalisation string `jhsc.queue.hmac.v1` versions the salt; an
 * entry tagged with an unknown salt version is refused without
 * verification (per the salt-version-mismatch test).
 *
 * The HMAC key NEVER leaves the device: it is recomputed in memory at
 * session start from the identity privkey (which itself is held only in
 * memory after passkey unwrap). No on-disk path retains K_hmac.
 */

import { ready } from './sodium';

/** Canonical salt version (versioned per ADR-0014). */
export const HMAC_QUEUE_SALT_V1 = 'jhsc.queue.hmac.v1';

/**
 * Derive the per-session queue HMAC key from the user's identity privkey.
 *
 * Inputs are 32-byte private key + UUID bytes (16 bytes). The output is a
 * 32-byte symmetric key used directly as the `key` parameter to BLAKE2b
 * in `computeQueueHMAC`.
 */
export async function deriveQueueHmacKey(opts: {
  identity_privkey: Uint8Array;
  user_id: Uint8Array;
}): Promise<Uint8Array> {
  const s = await ready();
  if (opts.identity_privkey.length !== 32) {
    throw new Error('deriveQueueHmacKey: identity_privkey must be 32 bytes');
  }
  // message = personalisation_bytes || user_id_bytes
  // Browser-native UTF-8 encode; `Buffer` is undefined in the Vite browser
  // bundle. The `new Uint8Array(...)` re-wrap keeps the libsodium wasm
  // bridge's cross-realm typeof check happy under jsdom.
  const salt = new Uint8Array(new TextEncoder().encode(HMAC_QUEUE_SALT_V1));
  const msg = new Uint8Array(salt.length + opts.user_id.length);
  msg.set(salt, 0);
  msg.set(opts.user_id, salt.length);
  return s.crypto_generichash(32, msg, new Uint8Array(opts.identity_privkey));
}

/**
 * Pack a u64 big-endian sequence number into 8 bytes.
 */
function u64BigEndian(seq: bigint): Uint8Array {
  if (seq < 0n) throw new Error('u64BigEndian: seq must be non-negative');
  const out = new Uint8Array(8);
  let v = seq;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Compute the BLAKE2b-256 keyed tag over (seq || user_id || ciphertext).
 *
 * Deterministic: identical inputs produce identical 32-byte tags. This is
 * the contract the known-answer test asserts (replay against same inputs
 * yields a byte-equal tag).
 */
export async function computeQueueHMAC(opts: {
  k: Uint8Array;
  seq: bigint;
  user_id: Uint8Array;
  ciphertext: Uint8Array;
}): Promise<Uint8Array> {
  const s = await ready();
  if (opts.k.length !== 32) {
    throw new Error('computeQueueHMAC: key must be 32 bytes');
  }
  const seqBytes = u64BigEndian(opts.seq);
  const msg = new Uint8Array(seqBytes.length + opts.user_id.length + opts.ciphertext.length);
  msg.set(seqBytes, 0);
  msg.set(opts.user_id, seqBytes.length);
  msg.set(opts.ciphertext, seqBytes.length + opts.user_id.length);
  return s.crypto_generichash(32, msg, new Uint8Array(opts.k));
}

/**
 * Constant-time compare of two byte buffers. Used at drain time to verify
 * the stored tag against the recomputed tag.
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/**
 * Parse a UUID string (with or without hyphens) into 16 bytes.
 */
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) {
    throw new Error(`uuidToBytes: expected 32 hex chars after strip, got ${hex.length}`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
