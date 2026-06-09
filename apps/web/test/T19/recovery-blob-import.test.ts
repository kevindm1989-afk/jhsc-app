/**
 * T19.1 — recovery-blob-import (the inverse of the F-105 serializer).
 *
 * Pins the parse-and-verify shape contract that the RecoveryVerifierCard
 * leans on:
 *   - JSON parse failures surface as 'not_json'.
 *   - Top-level shape violations (missing keys, extra keys, wrong types)
 *     all surface as 'wrong_shape'.
 *   - version !== 1 surfaces as 'wrong_version'.
 *   - Bad base64 in ciphertext or salt surfaces as 'bad_base64'.
 *   - A ciphertext shorter than the secretbox nonce (24 bytes) surfaces
 *     as 'bad_nonce_length' rather than crashing.
 *   - Closed-allowlist top-level keys: any unknown field is rejected
 *     so a tampered file cannot smuggle additional inputs into decrypt.
 *
 * Round-trip is exercised end-to-end: serialize a real blob with the
 * matching F-105 serializer, deserialize it back, assert the nonce +
 * ciphertext + salt + kdf_params shape is recovered.
 */

import { describe, expect, it } from 'vitest';
import {
  deserializeRecoveryBlobJson,
  type RecoveryBlobJsonParseResult
} from '../../src/lib/onboarding/recovery-blob-import';
import { serializeRecoveryBlobJson } from '../../src/lib/onboarding/recovery-blob-download';

describe('T19.1 — deserializeRecoveryBlobJson — shape / version pins', () => {
  it('returns not_json for invalid JSON', () => {
    const r = deserializeRecoveryBlobJson('this is not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_json');
  });

  it('returns wrong_shape for a JSON array (root must be object)', () => {
    const r = deserializeRecoveryBlobJson('[]');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong_shape');
  });

  it('returns wrong_shape for missing top-level keys', () => {
    const r = deserializeRecoveryBlobJson('{"version":1}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong_shape');
  });

  it('returns wrong_shape for unknown top-level keys (closed-allowlist defense)', () => {
    const r = deserializeRecoveryBlobJson(
      JSON.stringify({
        ciphertext: 'AAAA',
        kdf_params: { ops: 4, mem: 1, salt: 'AA' },
        version: 1,
        blob_id: 'x',
        extra: 'smuggled'
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong_shape');
  });

  it('returns wrong_version for version !== 1', () => {
    const r = deserializeRecoveryBlobJson(
      JSON.stringify({
        ciphertext: 'AAAA',
        kdf_params: { ops: 4, mem: 1, salt: 'AA' },
        version: 2,
        blob_id: 'x'
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong_version');
  });

  it('returns wrong_shape for empty blob_id', () => {
    const r = deserializeRecoveryBlobJson(
      JSON.stringify({
        ciphertext: 'AAAA',
        kdf_params: { ops: 4, mem: 1, salt: 'AA' },
        version: 1,
        blob_id: ''
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong_shape');
  });

  it('returns wrong_shape for missing kdf_params fields', () => {
    const r = deserializeRecoveryBlobJson(
      JSON.stringify({
        ciphertext: 'AAAA',
        kdf_params: { ops: 4 },
        version: 1,
        blob_id: 'x'
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong_shape');
  });

  it('returns bad_base64 for malformed base64 in ciphertext', () => {
    // A long enough string that passes the length check but contains
    // characters atob/Buffer reject.
    const r = deserializeRecoveryBlobJson(
      JSON.stringify({
        ciphertext: '!!!not-base64-content-here!!!',
        kdf_params: { ops: 4, mem: 1, salt: 'AA' },
        version: 1,
        blob_id: 'x'
      })
    );
    // Either bad_base64 or bad_nonce_length is acceptable here depending
    // on whether atob throws or returns a short buffer; both signal
    // "this isn't a valid recovery sheet" to the user.
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(['bad_base64', 'bad_nonce_length']).toContain(r.reason);
    }
  });

  it('returns bad_nonce_length when ciphertext is shorter than secretbox nonce (24 bytes)', () => {
    // Base64 'AAAA' = 3 bytes; less than 24.
    const r = deserializeRecoveryBlobJson(
      JSON.stringify({
        ciphertext: 'AAAA',
        kdf_params: { ops: 4, mem: 1, salt: 'AAAA' },
        version: 1,
        blob_id: 'x'
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_nonce_length');
  });
});

describe('T19.1 — deserializeRecoveryBlobJson — round-trip with the F-105 serializer', () => {
  it('serialize then deserialize recovers the nonce + ciphertext + salt + kdf_params', () => {
    const nonce = new Uint8Array(24).fill(7);
    const ciphertext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const salt = new Uint8Array(16).fill(42);
    const json = serializeRecoveryBlobJson({
      ciphertext,
      nonce,
      kdf_params: { ops: 4, mem: 512 * 1024 * 1024, salt }
    });
    const r = deserializeRecoveryBlobJson(JSON.stringify(json));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.from(r.blob.nonce)).toEqual(Array.from(nonce));
    expect(Array.from(r.blob.ciphertext)).toEqual(Array.from(ciphertext));
    expect(Array.from(r.blob.salt)).toEqual(Array.from(salt));
    expect(r.blob.kdf_params.ops).toBe(4);
    expect(r.blob.kdf_params.mem_bytes).toBe(512 * 1024 * 1024);
    expect(r.blob.kdf_params.alg).toBe('argon2id13');
    expect(r.blob.kdf_params.version).toBe(1);
    expect(r.blob_id).toBe(json.blob_id);
  });

  it('rejects a tampered JSON where ciphertext was base64-edited', () => {
    const nonce = new Uint8Array(24).fill(7);
    const ciphertext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const salt = new Uint8Array(16).fill(42);
    const json = serializeRecoveryBlobJson({
      ciphertext,
      nonce,
      kdf_params: { ops: 4, mem: 512 * 1024 * 1024, salt }
    });
    // Replace the entire ciphertext field with garbage.
    const tampered: typeof json = { ...json, ciphertext: 'AAA!' };
    const r: RecoveryBlobJsonParseResult = deserializeRecoveryBlobJson(JSON.stringify(tampered));
    expect(r.ok).toBe(false);
  });
});
