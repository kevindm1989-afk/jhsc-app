/**
 * Browser-environment regression guard — the live-smoke bug the Node suite
 * could not see.
 *
 * ROOT CAUSE (confirmed on live infra): the browser-reachable crypto code
 * used Node's `Buffer` for UTF-8 encoding/decoding. `Buffer` is a Node
 * global, so EVERY existing vitest passed — but the deployed Vite browser
 * bundle does NOT polyfill `Buffer`, so the recovery-restore flow and the
 * shared concern/reprisal seal both threw a `ReferenceError: Buffer is not
 * defined` in-browser. The Node suite was blind to it because it always ran
 * with `Buffer` present.
 *
 * This file closes that blind spot: it DELETES `globalThis.Buffer` for the
 * duration of the suite (restoring it afterwards) so the code under test runs
 * in a Buffer-less context that mirrors the browser. Any path that still
 * reaches for a bare `Buffer.` throws here — exactly as it did live.
 *
 * Contract:
 *   - sealUtf8 / openUtf8 round-trip (ASCII + multibyte + emoji) with NO
 *     `Buffer` global → no ReferenceError, exact round-trip. This is the
 *     shared seal for BOTH concerns and reprisal (concerns/seal.ts).
 *   - restoreRecoveryBlobViaProduction happy path reaches the audit call
 *     (record_restored) with NO `Buffer` global → no ReferenceError at the
 *     device-fingerprint encode site (production-flows.ts).
 *
 * RED→GREEN proof: against the pre-fix code (Buffer.from / Buffer.toString)
 * every assertion below throws a `ReferenceError: Buffer is not defined`;
 * after the TextEncoder/TextDecoder swap they pass. Hermetic: real libsodium,
 * a mock transport, a real BrowserLocalIdentityStore. No clock, no network.
 *
 * Isolation note: vitest runs with `isolate: true`, so deleting the global in
 * this file's worker does not leak into other test files; the afterAll
 * restore is belt-and-suspenders.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import { sealUtf8, openUtf8 } from '../../src/lib/concerns';
import {
  BrowserLocalIdentityStore,
  SupabaseT07Client,
  storeRecoveryBlobViaProduction,
  restoreRecoveryBlobViaProduction,
  type T07OpTransport
} from '../../src/lib/crypto';

await _sodium.ready;
const sodium = _sodium;

// Stash the Node `Buffer` global so we can simulate the browser (where it is
// undefined) for the body of this suite, then restore it so any later file
// in the same worker is unaffected.
const savedBuffer = (globalThis as { Buffer?: unknown }).Buffer;

beforeAll(() => {
  // Simulate the deployed Vite browser bundle: no `Buffer` polyfill.
  delete (globalThis as { Buffer?: unknown }).Buffer;
});

afterAll(() => {
  (globalThis as { Buffer?: unknown }).Buffer = savedBuffer;
});

function pgHexToBytes(s: string): Uint8Array {
  const stripped = s.startsWith('\\x') ? s.slice(2) : s;
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function silentStore(): BrowserLocalIdentityStore {
  return new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
}

describe('browser regression — sealUtf8/openUtf8 with NO Buffer global', () => {
  it('the Buffer global is actually absent for the duration of this suite', () => {
    expect((globalThis as { Buffer?: unknown }).Buffer).toBeUndefined();
  });

  it('round-trips ASCII without a Buffer ReferenceError', async () => {
    const key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const pt = 'forklift in aisle 3 was leaking hydraulic fluid';
    const ct = await sealUtf8(pt, key);
    expect(ct).toBeInstanceOf(Uint8Array);
    expect(await openUtf8(ct, key)).toBe(pt);
  });

  it('round-trips multibyte UTF-8 + emoji byte-for-byte without a Buffer ReferenceError', async () => {
    const key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const pt = 'incident — opérateur a vu un risque ⚠️🧯 près du poste #4 — 日本語も';
    const ct = await sealUtf8(pt, key);
    expect(await openUtf8(ct, key)).toBe(pt);
  });
});

describe('browser regression — restoreRecoveryBlobViaProduction with NO Buffer global', () => {
  it('reaches the audit call (record_restored) on the happy path without a Buffer ReferenceError', async () => {
    // Pre-seed a device-local privkey, store a recovery blob, then restore on
    // a "fresh device" — the same shape as the T07 production-flows happy
    // path, but with `Buffer` deleted to mirror the browser.
    const localIdentity = silentStore();
    const trueKeypair = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey('u-test', trueKeypair.privateKey);

    let storedEnvelopeHex: string | null = null;
    let storedKdfParams: Record<string, unknown> | null = null;
    let restoredAuditPosted = false;

    const transport: T07OpTransport = async (body) => {
      if (body.op === 'store_recovery') {
        storedEnvelopeHex = body.blob_ciphertext_hex as string;
        storedKdfParams = body.kdf_params as Record<string, unknown>;
        return { status: 200, body: { ok: true, data: null } };
      }
      if (body.op === 'get_recovery_blob') {
        if (storedEnvelopeHex === null) {
          return { status: 200, body: { ok: true, data: null } };
        }
        return {
          status: 200,
          body: {
            ok: true,
            data: { blob_ciphertext_hex: storedEnvelopeHex, kdf_params: storedKdfParams }
          }
        };
      }
      if (body.op === 'record_restored') {
        // The device-fingerprint hash is computed at the formerly-Buffer
        // encode site (production-flows.ts ~193). Reaching here at all proves
        // that encode no longer throws a Buffer ReferenceError in-browser.
        const fp = body.device_fingerprint_hashed as string;
        expect(fp).toMatch(/^[0-9a-f]{64}$/);
        restoredAuditPosted = true;
        return { status: 200, body: { ok: true, data: null } };
      }
      throw new Error(`unexpected op ${String(body.op)}`);
    };

    const client = new SupabaseT07Client({ transport, localIdentity });
    const stored = await storeRecoveryBlobViaProduction({
      client,
      localIdentity,
      user_id: 'u-test',
      passphrase: 'a-strong-passphrase-32-chars-long'
    });
    expect(stored.status).toBe('ok');

    const freshDevice = silentStore();
    const freshClient = new SupabaseT07Client({ transport, localIdentity: freshDevice });
    const restored = await restoreRecoveryBlobViaProduction({
      client: freshClient,
      localIdentity: freshDevice,
      user_id: 'u-test',
      passphrase: 'a-strong-passphrase-32-chars-long',
      // A multibyte fingerprint exercises the UTF-8 encoder, not just ASCII.
      device_fingerprint_raw: 'demo-device-fp-2026-06-22 — poste #4 日本語'
    });

    expect(restored.status).toBe('ok');
    if (restored.status !== 'ok') return;
    expect(restored.private_key).toEqual(trueKeypair.privateKey);
    // The audit call was reached — the device-fingerprint encode did not throw.
    expect(restoredAuditPosted).toBe(true);
  });
});
