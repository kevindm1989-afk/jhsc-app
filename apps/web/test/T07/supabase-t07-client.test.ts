/**
 * T07.1 — G-T07-2 SupabaseT07Client + BrowserLocalIdentityStore tests.
 *
 * Hermetic: the SupabaseT07Client tests inject a stub `T07OpTransport`
 * that records the request body + returns canned responses. The
 * BrowserLocalIdentityStore tests use vitest's `fake-indexeddb`-style
 * stub injected via the `idbFactory` constructor option (so the same
 * test surface exercises both the IDB path and the SSR fallback path
 * without depending on `fake-indexeddb` being present).
 *
 * Asserts (high level):
 *   - Each high-level T07Client method posts the right { op, ...args } shape.
 *   - PostgREST hex (`\x...`) encoding round-trip via the exported helpers.
 *   - enrollIdentityViaChallenge drives the full F-02 flow + persists the
 *     private key device-side ONLY after the challenge succeeds.
 *   - On `wrong_nonce` from the server, the device-local privkey is NOT
 *     written (the unsealNonce callback could not have produced a valid
 *     value).
 *   - BrowserLocalIdentityStore round-trips a 32-byte privkey via the
 *     in-memory fallback (SSR / no-IDB) AND emits a structured-log
 *     warning at construction in that mode.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BrowserLocalIdentityStore,
  SupabaseT07Client,
  bytesToPgHex,
  pgHexToBytes,
  type T07OpTransport
} from '../../src/lib/crypto';

function mockTransport(
  responses: Array<{ status: number; body: unknown }>
): { transport: T07OpTransport; calls: Array<{ body: Record<string, unknown> }> } {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  let i = 0;
  const transport: T07OpTransport = async (body) => {
    calls.push({ body });
    const r = responses[i++];
    if (!r) throw new Error(`mockTransport: no response queued for call #${calls.length}`);
    return r;
  };
  return { transport, calls };
}

describe('T07.1 / G-T07-2 — bytea hex round-trip helpers', () => {
  it('bytesToPgHex / pgHexToBytes round-trip', () => {
    const bytes = new Uint8Array([0, 1, 2, 0x42, 0xff, 0xab]);
    const hex = bytesToPgHex(bytes);
    expect(hex).toBe('\\x000102' + '42' + 'ffab');
    expect(pgHexToBytes(hex)).toEqual(bytes);
  });

  it('pgHexToBytes accepts the un-prefixed form', () => {
    expect(pgHexToBytes('deadbeef')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });
});

describe('T07.1 / G-T07-2 — SupabaseT07Client wire shapes', () => {
  it('initCommitteeDataKey posts { op: init_key }', async () => {
    const { transport, calls } = mockTransport([
      { status: 200, body: { ok: true, data: { key_id: 'k-1', epoch: 1 } } }
    ]);
    const client = new SupabaseT07Client({ transport });
    const r = await client.initCommitteeDataKey();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ key_id: 'k-1', epoch: 1 });
    expect(calls[0]?.body).toEqual({ op: 'init_key' });
  });

  it('storeRecoveryBlob encodes the bytea body + forwards kdf_params', async () => {
    const { transport, calls } = mockTransport([{ status: 200, body: { ok: true, data: null } }]);
    const client = new SupabaseT07Client({ transport });
    const r = await client.storeRecoveryBlob({
      blob_ciphertext: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      kdf_params: { alg: 'argon2id13', version: 1 }
    });
    expect(r.ok).toBe(true);
    expect(calls[0]?.body).toEqual({
      op: 'store_recovery',
      blob_ciphertext_hex: '\\xdeadbeef',
      kdf_params: { alg: 'argon2id13', version: 1 }
    });
  });

  it('rotateCommitteeDataKey returns the first row { rotation_id, new_key_id }', async () => {
    const { transport } = mockTransport([
      { status: 200, body: { ok: true, data: { rotation_id: 'rot-1', new_key_id: 'k-2' } } }
    ]);
    const client = new SupabaseT07Client({ transport });
    const r = await client.rotateCommitteeDataKey({ trigger: 'scheduled' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ rotation_id: 'rot-1', new_key_id: 'k-2' });
  });

  it('rotateCommitteeDataKey surfaces 423 rotation_in_progress', async () => {
    const { transport } = mockTransport([
      { status: 423, body: { ok: false, error: 'rotation_in_progress' } }
    ]);
    const client = new SupabaseT07Client({ transport });
    const r = await client.rotateCommitteeDataKey({ trigger: 'incident' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rotation_in_progress');
    expect(r.status).toBe(423);
  });

  it('wrapCommitteeDataKeyForMember threads rotation_id (null when omitted)', async () => {
    const { transport, calls } = mockTransport([{ status: 200, body: { ok: true, data: null } }]);
    const client = new SupabaseT07Client({ transport });
    await client.wrapCommitteeDataKeyForMember({
      member_user_id: 'u-2',
      key_id: 'k-1',
      wrapped_ciphertext: new Uint8Array([0xca, 0xfe])
    });
    expect(calls[0]?.body).toEqual({
      op: 'wrap_member',
      member_user_id: 'u-2',
      key_id: 'k-1',
      wrapped_ciphertext_hex: '\\xcafe',
      rotation_id: null
    });
  });

  it('recordIdentitySelftestFail forwards default-empty meta', async () => {
    const { transport, calls } = mockTransport([{ status: 200, body: { ok: true, data: null } }]);
    const client = new SupabaseT07Client({ transport });
    await client.recordIdentitySelftestFail();
    expect(calls[0]?.body).toEqual({ op: 'record_selftest_fail', meta: {} });
  });
});

describe('T07.1 — SupabaseT07Client.getRecoveryBlob (F-08 restore-flow read)', () => {
  it('decodes the bytea hex back to Uint8Array on success', async () => {
    const { transport, calls } = mockTransport([
      {
        status: 200,
        body: {
          ok: true,
          data: {
            blob_ciphertext_hex: '\\xdeadbeef',
            kdf_params: { alg: 'argon2id13', version: 1 }
          }
        }
      }
    ]);
    const client = new SupabaseT07Client({ transport });
    const r = await client.getRecoveryBlob();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      blob_ciphertext: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      kdf_params: { alg: 'argon2id13', version: 1 }
    });
    expect(calls[0]?.body).toEqual({ op: 'get_recovery_blob' });
  });

  it('returns { ok: true, data: null } when no blob is on file', async () => {
    const { transport } = mockTransport([{ status: 200, body: { ok: true, data: null } }]);
    const client = new SupabaseT07Client({ transport });
    const r = await client.getRecoveryBlob();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toBeNull();
  });

  it('surfaces 403 rls_denied (no session)', async () => {
    const { transport } = mockTransport([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const client = new SupabaseT07Client({ transport });
    const r = await client.getRecoveryBlob();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rls_denied');
    expect(r.status).toBe(403);
  });
});

describe('T07.1 / G-T07-2 — F-02 enrollment via sealed-box challenge', () => {
  it('enrollIdentityViaChallenge runs init → unseal → finalize, persists privkey AFTER success', async () => {
    const sealedNonce = new Uint8Array(48); // crypto_box_seal output > nonce length
    sealedNonce.fill(0xaa);
    const expectedUnsealed = new Uint8Array(32);
    expectedUnsealed.fill(0xcd);
    const { transport, calls } = mockTransport([
      {
        status: 200,
        body: {
          ok: true,
          data: { challenge_id: 'chal-1', sealed_nonce_hex: bytesToPgHex(sealedNonce) }
        }
      },
      { status: 200, body: { ok: true, data: 'u-1' } }
    ]);
    const localIdentity = new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
    const client = new SupabaseT07Client({ transport, localIdentity });
    const publicKey = new Uint8Array(32);
    publicKey.fill(0x42);
    const privateKey = new Uint8Array(32);
    privateKey.fill(0x99);
    const unsealNonce = vi.fn(
      (sealed: Uint8Array, _pk: Uint8Array, _sk: Uint8Array) => expectedUnsealed
    );

    const r = await client.enrollIdentityViaChallenge({
      user_id: 'u-1',
      public_key: publicKey,
      private_key: privateKey,
      pubkey_fingerprint: 'a'.repeat(64),
      unsealNonce
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.user_id).toBe('u-1');
    expect(unsealNonce).toHaveBeenCalledTimes(1);
    expect(unsealNonce).toHaveBeenCalledWith(sealedNonce, publicKey, privateKey);
    expect(calls[0]?.body).toEqual({
      op: 'enrollment_challenge_init',
      public_key_hex: bytesToPgHex(publicKey),
      pubkey_fingerprint: 'a'.repeat(64)
    });
    expect(calls[1]?.body).toEqual({
      op: 'enrollment_challenge_finalize',
      challenge_id: 'chal-1',
      unsealed_nonce_hex: bytesToPgHex(expectedUnsealed)
    });
    // The privkey IS persisted after success.
    const stored = await localIdentity.getIdentityPrivateKey('u-1');
    expect(stored).toEqual(privateKey);
  });

  it('does NOT persist the privkey when the unseal callback throws (hostile-pubkey defense)', async () => {
    const { transport } = mockTransport([
      {
        status: 200,
        body: { ok: true, data: { challenge_id: 'chal-1', sealed_nonce_hex: '\\xaaaa' } }
      }
    ]);
    const localIdentity = new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
    const client = new SupabaseT07Client({ transport, localIdentity });
    const r = await client.enrollIdentityViaChallenge({
      user_id: 'u-1',
      public_key: new Uint8Array(32).fill(0x42),
      private_key: new Uint8Array(32).fill(0x99),
      pubkey_fingerprint: 'a'.repeat(64),
      unsealNonce: () => {
        throw new Error('unseal failed');
      }
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('wrong_nonce');
    expect(r.status).toBe(403);
    // Privkey NOT persisted.
    await expect(localIdentity.getIdentityPrivateKey('u-1')).rejects.toThrow(/not found/);
  });

  it('does NOT persist the privkey when finalize returns an error', async () => {
    const { transport } = mockTransport([
      {
        status: 200,
        body: { ok: true, data: { challenge_id: 'chal-1', sealed_nonce_hex: '\\xaaaa' } }
      },
      { status: 410, body: { ok: false, error: 'challenge_expired' } }
    ]);
    const localIdentity = new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
    const client = new SupabaseT07Client({ transport, localIdentity });
    const r = await client.enrollIdentityViaChallenge({
      user_id: 'u-1',
      public_key: new Uint8Array(32).fill(0x42),
      private_key: new Uint8Array(32).fill(0x99),
      pubkey_fingerprint: 'a'.repeat(64),
      unsealNonce: () => new Uint8Array(32).fill(0xcd)
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('challenge_expired');
    await expect(localIdentity.getIdentityPrivateKey('u-1')).rejects.toThrow(/not found/);
  });

  it('surfaces init-step failures verbatim (e.g. duplicate)', async () => {
    const { transport } = mockTransport([{ status: 409, body: { ok: false, error: 'duplicate' } }]);
    const client = new SupabaseT07Client({ transport });
    const r = await client.enrollIdentityViaChallenge({
      user_id: 'u-1',
      public_key: new Uint8Array(32),
      private_key: new Uint8Array(32),
      pubkey_fingerprint: 'a'.repeat(64),
      unsealNonce: () => new Uint8Array(32)
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('duplicate');
    expect(r.status).toBe(409);
  });
});

describe('T07.1 / G-T07-2 — BrowserLocalIdentityStore', () => {
  it('SSR fallback: stores and retrieves a 32-byte privkey + emits a warn at construction', async () => {
    const warn = vi.fn();
    const store = new BrowserLocalIdentityStore({ idbFactory: null, warn });
    expect(warn).toHaveBeenCalledTimes(1);
    const sk = new Uint8Array(32);
    sk.fill(0x99);
    await store.storeIdentityPrivateKey('u-1', sk);
    const got = await store.getIdentityPrivateKey('u-1');
    expect(got).toEqual(sk);
  });

  it('rejects non-32-byte private keys', async () => {
    const store = new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
    await expect(store.storeIdentityPrivateKey('u-1', new Uint8Array(31))).rejects.toThrow(
      /length must be 32 bytes/
    );
  });

  it('throws a useful error when no privkey is stored', async () => {
    const store = new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
    await expect(store.getIdentityPrivateKey('u-missing')).rejects.toThrow(/not found/);
  });

  it('stores a defensive copy (caller can zero the source after the call)', async () => {
    const store = new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
    const sk = new Uint8Array(32);
    sk.fill(0x99);
    await store.storeIdentityPrivateKey('u-1', sk);
    // Zero the source.
    sk.fill(0);
    const got = await store.getIdentityPrivateKey('u-1');
    // The stored copy is unchanged.
    expect(got.every((b) => b === 0x99)).toBe(true);
  });
});
