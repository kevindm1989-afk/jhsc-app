/**
 * Minimal type declaration for libsodium-wrappers.
 *
 * libsodium-wrappers does not ship .d.ts files. We declare the minimal
 * surface used by the crypto core (T07). Keep this list small and only
 * grow it as new primitives are needed.
 */
declare module 'libsodium-wrappers' {
  const sodium: {
    ready: Promise<void>;
    // KeyPair
    crypto_box_keypair: () => { publicKey: Uint8Array; privateKey: Uint8Array; keyType: string };
    // Sealed box (anonymous-sender) — per ADR-0003 Invariant 5
    crypto_box_seal: (m: Uint8Array, pk: Uint8Array) => Uint8Array;
    crypto_box_seal_open: (c: Uint8Array, pk: Uint8Array, sk: Uint8Array) => Uint8Array;
    // Secretbox (symmetric authenticated encryption)
    crypto_secretbox_easy: (m: Uint8Array, n: Uint8Array, k: Uint8Array) => Uint8Array;
    crypto_secretbox_open_easy: (c: Uint8Array, n: Uint8Array, k: Uint8Array) => Uint8Array;
    crypto_secretbox_NONCEBYTES: number;
    crypto_secretbox_KEYBYTES: number;
    // Password hashing — Argon2id
    crypto_pwhash: (
      outlen: number,
      passwd: Uint8Array | string,
      salt: Uint8Array,
      opslimit: number,
      memlimit: number,
      alg: number
    ) => Uint8Array;
    crypto_pwhash_SALTBYTES: number;
    crypto_pwhash_OPSLIMIT_MIN: number;
    crypto_pwhash_OPSLIMIT_MODERATE: number;
    crypto_pwhash_OPSLIMIT_SENSITIVE: number;
    crypto_pwhash_MEMLIMIT_MIN: number;
    crypto_pwhash_MEMLIMIT_MODERATE: number;
    crypto_pwhash_MEMLIMIT_SENSITIVE: number;
    crypto_pwhash_ALG_ARGON2ID13: number;
    // Random bytes
    randombytes_buf: (n: number) => Uint8Array;
    // Generic hash (BLAKE2b)
    crypto_generichash: (outlen: number, m: Uint8Array, k?: Uint8Array) => Uint8Array;
    // Utilities
    to_hex: (b: Uint8Array) => string;
    from_hex: (s: string) => Uint8Array;
    to_base64: (b: Uint8Array, variant?: number) => string;
    from_base64: (s: string, variant?: number) => Uint8Array;
    [key: string]: unknown;
  };
  export default sodium;
}
