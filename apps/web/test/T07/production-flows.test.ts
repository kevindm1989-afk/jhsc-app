/**
 * T07.1 — production-flows tests.
 *
 * End-to-end hermetic coverage for the production composition layer in
 * `src/lib/crypto/production-flows.ts`. Each test wires a real
 * `BrowserLocalIdentityStore` (SSR-fallback Map) + a real `SupabaseT07Client`
 * + a mock `transport` + real libsodium. The mocks simulate the relevant
 * Edge Function responses faithfully (the F-02 mock actually seals nonces
 * to the posted pubkey so the unseal-callback round-trip is exercised).
 *
 * Argon2id runs at MEMLIMIT_MIN in NODE_ENV=test (see recovery-blob.ts),
 * which keeps the store/restore round-trip well under 500ms per test.
 */

import { describe, expect, it } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import {
  BrowserLocalIdentityStore,
  SupabaseT07Client,
  enrollIdentityViaProduction,
  storeRecoveryBlobViaProduction,
  restoreRecoveryBlobViaProduction,
  type T07OpTransport
} from '../../src/lib/crypto';

await _sodium.ready;
const sodium = _sodium;

function pgHexToBytes(s: string): Uint8Array {
  const stripped = s.startsWith('\\x') ? s.slice(2) : s;
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
function bytesToPgHex(b: Uint8Array): string {
  let s = '\\x';
  for (const byte of b) s += byte.toString(16).padStart(2, '0');
  return s;
}

function silentStore(): BrowserLocalIdentityStore {
  return new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
}

// ---------------------------------------------------------------------------
// enrollIdentityViaProduction — F-02 sealed-box challenge end-to-end
// ---------------------------------------------------------------------------

describe('T07.1 — enrollIdentityViaProduction', () => {
  it('runs init → unseal → finalize and persists the privkey device-side AFTER server accept', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    let serverNonce: Uint8Array | null = null;
    const transport: T07OpTransport = async (body) => {
      calls.push({ body });
      if (body.op === 'enrollment_challenge_init') {
        const pk = pgHexToBytes(body.public_key_hex as string);
        serverNonce = sodium.randombytes_buf(32);
        const sealed = sodium.crypto_box_seal(serverNonce, pk);
        return {
          status: 200,
          body: {
            ok: true,
            data: { challenge_id: 'chal-1', sealed_nonce_hex: bytesToPgHex(sealed) }
          }
        };
      }
      if (body.op === 'enrollment_challenge_finalize') {
        const observed = pgHexToBytes(body.unsealed_nonce_hex as string);
        const match =
          serverNonce !== null &&
          observed.length === serverNonce.length &&
          observed.every((b, i) => b === (serverNonce as Uint8Array)[i]);
        if (match) return { status: 200, body: { ok: true, data: 'u-test' } };
        return { status: 403, body: { ok: false, error: 'wrong_nonce' } };
      }
      throw new Error(`unexpected op ${String(body.op)}`);
    };
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const r = await enrollIdentityViaProduction({ client, user_id: 'u-test' });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.user_id).toBe('u-test');
    expect(r.public_key.length).toBe(32);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Privkey persisted device-side AFTER finalize succeeded.
    const sk = await localIdentity.getIdentityPrivateKey('u-test');
    expect(sk.length).toBe(32);
    // Sanity: the persisted privkey opens a sealed box for the returned pubkey.
    const probe = sodium.randombytes_buf(16);
    const sealed = sodium.crypto_box_seal(probe, r.public_key);
    const opened = sodium.crypto_box_seal_open(sealed, r.public_key, sk);
    expect(opened).toEqual(probe);
  });

  it('does NOT persist the privkey when the server returns a finalize error', async () => {
    let firstCallSeen = false;
    const transport: T07OpTransport = async (body) => {
      if (body.op === 'enrollment_challenge_init') {
        firstCallSeen = true;
        const pk = pgHexToBytes(body.public_key_hex as string);
        const sealed = sodium.crypto_box_seal(
          sodium.randombytes_buf(32),
          pk
        );
        return {
          status: 200,
          body: { ok: true, data: { challenge_id: 'chal-1', sealed_nonce_hex: bytesToPgHex(sealed) } }
        };
      }
      // The Edge Function rejects on finalize.
      return { status: 410, body: { ok: false, error: 'challenge_expired' } };
    };
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const r = await enrollIdentityViaProduction({ client, user_id: 'u-test' });
    expect(firstCallSeen).toBe(true);
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('challenge_expired');
    expect(r.http).toBe(410);
    await expect(localIdentity.getIdentityPrivateKey('u-test')).rejects.toThrow(/not found/);
  });

  it('surfaces init-step duplicate (caller already has identity_keys) without touching localIdentity', async () => {
    const transport: T07OpTransport = async () => ({
      status: 409,
      body: { ok: false, error: 'duplicate' }
    });
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const r = await enrollIdentityViaProduction({ client, user_id: 'u-test' });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('duplicate');
    await expect(localIdentity.getIdentityPrivateKey('u-test')).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// storeRecoveryBlobViaProduction + restoreRecoveryBlobViaProduction
// ---------------------------------------------------------------------------

describe('T07.1 — store + restore round-trip', () => {
  it('store posts a sealed envelope; restore decrypts it back to the same privkey', async () => {
    // Pre-seed a device-local privkey for the user.
    const localIdentity = silentStore();
    const trueKeypair = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey('u-test', trueKeypair.privateKey);

    // The "server" remembers what was stored so getRecoveryBlob returns it.
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
        // Audit row received — server-side success.
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
    if (stored.status !== 'ok') return;
    expect(stored.kdf_params.alg).toBe('argon2id13');
    expect(storedEnvelopeHex).not.toBeNull();

    // Now wipe the local privkey to simulate a fresh device, then restore.
    const freshDevice = silentStore();
    const freshClient = new SupabaseT07Client({ transport, localIdentity: freshDevice });
    const restored = await restoreRecoveryBlobViaProduction({
      client: freshClient,
      localIdentity: freshDevice,
      user_id: 'u-test',
      passphrase: 'a-strong-passphrase-32-chars-long',
      device_fingerprint_raw: 'demo-device-fp-2026-05-28'
    });
    expect(restored.status).toBe('ok');
    if (restored.status !== 'ok') return;
    expect(restored.private_key).toEqual(trueKeypair.privateKey);
    // Restored client persisted the privkey BEFORE posting the audit row.
    const sk = await freshDevice.getIdentityPrivateKey('u-test');
    expect(sk).toEqual(trueKeypair.privateKey);
    expect(restoredAuditPosted).toBe(true);
  });

  it('restore returns wrong_passphrase on bad passphrase + does not persist anything', async () => {
    const localIdentity = silentStore();
    const trueKeypair = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey('u-test', trueKeypair.privateKey);

    let storedEnvelopeHex: string | null = null;
    let storedKdfParams: Record<string, unknown> | null = null;
    const transport: T07OpTransport = async (body) => {
      if (body.op === 'store_recovery') {
        storedEnvelopeHex = body.blob_ciphertext_hex as string;
        storedKdfParams = body.kdf_params as Record<string, unknown>;
        return { status: 200, body: { ok: true, data: null } };
      }
      if (body.op === 'get_recovery_blob') {
        return {
          status: 200,
          body: {
            ok: true,
            data: { blob_ciphertext_hex: storedEnvelopeHex, kdf_params: storedKdfParams }
          }
        };
      }
      if (body.op === 'record_restored') {
        throw new Error('record_restored MUST NOT be posted on wrong_passphrase');
      }
      throw new Error(`unexpected op ${String(body.op)}`);
    };
    const client = new SupabaseT07Client({ transport, localIdentity });

    await storeRecoveryBlobViaProduction({
      client,
      localIdentity,
      user_id: 'u-test',
      passphrase: 'right-passphrase-with-32-characters'
    });

    const freshDevice = silentStore();
    const freshClient = new SupabaseT07Client({ transport, localIdentity: freshDevice });
    const r = await restoreRecoveryBlobViaProduction({
      client: freshClient,
      localIdentity: freshDevice,
      user_id: 'u-test',
      passphrase: 'wrong-passphrase',
      device_fingerprint_raw: 'demo-device'
    });
    expect(r.status).toBe('wrong_passphrase');
    await expect(freshDevice.getIdentityPrivateKey('u-test')).rejects.toThrow(/not found/);
  });

  it('restore returns not_found when the server has no blob on file', async () => {
    const transport: T07OpTransport = async (body) => {
      if (body.op === 'get_recovery_blob') {
        return { status: 200, body: { ok: true, data: null } };
      }
      throw new Error(`unexpected op ${String(body.op)}`);
    };
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const r = await restoreRecoveryBlobViaProduction({
      client,
      localIdentity,
      user_id: 'u-test',
      passphrase: 'anything',
      device_fingerprint_raw: 'demo-device'
    });
    expect(r.status).toBe('not_found');
  });

  it('store surfaces 409 duplicate (no recovery reset on file) as { status: failed }', async () => {
    const localIdentity = silentStore();
    await localIdentity.storeIdentityPrivateKey('u-test', sodium.crypto_box_keypair().privateKey);
    const transport: T07OpTransport = async () => ({
      status: 409,
      body: { ok: false, error: 'duplicate' }
    });
    const client = new SupabaseT07Client({ transport, localIdentity });
    const r = await storeRecoveryBlobViaProduction({
      client,
      localIdentity,
      user_id: 'u-test',
      passphrase: 'a-strong-passphrase-32-chars-long'
    });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('duplicate');
    expect(r.http).toBe(409);
  });
});
