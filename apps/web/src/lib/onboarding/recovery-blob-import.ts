/**
 * Recovery-blob JSON re-import (T19 / F-105 — the inverse of
 * recovery-blob-download.ts's serializer).
 *
 * Per the serializer header (recovery-blob-download.ts:1-27): re-import
 * MUST verify version === 1, MUST call secretbox_open before trusting
 * any byte, MUST treat a MAC failure as a hard error (never fallback
 * to "corrupted file — proceed anyway"). This module implements those
 * requirements at the file-shape + crypto layer:
 *
 *   1. Parse JSON, validate the closed-allowlist top-level shape
 *      ({ ciphertext, kdf_params, version, blob_id }). Reject on:
 *        - Non-object root.
 *        - Missing or extra top-level keys.
 *        - version !== 1.
 *        - blob_id not a non-empty string.
 *        - kdf_params missing { ops, mem, salt } or wrong types.
 *   2. Base64-decode ciphertext + salt; split the first
 *      crypto_secretbox_NONCEBYTES (24) bytes back out as the nonce
 *      (the serializer concatenates nonce || ciphertext into the
 *      single `ciphertext` field).
 *   3. Construct a RecoveryBlobShape and hand it to decryptRecoveryBlob.
 *      That function's contract:
 *        - throws Error(ARGON2_UNAVAILABLE_ERROR) when the Argon2id
 *          path is unreachable (Amendment G).
 *        - returns null on MAC fail or any other decrypt error
 *          ("wrong passphrase or corrupted blob").
 *        - returns an IdentityKeypair when decryption succeeds AND
 *          the recovered private key is 32 bytes.
 *
 * The verifier surface (RecoveryVerifierCard) wraps this module so
 * the worker can periodically check "my recovery sheet still works"
 * without going through a full recover-and-re-enroll ceremony — pure
 * client-side; no server roundtrip.
 *
 * @see threat-model §8.T19 F-105
 * @see ADR-0020 §Decision 2.d step 7
 * @see ADR-0003 Amendment G (fail-closed on Argon2 unavailability)
 */

import { ARGON2_UNAVAILABLE_ERROR, decryptRecoveryBlob } from '../crypto/recovery-blob';
import type { IdentityKeypair, KdfParams, RecoveryBlobShape } from '../crypto/types';

/** libsodium crypto_secretbox_NONCEBYTES. Pinned here so the splitter
 *  doesn't have to take a sodium runtime dependency. */
const SECRETBOX_NONCE_BYTES = 24;

/** Result discriminator for the JSON parse + shape-validate step. */
export type RecoveryBlobJsonParseResult =
  | { ok: true; blob: RecoveryBlobShape; blob_id: string }
  | { ok: false; reason: RecoveryBlobJsonParseReason };

/** Closed allowlist of parse-failure reasons surfaced to the UI. */
export type RecoveryBlobJsonParseReason =
  | 'not_json'
  | 'wrong_shape'
  | 'wrong_version'
  | 'bad_base64'
  | 'bad_nonce_length';

/** Result discriminator for the full decrypt-verify step. */
export type VerifyRecoveryBlobResult =
  | { ok: true; identity: IdentityKeypair; blob_id: string }
  | { ok: false; reason: VerifyRecoveryBlobReason };

/** Closed allowlist of verify-failure reasons. */
export type VerifyRecoveryBlobReason =
  | RecoveryBlobJsonParseReason
  /** decryptRecoveryBlob returned null — wrong passphrase OR tampered ciphertext. */
  | 'decrypt_failed'
  /** decryptRecoveryBlob threw the Argon2-unavailable signal. */
  | 'argon2_unavailable';

function base64ToBytes(s: string): Uint8Array | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  try {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    const binary = atob(s);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Parse a JSON string from a downloaded recovery sheet into a
 * RecoveryBlobShape ready for decryptRecoveryBlob.
 *
 * Closed-allowlist shape check — rejects unknown top-level keys so a
 * tampered/extended JSON cannot smuggle additional fields into the
 * decryption path. Version pin enforces the v1 contract.
 */
export function deserializeRecoveryBlobJson(jsonText: string): RecoveryBlobJsonParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'wrong_shape' };
  }
  const root = parsed as Record<string, unknown>;

  // Closed-allowlist top-level shape: ciphertext + kdf_params + version + blob_id.
  const ALLOWED_KEYS = new Set(['ciphertext', 'kdf_params', 'version', 'blob_id']);
  for (const k of Object.keys(root)) {
    if (!ALLOWED_KEYS.has(k)) return { ok: false, reason: 'wrong_shape' };
  }
  if (typeof root.ciphertext !== 'string' || typeof root.blob_id !== 'string') {
    return { ok: false, reason: 'wrong_shape' };
  }
  if (root.blob_id.length === 0) return { ok: false, reason: 'wrong_shape' };
  if (root.version !== 1) return { ok: false, reason: 'wrong_version' };

  const kdf = root.kdf_params as Record<string, unknown> | undefined;
  if (!kdf || typeof kdf !== 'object') return { ok: false, reason: 'wrong_shape' };
  if (typeof kdf.ops !== 'number' || typeof kdf.mem !== 'number' || typeof kdf.salt !== 'string') {
    return { ok: false, reason: 'wrong_shape' };
  }

  const ctAll = base64ToBytes(root.ciphertext);
  const saltBytes = base64ToBytes(kdf.salt);
  if (!ctAll || !saltBytes) return { ok: false, reason: 'bad_base64' };
  if (ctAll.length < SECRETBOX_NONCE_BYTES + 1) {
    return { ok: false, reason: 'bad_nonce_length' };
  }

  const nonce = ctAll.slice(0, SECRETBOX_NONCE_BYTES);
  const ciphertext = ctAll.slice(SECRETBOX_NONCE_BYTES);

  const kdf_params: KdfParams = {
    ops: kdf.ops,
    mem_bytes: kdf.mem,
    alg: 'argon2id13',
    version: 1
  };

  const blob: RecoveryBlobShape = {
    salt: saltBytes,
    nonce,
    ciphertext,
    kdf_params
  };

  return { ok: true, blob, blob_id: root.blob_id };
}

/**
 * High-level "verify this recovery sheet" path: parse the JSON,
 * decrypt with the provided passphrase, and return the recovered
 * IdentityKeypair on success.
 *
 * Re-uses decryptRecoveryBlob's Amendment-G fail-closed contract: an
 * unavailable Argon2id implementation surfaces as `argon2_unavailable`
 * rather than masquerading as a wrong-passphrase failure (which would
 * let a user think their sheet was bad when in fact their browser
 * can't do the math).
 */
export async function verifyRecoveryBlobJson(
  jsonText: string,
  passphrase: string
): Promise<VerifyRecoveryBlobResult> {
  const parsed = deserializeRecoveryBlobJson(jsonText);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  try {
    const id = await decryptRecoveryBlob(parsed.blob, passphrase);
    if (!id) return { ok: false, reason: 'decrypt_failed' };
    return { ok: true, identity: id, blob_id: parsed.blob_id };
  } catch (e) {
    if (e instanceof Error && e.message === ARGON2_UNAVAILABLE_ERROR) {
      return { ok: false, reason: 'argon2_unavailable' };
    }
    return { ok: false, reason: 'decrypt_failed' };
  }
}
