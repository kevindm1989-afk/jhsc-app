/**
 * T07 — ADR-0003 Amendment G Testable Assertions #1 + #3 — post G-T07-12.
 *
 * After the libsodium-wrappers → libsodium-wrappers-sumo dep swap, the
 * `-sumo` build exposes `crypto_pwhash` so the recovery-blob round-trip path
 * is no longer dead code at runtime. The fail-closed guard remains as
 * defense-in-depth: a future revert to the non-sumo build (or a deployment
 * that mis-resolves the dep) must still throw the canonical token, never
 * silently degrade to a different KDF.
 *
 * We exercise the guard by stubbing the `./sodium` module via `vi.mock` so
 * `ready()` returns a sodium-shaped object whose `crypto_pwhash` is
 * undefined — i.e. the exact world the standard libsodium-wrappers build
 * presented before the swap. The canonical error string itself is asserted
 * verbatim so the boot-time assertion can keep matching on it.
 *
 * Test #4 below adds a positive-path assertion that
 * `assertArgon2idAvailable()` resolves under the real `-sumo` build.
 */

import _sodium from 'libsodium-wrappers-sumo';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('T07 / ADR-0003 Amendment G — Argon2id fail-closed contract (post-sumo swap)', () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    vi.doUnmock('../../src/lib/crypto/sodium');
    vi.resetModules();
  });

  it('T07 / Amendment G Test #1 — canonical error token is exported and matches the throw', async () => {
    const { ARGON2_UNAVAILABLE_ERROR } = await import('../../src/lib/crypto/recovery-blob');
    expect(ARGON2_UNAVAILABLE_ERROR).toBe('argon2id_unavailable_libsodium_wrappers_sumo_required');
  });

  it('T07 / Amendment G Test #1 — encryptRecoveryBlob throws when crypto_pwhash is absent and override null', async () => {
    // Stub `./sodium`'s ready() to mimic the pre-swap (non-sumo) world.
    vi.doMock('../../src/lib/crypto/sodium', async () => {
      await _sodium.ready;
      const stub: Record<string, unknown> = { ..._sodium };
      delete stub.crypto_pwhash;
      return { ready: async () => stub, type: undefined as unknown };
    });
    const recovery = await import('../../src/lib/crypto/recovery-blob');
    const ids = await import('../../src/lib/crypto/identity-keys');
    recovery.__setTestOverrideUseBlake2bFallback(null);
    const kp = await ids.generateIdentityKeypair();
    await expect(recovery.encryptRecoveryBlob(kp.private_key, 'a-passphrase')).rejects.toThrow(
      recovery.ARGON2_UNAVAILABLE_ERROR
    );
  });

  it('T07 / Amendment G Test #1 — decryptRecoveryBlob throws on alg-mismatch when override null', async () => {
    // Round-trip a blob via the override (BLAKE2b) path under a stubbed
    // sodium that lacks crypto_pwhash; then clear the override and assert
    // decrypt throws the canonical token (alg-vs-runtime mismatch).
    vi.doMock('../../src/lib/crypto/sodium', async () => {
      await _sodium.ready;
      const stub: Record<string, unknown> = { ..._sodium };
      delete stub.crypto_pwhash;
      return { ready: async () => stub, type: undefined as unknown };
    });
    const recovery = await import('../../src/lib/crypto/recovery-blob');
    const ids = await import('../../src/lib/crypto/identity-keys');
    recovery.__setTestOverrideUseBlake2bFallback(() => true);
    const kp = await ids.generateIdentityKeypair();
    const blob = await recovery.encryptRecoveryBlob(kp.private_key, 'pass');
    recovery.__setTestOverrideUseBlake2bFallback(null);
    await expect(recovery.decryptRecoveryBlob(blob, 'pass')).rejects.toThrow(
      recovery.ARGON2_UNAVAILABLE_ERROR
    );
  });

  it('T07 / Amendment G Test #3 — in NODE_ENV=production, setting the override does NOT enable BLAKE2b', async () => {
    vi.doMock('../../src/lib/crypto/sodium', async () => {
      await _sodium.ready;
      const stub: Record<string, unknown> = { ..._sodium };
      delete stub.crypto_pwhash;
      return { ready: async () => stub, type: undefined as unknown };
    });
    process.env.NODE_ENV = 'production';
    const recovery = await import('../../src/lib/crypto/recovery-blob');
    const ids = await import('../../src/lib/crypto/identity-keys');
    recovery.__setTestOverrideUseBlake2bFallback(() => true);
    const kp = await ids.generateIdentityKeypair();
    await expect(recovery.encryptRecoveryBlob(kp.private_key, 'pass')).rejects.toThrow(
      recovery.ARGON2_UNAVAILABLE_ERROR
    );
  });

  it('G-T07-12 — assertArgon2idAvailable resolves under the real -sumo build', async () => {
    const recovery = await import('../../src/lib/crypto/recovery-blob');
    await expect(recovery.assertArgon2idAvailable()).resolves.toBeUndefined();
  });

  it('G-T07-12 — assertArgon2idAvailable resolves silently in NODE_ENV=test even if crypto_pwhash is stubbed absent', async () => {
    vi.doMock('../../src/lib/crypto/sodium', async () => {
      await _sodium.ready;
      const stub: Record<string, unknown> = { ..._sodium };
      delete stub.crypto_pwhash;
      return { ready: async () => stub, type: undefined as unknown };
    });
    process.env.NODE_ENV = 'test';
    const recovery = await import('../../src/lib/crypto/recovery-blob');
    await expect(recovery.assertArgon2idAvailable()).resolves.toBeUndefined();
  });

  it('G-T07-12 — assertArgon2idAvailable throws in NODE_ENV=production when crypto_pwhash is absent', async () => {
    vi.doMock('../../src/lib/crypto/sodium', async () => {
      await _sodium.ready;
      const stub: Record<string, unknown> = { ..._sodium };
      delete stub.crypto_pwhash;
      return { ready: async () => stub, type: undefined as unknown };
    });
    process.env.NODE_ENV = 'production';
    const recovery = await import('../../src/lib/crypto/recovery-blob');
    await expect(recovery.assertArgon2idAvailable()).rejects.toThrow(
      recovery.ARGON2_UNAVAILABLE_ERROR
    );
  });
});
