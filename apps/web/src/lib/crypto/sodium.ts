/**
 * libsodium-wrappers-sumo thin wrapper.
 *
 * Per ADR-0003 Invariant 4: libsodium is the ONLY cryptographic primitive
 * library in this project. The semgrep rule `no-non-libsodium-crypto`
 * (.semgrep/no-non-libsodium-crypto.yml) enforces no other module may
 * import `crypto-js`, `node-forge`, or call `crypto.subtle.*` directly
 * outside `src/lib/crypto/`.
 *
 * The `-sumo` variant (vs the standard `libsodium-wrappers`) is required
 * because the recovery-blob path uses `crypto_pwhash` (Argon2id) which
 * the standard build omits — see ADR-0003 Amendment G + G-T07-12.
 *
 * The wrapper exposes:
 *   - `ready()` — awaits libsodium WASM init.
 *
 * libsodium-wrappers-sumo ships without type declarations; we declare
 * the minimal surface here (see adjacent libsodium-wrappers-sumo.d.ts).
 */
import _sodium from 'libsodium-wrappers-sumo';

let initialized = false;

export async function ready(): Promise<typeof _sodium> {
  if (!initialized) {
    await _sodium.ready;
    initialized = true;
  }
  return _sodium;
}

export type Sodium = typeof _sodium;
