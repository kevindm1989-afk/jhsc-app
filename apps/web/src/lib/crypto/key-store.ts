/**
 * KeyStore — interface mirroring T05's AuthStore pattern for T07's key core.
 *
 * Per ADR-0003 invariants 1, 3, 5, 6 + Amendment A + Amendment F:
 *   - The PRIVATE half of an identity keypair NEVER lands on the server in
 *     the clear. The store's `storeIdentityKeys` method accepts a keypair
 *     but the persistence implementation MUST only persist `public_key` to
 *     the server-side row; the private key stays device-local (IndexedDB
 *     in production, in-memory in tests).
 *   - The recovery blob persisted by `storeRecoveryBlob` is the ciphertext
 *     produced by `recovery-blob.ts`. The passphrase NEVER persists anywhere.
 *   - Every operation that touches key material emits one of the 8
 *     closed-enum audit events from ADR-0003 Amendment A. The
 *     `recordKeyEvent` method is the single emission path.
 *
 * Wiring:
 *   - In tests the `MemoryKeyStore` is plugged in by the harness.
 *   - In production T07.1 lands `SupabaseKeyStore` (mirror of T05.1's
 *     `SupabaseAuthStore` split). This file ships only the interface +
 *     value-shape types — no Supabase coupling here.
 *
 * Source: ADR-0003 §Option A + invariants 1, 3, 5, 6; ADR-0003 Amendment A
 * (8-event audit enum); ADR-0003 Amendment F (recovery_blob.viewed).
 */

import type { KdfParams, KeyMaterialAuditEvent } from './types';

export interface IdentityKeysRow {
  user_id: string;
  /** X25519 public key bytes. Server-readable; used for wrap routing. */
  public_key: Uint8Array;
  /** ms epoch. */
  created_at: number;
  /** ms epoch; null until the keypair is revoked. */
  revoked_at: number | null;
}

export interface RecoveryBlobRow {
  user_id: string;
  /** secretbox ciphertext of the identity privkey. Caller-side decrypts. */
  blob_ciphertext: Uint8Array;
  /** Embedded KDF parameters so the restore path can recompute the key. */
  kdf_params: KdfParams;
  /** ms epoch. */
  created_at: number;
  /** ms epoch of the most-recent restore; null until first restore. */
  restored_at: number | null;
  /**
   * Reveal counter for the Amendment F "show again" feature. The
   * controller `recovery/show-again.ts` enforces a per-enrollment-session
   * cap of 3; this column is the server-side audit anchor (the cap is
   * client-enforced; the audit row carries `reveal_count_in_session`).
   */
  view_count: number;
}

export interface CommitteeKeyMetadataRow {
  /** uuid; doubles as the wrap routing handle. */
  key_id: string;
  /** Monotonic counter; rotation creates a new (key_id, epoch+1) row. */
  epoch: number;
  /** ms epoch. */
  created_at: number;
  /** ms epoch when this key was rotated out; null while current. */
  rotated_at: number | null;
}

export interface CommitteeKeyWrapRow {
  user_id: string;
  key_id: string;
  /** Sealed-box ciphertext only the user's identity privkey can open. */
  wrapped_ciphertext: Uint8Array;
}

export interface KeyAuditEmission {
  event_type: KeyMaterialAuditEvent;
  actor_pseudonym: string;
  meta: Record<string, unknown>;
  /**
   * Some Amendment A events carry a shared `rotation_id` to pair `.started`
   * with `.completed` and `.member_revoked`. The store assigns one if the
   * caller does not.
   */
  rotation_id?: string;
}

export interface KeyStore {
  // -------- Identity keys --------
  /**
   * Persist the identity keys for a user. The IMPLEMENTATION MUST NOT
   * persist the private half on the server side; the server row contains
   * only `public_key`. The in-memory store mirrors this contract by
   * retaining the private half in a per-store map indexed off the user_id
   * (test-only) but never threading it into the audit row or any external
   * sink. The production T07.1 implementation drops the private half on
   * the floor and writes only the public half.
   */
  storeIdentityKeys(
    user_id: string,
    keypair: {
      public_key: Uint8Array;
      private_key: Uint8Array;
    }
  ): Promise<void>;

  /**
   * Server-readable public key for the user; used to route wraps. Throws
   * if the user has no identity row yet (F-02 self-test must have run).
   */
  getIdentityPublicKey(user_id: string): Promise<Uint8Array>;

  /**
   * Test-only — yields the device-local private key. Production
   * implementations of this interface MUST throw from here. Required by
   * the F-03 IndexedDB self-test and by `unwrapForSession`.
   */
  __getIdentityPrivateKeyLocalOnly(user_id: string): Promise<Uint8Array>;

  // -------- Recovery blob --------
  storeRecoveryBlob(opts: {
    user_id: string;
    blob_ciphertext: Uint8Array;
    kdf_params: KdfParams;
  }): Promise<{ ok: true } | { ok: false; reason: 'duplicate' }>;

  getRecoveryBlob(user_id: string): Promise<RecoveryBlobRow | null>;

  /**
   * Record an Amendment F reveal. Increments view_count and emits an
   * `identity_privkey.recovery_blob.viewed` audit row with the provided
   * meta. The Amendment F controller calls this BEFORE the DOM renders
   * the passphrase (M-54b ordering contract).
   */
  recordRecoveryBlobViewed(opts: {
    user_id: string;
    actor_pseudonym: string;
    enrollment_session_id: string;
    reveal_count_in_session: number;
  }): Promise<void>;

  /**
   * Co-chair-initiated recovery reset (F-12). Once set, the next
   * `storeRecoveryBlob` succeeds even if a row already exists. The reset
   * flag is consumed by the successful store.
   */
  markRecoveryResetIssued(user_id: string): Promise<void>;

  // -------- Committee data key --------
  /**
   * Insert a new committee data key (epoch = max(epoch)+1). Returns the
   * key_id of the new row. The MemoryKeyStore additionally tracks the
   * shared symmetric data key bytes off-band (test-only) so wrap+unwrap
   * round-trip works; production stores nothing of the kind — the
   * symmetric data key lives only inside member wraps.
   */
  initCommitteeDataKey(opts: {
    actor_user_id: string;
    actor_pseudonym: string;
  }): Promise<{ key_id: string; epoch: number }>;

  getCurrentCommitteeKeyMetadata(): Promise<CommitteeKeyMetadataRow | null>;

  /** Insert a per-member wrap row. RLS-equivalent active-member check applies. */
  insertCommitteeKeyWrap(opts: {
    member_user_id: string;
    key_id: string;
    wrapped_ciphertext: Uint8Array;
  }): Promise<{ ok: true } | { ok: false; reason: 'rls_denied' }>;

  /** Return the active-epoch wrap addressed to this user. */
  getCurrentCommitteeKeyWrap(user_id: string): Promise<CommitteeKeyWrapRow | null>;

  /** Delete all wraps for a member (committee_data_key.member_revoked). */
  deleteWrapsForMember(member_user_id: string): Promise<number>;

  /** Mark a committee key as rotated out (sets rotated_at). */
  markCommitteeKeyRotated(key_id: string, now: number): Promise<void>;

  /** List all active member ids that need a re-wrap on rotation. */
  listActiveMemberIds(): Promise<string[]>;

  /** Return true if the user is an active committee member. */
  isActiveMember(user_id: string): Promise<boolean>;

  // -------- Audit --------
  /** Single audit emission path for the 8-event closed enum. */
  recordKeyEvent(event: KeyAuditEmission): Promise<void>;

  // -------- Helpers --------
  pseudonymOf(uid: string): string;

  // -------- Rotation lock (F-04) --------
  /**
   * Per-`KeyStore` rotation lock. The in-memory store uses an atomic
   * compare-and-swap on a boolean flag; production (`SupabaseKeyStore`,
   * T07.1) uses `pg_try_advisory_xact_lock` as the source of truth and
   * treats this in-memory mechanism as a redundant test-only mechanism.
   *
   * Per Amendment pass #5 Decision 3 (`.context/decisions.md`) the lock
   * MUST NOT be module-level — that would couple unrelated KeyStore
   * instances across the same JS process (vitest's process-level test
   * isolation cannot guarantee sequencing between parallel test files
   * mutating the lock). F-04 also requires the acquire-check be atomic
   * with the set-busy step so two concurrent callers cannot both observe
   * the lock as free; the interface uses `tryAcquireRotationLock` for
   * that reason rather than a get/set pair (a get/set pair would race
   * across the `await` boundary).
   */
  tryAcquireRotationLock(): Promise<boolean>;
  releaseRotationLock(): Promise<void>;
}
