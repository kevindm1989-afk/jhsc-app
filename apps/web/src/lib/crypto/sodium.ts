/**
 * libsodium-wrappers thin wrapper.
 *
 * Per ADR-0003 Invariant 4: libsodium is the ONLY cryptographic primitive
 * library in this project. The semgrep rule `no-non-libsodium-crypto`
 * (.semgrep/no-non-libsodium-crypto.yml) enforces no other module may
 * import `crypto-js`, `node-forge`, or call `crypto.subtle.*` directly
 * outside `src/lib/crypto/`.
 *
 * The wrapper exposes:
 *   - `ready()` — awaits libsodium WASM init.
 *
 * The implementer of T07 builds the higher-level key-core module
 * (src/lib/crypto/index.ts) on top of this wrapper.
 *
 * libsodium-wrappers ships without type declarations; we declare the
 * minimal surface here (see adjacent libsodium-wrappers.d.ts).
 */
import _sodium from 'libsodium-wrappers';

let initialized = false;

export async function ready(): Promise<typeof _sodium> {
  if (!initialized) {
    await _sodium.ready;
    initialized = true;
  }
  return _sodium;
}

export type Sodium = typeof _sodium;
