/**
 * T07 — ADR-0003 Amendment G Testable Assertion #1.
 *
 * Source obligation: `.context/decisions.md` Amendment G §Testable Assertions:
 *   "#1 — when libsodium's `crypto_pwhash` is undefined and the test override
 *    is null, `encryptRecoveryBlob` throws `Error` with message exactly
 *    `argon2id_unavailable_libsodium_wrappers_sumo_required`."
 *
 * This file is the contract-pin for the canonical error string. T07.1's
 * boot-time assertion (G-T07-12) will be looking for the exact token; a
 * refactor that changes the throw text must fail here first.
 *
 * Also exercises Testable Assertion #3 (NODE_ENV='production' guard):
 *   "Setting the flag does NOT enable the fast KDF in production builds."
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encryptRecoveryBlob,
  decryptRecoveryBlob,
  ARGON2_UNAVAILABLE_ERROR,
  __setTestOverrideUseBlake2bFallback,
} from '../../src/lib/crypto/recovery-blob';
import { generateIdentityKeypair } from '../../src/lib/crypto/identity-keys';

describe('T07 / ADR-0003 Amendment G — Argon2id fail-closed contract', () => {
  let originalOverride: (() => boolean) | null = null;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalOverride = null;
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    __setTestOverrideUseBlake2bFallback(originalOverride);
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('T07 / Amendment G Test #1 — canonical error token is exported and matches the throw', () => {
    expect(ARGON2_UNAVAILABLE_ERROR).toBe('argon2id_unavailable_libsodium_wrappers_sumo_required');
  });

  it('T07 / Amendment G Test #1 — encryptRecoveryBlob throws the canonical token when crypto_pwhash absent and override null', async () => {
    // Ensure override is null (default state).
    __setTestOverrideUseBlake2bFallback(null);
    const keypair = await generateIdentityKeypair();
    await expect(
      encryptRecoveryBlob(keypair.private_key, 'a-passphrase-the-user-types')
    ).rejects.toThrow(ARGON2_UNAVAILABLE_ERROR);
  });

  it('T07 / Amendment G Test #1 — decryptRecoveryBlob throws the canonical token on alg-mismatch when override null', async () => {
    // Construct a blob via the override path; then clear override and try to decrypt.
    __setTestOverrideUseBlake2bFallback(() => true);
    const keypair = await generateIdentityKeypair();
    const blob = await encryptRecoveryBlob(keypair.private_key, 'pass');
    __setTestOverrideUseBlake2bFallback(null);
    await expect(decryptRecoveryBlob(blob, 'pass')).rejects.toThrow(
      ARGON2_UNAVAILABLE_ERROR
    );
  });

  it('T07 / Amendment G Test #3 — in NODE_ENV=production, setting the override does NOT enable BLAKE2b', async () => {
    process.env.NODE_ENV = 'production';
    __setTestOverrideUseBlake2bFallback(() => true);
    const keypair = await generateIdentityKeypair();
    // Even with the override set, production mode forces the guard to return false,
    // and crypto_pwhash is unavailable in this libsodium build, so encrypt fails-closed.
    await expect(
      encryptRecoveryBlob(keypair.private_key, 'pass')
    ).rejects.toThrow(ARGON2_UNAVAILABLE_ERROR);
  });
});
