/**
 * Recovery passphrase generation (T07 / ADR-0003 §Option A / F-08).
 *
 * The recovery passphrase is the only thing that unwraps the offline
 * recovery blob (see `recovery-blob.ts`). It must be:
 *   1. High-entropy (>=128 bits) so brute-force after Argon2id is infeasible.
 *   2. Transcribable off the printed sheet (design-system §4.D Surface D.5).
 *   3. Generated from a cryptographically secure source — libsodium's
 *      `randombytes_buf`, never `Math.random`.
 *
 * Format: 32 lowercase Crockford-base32 characters grouped 4-by-4 with
 * hyphens. 32 chars x 5 bits = 160 bits of entropy, above the F-08 floor
 * of 128. Crockford-base32 omits the visually-ambiguous characters
 * (i, l, o, u) so transcription off a printed sheet is robust to common
 * reading errors.
 *
 * Example: 9hbc-k73e-2pgr-mfx4-7zad-5q8w-vn3y-tj6e
 *
 * Why not word-based? Word passphrases are more memorable but require a
 * large lookup table inline. We keep the library small and dependency-
 * free by going with a fixed-alphabet base32 form. The design-system
 * §4.D printed-sheet layout is agnostic to the passphrase token shape.
 *
 * Invariant 1 holds: the entropy bytes never leave the device; the
 * caller is responsible for clearing the GeneratedPassphrase from
 * memory after writing the recovery blob.
 */

import sodium from 'libsodium-wrappers';
import { ready } from './sodium';

/** Crockford base32 alphabet — excludes i, l, o, u for transcription clarity. */
const CROCKFORD_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Default 20 bytes = 160 bits of entropy, encoded to 32 chars. */
const DEFAULT_ENTROPY_BYTES = 20;

/** Default groups of 4 characters separated by hyphens. */
const GROUP_SIZE = 4;

export interface GeneratedPassphrase {
  /** The passphrase as a hyphenated lowercase string. */
  passphrase: string;
  /** Bits of entropy this passphrase carries. */
  entropy_bits: number;
}

/**
 * Generate a fresh recovery passphrase. Default produces 32 chars /
 * 160 bits, comfortably above the F-08 >=128 bit floor.
 */
export async function generateRecoveryPassphrase(
  entropyBytes: number = DEFAULT_ENTROPY_BYTES
): Promise<GeneratedPassphrase> {
  if (entropyBytes < 16) {
    throw new Error(
      `recovery passphrase entropy must be >= 16 bytes (128 bits); got ${entropyBytes}`
    );
  }
  await ready;
  const raw: Uint8Array = sodium.randombytes_buf(entropyBytes);
  const encoded = encodeCrockfordBase32(raw);
  const grouped = groupWithHyphens(encoded, GROUP_SIZE);
  return {
    passphrase: grouped,
    entropy_bits: entropyBytes * 8
  };
}

/**
 * Encode bytes to lowercase Crockford base32. 5 bits per character.
 * 20 bytes = 160 bits = exactly 32 characters with no padding.
 */
function encodeCrockfordBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const index = (value >> bits) & 0b11111;
      out += CROCKFORD_ALPHABET[index];
    }
  }
  return out;
}

/** Group a string into hyphen-separated chunks of `size` characters. */
function groupWithHyphens(s: string, size: number): string {
  const groups: string[] = [];
  for (let i = 0; i < s.length; i += size) {
    groups.push(s.slice(i, i + size));
  }
  return groups.join('-');
}
