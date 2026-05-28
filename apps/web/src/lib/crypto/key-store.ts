/**
 * KeyStore + LocalIdentityStore — split server-bound vs device-local
 * interfaces (G-T07-10).
 *
 * Per ADR-0003 Invariants 1, 3, 5, 6 + Amendment A + Amendment F:
 *   - The PRIVATE half of an identity keypair NEVER lands on the server in
 *     the clear (Invariant 1). The original T07 `KeyStore.storeIdentityKeys`
 *     contract documented this textually but accepted the full keypair —
 *     a future implementer could persist the private half against the
 *     contract. G-T07-10 resolves this by splitting the interface:
 *       - `LocalIdentityStore` — device-local; holds the private key bytes
 *         (production: IndexedDB; tests: an in-memory Map).
 *       - `KeyStore`           — server-bound; holds the public half only.
 *         The production `SupabaseKeyStore` (T07.1 increment 5)
 *         implements ONLY this interface; there is no method on it that
 *         takes or returns a private key.
 *   - The recovery blob persisted by `storeRecoveryBlob` is the ciphertext
 *     produced by `recovery-blob.ts`. The passphrase NEVER persists anywhere.
 *   - Every operation that touches key material emits one of the 9
 *     closed-enum audit events from ADR-0003 Amendment A. The
 *     `recordKeyEvent` method is the single emission path.
 *
 *   G-T07-15: `client.identity_selftest_fail` is NOT one of the 9 key-material
 *   events; it is a client-emitted operational signal (90-day retention,
 *   ADR-0015). Pre-G-T07-15 the orchestrator cast through `unknown` to
 *   smuggle the string through `recordKeyEvent`. The split adds
 *   `KeyStore.recordSelftestFail` — a separate emission path with its
 *   own typed payload that does NOT pass through the closed enum.
 *
 * Wiring:
 *   - In tests the `MemoryKeyStore` is plugged in by the harness. The same
 *     concrete class implements BOTH `KeyStore` and `LocalIdentityStore`
 *     so the harness wires a single instance into the `KeyCore`.
 *   - In production: a `SupabaseKeyStore` implements `KeyStore`; a separate
 *     `BrowserLocalIdentityStore` (T07.1 increment 5) implements
 *     `LocalIdentityStore` over IndexedDB. The orchestrator threads both.
 *
 * Source: ADR-0003 §Option A + invariants 1, 3, 5, 6; ADR-0003 Amendment A
 * (8-event audit enum + Amendment F's 9th); G-T07-10; G-T07-15.
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

/**
 * G-T07-15 — non-enum operational emission shape. Carries `client.identity_selftest_fail`
 * (and any future client-emitted non-enum signals). The structured-log
 * 90-day retention class applies; do NOT widen this to admit closed-enum
 * key-material events (those go through `recordKeyEvent`).
 */
export interface KeySelftestFailEmission {
  actor_pseudonym: string;
  meta: Record<string, unknown>;
}

/**
 * Device-local identity store. Holds the PRIVATE half of the X25519
 * identity keypair. Production: backed by IndexedDB. Tests: backed by an
 * in-memory Map on `MemoryKeyStore`. The server-bound `SupabaseKeyStore`
 * does NOT implement this interface — Invariant 1 is enforced
 * structurally.
 */
export interface LocalIdentityStore {
  /** Persist the device-local identity private key. */
  storeIdentityPrivateKey(user_id: string, private_key: Uint8Array): Promise<void>;
  /**
   * Read the device-local identity private key. Throws if no private key
   * is on file for this user — the F-02 self-test must have produced one
   * via `storeIdentityPrivateKey` first.
   */
  getIdentityPrivateKey(user_id: string): Promise<Uint8Array>;
}

export interface KeyStore {
  // -------- Identity keys (PUBLIC half only) --------
  /**
   * Persist the PUBLIC half of the identity keypair. Production
   * (`SupabaseKeyStore`) writes only the public key to the server row;
   * the private half is handled by `LocalIdentityStore` and never reaches
   * any method on this interface.
   */
  persistIdentityPublicKey(user_id: string, public_key: Uint8Array): Promise<void>;

  /**
   * Server-readable public key for the user; used to route wraps. Throws
   * if the user has no identity row yet (F-02 self-test must have run).
   */
  getIdentityPublicKey(user_id: string): Promise<Uint8Array>;

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
  /** Single audit emission path for the 9-event closed enum (8 ADR-0003 Amendment A + 1 Amendment F). */
  recordKeyEvent(event: KeyAuditEmission): Promise<void>;

  /**
   * G-T07-15 — separate emission path for the non-enum operational signal
   * `client.identity_selftest_fail`. NOT routed through the closed-enum
   * `recordKeyEvent`; the structured-log 90-day retention class applies.
   * Implementations write `event_type: 'client.identity_selftest_fail'`
   * verbatim (the SQL `audit_emit` accepts arbitrary event_type strings;
   * the closed-enum is enforced by `scripts/check-audit-enum-coverage.sh`
   * which lists this value in `EXPECTED_ENUM`).
   */
  recordSelftestFail(event: KeySelftestFailEmission): Promise<void>;

  // -------- Helpers --------
  pseudonymOf(uid: string): string;

  // -------- Rotation lock (F-04) --------
  /**
   * Per-`KeyStore` rotation lock. The in-memory store uses an atomic
   * compare-and-swap on a boolean flag; production (`SupabaseKeyStore`)
   * uses `pg_try_advisory_xact_lock` as the source of truth and treats
   * this in-memory mechanism as a redundant test-only mechanism.
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
