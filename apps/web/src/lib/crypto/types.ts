/**
 * T07 — crypto core types.
 *
 * Source obligations:
 *   - ADR-0003 invariants 1–8 (verbatim, especially 1, 3, 4, 5, 6, 8).
 *   - ADR-0003 Amendment A (closed enum of key-material audit events).
 *   - ADR-0003 Amendment F (recovery-passphrase show-again accommodation).
 *   - threat-model §3.1 F-01..F-12, §6 Invariants.
 */

export interface IdentityKeypair {
  /** X25519 public key, 32 bytes. Identity for routing committee key wraps. */
  public_key: Uint8Array;
  /**
   * X25519 private key, 32 bytes.
   *
   * Invariant 1: NEVER leaves the device unencrypted. The MemoryKeyStore
   * (test harness) carries it for self-test scaffolding only. The
   * production SQL surface NEVER persists the private key in plaintext.
   */
  private_key: Uint8Array;
}

export interface KdfParams {
  /** Argon2id ops-limit (≥ ARGON2_MIN_OPS = 4 per F-08). */
  ops: number;
  /** Argon2id mem-limit in bytes (≥ ARGON2_MIN_MEM_BYTES = 512 MiB per F-08). */
  mem_bytes: number;
  /** Algorithm identifier — Argon2id. */
  alg: 'argon2id13';
  /** Schema version for future-proofing the KDF parameter set. */
  version: 1;
}

export interface RecoveryBlobShape {
  /** Random 16-byte salt for the KDF. */
  salt: Uint8Array;
  /** Argon2id nonce for secretbox. */
  nonce: Uint8Array;
  /** Encrypted identity private key bytes. */
  ciphertext: Uint8Array;
  /** Embedded KDF parameters so the restore path can recompute the key. */
  kdf_params: KdfParams;
}

export interface CommitteeKeyMetadata {
  /** Current committee data public key id (acts as both id and key handle). */
  public_id: string;
  /** Current committee data public key bytes. */
  public_key: Uint8Array;
  /** Created at (ms epoch). */
  created_at: number;
}

export interface CommitteeKeyWrap {
  member_id: string;
  committee_key_id: string;
  wrapped_private_key: Uint8Array;
  created_at: number;
}

/**
 * Server-issued user handle. Mirrors what the AuthStore handed back from
 * `enrollFirstDevice`; the crypto core attaches an `identity` keypair
 * during T07's enrollment ceremony.
 */
export interface CryptoUser {
  user_id: string;
  identity: IdentityKeypair;
}

export type EnrollIdentityResult =
  | { status: 'ok'; public_key: Uint8Array; fingerprint: string }
  | { status: 'rejected'; reason: 'pairing_self_test_failed' };

export type StoreRecoveryBlobResult =
  | { status: 'ok'; kdf_params: KdfParams }
  | { status: 'mismatch' }
  | { status: 409 };

export type RestoreRecoveryBlobResult =
  | { status: 'ok'; identity: IdentityKeypair }
  | { status: 'not_found' }
  | { status: 'wrong_passphrase' };

export type WrapForMemberResult =
  | { status: 'ok'; committee_key_id: string }
  | { status: 'rls_denied' };

export type RotateCommitteeKeyResult =
  | { status: 200; rotation_id: string; new_key_id: string }
  | { status: 409; rotation_id?: string }
  | { status: 'aborted'; reason: string };

export type IdentitySelfTestResult = { ok: true } | { ok: false; next_action: 'recovery_flow' };

export interface ShowRecoveryAgainResult {
  /** ok=true → the caller may render the passphrase. */
  ok: boolean;
  /** Reveal-count for this enrollment session AFTER this attempt (1..3). */
  reveal_count: number;
  /** Cap reached → control should be aria-disabled, no audit row emitted. */
  cap_reached?: boolean;
  /** Audit endpoint failure mode for M-54b. */
  audit_failed?: boolean;
}

/**
 * The closed-enum key-material audit event names (Amendment A + Amendment F).
 * Per Invariant 8 every key-material mutation emits ONE of these.
 */
export const KEY_MATERIAL_AUDIT_EVENTS = [
  'identity_keypair.created',
  'identity_privkey.recovery_blob.written',
  'identity_privkey.recovery_blob.restored',
  'identity_privkey.recovery_blob.viewed',
  'committee_data_key.wrapped_for_member',
  'committee_data_key.unwrap',
  'committee_data_key.rotation.started',
  'committee_data_key.rotation.completed',
  'committee_data_key.member_revoked'
] as const;

export type KeyMaterialAuditEvent = (typeof KEY_MATERIAL_AUDIT_EVENTS)[number];
