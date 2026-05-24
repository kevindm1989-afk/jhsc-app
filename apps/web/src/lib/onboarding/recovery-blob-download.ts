/**
 * Recovery-blob JSON serializer + download (T19 / F-105).
 *
 * Re-import path (out of T19 scope): caller MUST verify version === 1, MUST
 * call secretbox_open before trusting any byte, MUST treat a MAC failure
 * as a hard error (do not fallback to a 'corrupted file — proceed anyway'
 * branch — never fallback). The downloaded JSON's MAC is the integrity
 * surface; do not skip MAC verify on re-import.
 *
 * Per F-105 M-105a/b/c:
 *   - JSON shape is EXACTLY `{ ciphertext, kdf_params, version, blob_id }` —
 *     closed allowlist; no PI fields. Tampered ciphertext fails secretbox_open
 *     MAC check at re-import time.
 *   - No `user_id`, `email`, `display_name`, `actor_pseudonym`, `passphrase`,
 *     `privkey`, `priv`, `secret`, `seed`. The closed allowlist is the
 *     defense-in-depth surface; the per-field absence test pins it.
 *   - `version === 1` is the negotiated re-import contract.
 *   - `blob_id` is a fresh UUID issued at download time, NOT correlatable to
 *     any other identifier.
 *
 * @see threat-model §8.T19 F-105
 * @see ADR-0020 §Decision 2.d step 7
 */

import { generateEnrollmentSessionId } from './state-machine';

export interface RecoveryBlobJsonInput {
  ciphertext: Uint8Array;
  kdf_params: {
    ops: number;
    mem: number;
    salt: Uint8Array;
  };
}

export interface RecoveryBlobJson {
  ciphertext: string;
  kdf_params: { ops: number; mem: number; salt: string };
  version: 1;
  blob_id: string;
}

function bytesToBase64(b: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(b).toString('base64');
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  // eslint-disable-next-line no-undef
  return btoa(s);
}

/**
 * Serialize a recovery blob to the on-disk JSON shape.
 *
 * The returned object's keys are EXACTLY the closed allowlist per F-105
 * M-105a. No PI fields are added (M-105b). The `blob_id` is a fresh UUID
 * (not correlatable). `version === 1` is the re-import contract.
 */
export function serializeRecoveryBlobJson(input: RecoveryBlobJsonInput): RecoveryBlobJson {
  return {
    ciphertext: bytesToBase64(input.ciphertext),
    kdf_params: {
      ops: input.kdf_params.ops,
      mem: input.kdf_params.mem,
      salt: bytesToBase64(input.kdf_params.salt)
    },
    version: 1,
    blob_id: generateEnrollmentSessionId()
  };
}

/**
 * Trigger a download of the serialized blob via URL.createObjectURL +
 * an anchor click. Browser may block (popup blocker); the wizard does
 * NOT block advancement on download failure (per ADR-0020 Decision 9).
 */
export function downloadRecoveryBlobJson(
  input: RecoveryBlobJsonInput,
  filename = 'jhsc-recovery-blob.json'
): { ok: boolean } {
  try {
    const json = serializeRecoveryBlobJson(input);
    const blob = new Blob([JSON.stringify(json, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
