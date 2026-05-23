/**
 * In-memory implementation of KeyStore for the Vitest harness.
 *
 * Mirrors the SQL semantics that ship in `supabase/migrations/
 * 00000000000002_identity.sql` for the surface the T07 tests exercise.
 *
 * Determinism: every mutation is synchronous on the JS event loop. No
 * concurrent mutators in tests (vitest singleThread).
 *
 * Pseudonymisation: HMAC-SHA-256 keyed by a per-store random key. Same
 * approach as `MemoryAuthStore` from T05 (ADR-0016 §Decision 1). The
 * test-harness key never leaves the process.
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type {
  CommitteeKeyMetadataRow,
  CommitteeKeyWrapRow,
  IdentityKeysRow,
  KeyAuditEmission,
  KeyStore,
  RecoveryBlobRow
} from './key-store';
import type { KdfParams, KeyMaterialAuditEvent } from './types';

interface AuditRow {
  id: number;
  ts: string;
  event_type: KeyMaterialAuditEvent;
  actor_pseudonym: string;
  rotation_id: string | null;
  meta: Record<string, unknown>;
}

export class MemoryKeyStore implements KeyStore {
  // public-half + revoke metadata; the private half lives in a separate map
  // strictly to support the on-device F-03 self-test + unwrap round-trip
  // during tests. NEVER threaded into audit rows or external sinks.
  private identityRows = new Map<string, IdentityKeysRow>();
  private identityPrivateKeysDeviceLocal = new Map<string, Uint8Array>();

  private recoveryBlobs = new Map<string, RecoveryBlobRow>();
  private recoveryResetIssued = new Set<string>();

  private committeeKeyMetaByKeyId = new Map<string, CommitteeKeyMetadataRow>();
  /** Currently-active committee key id (null before initCommitteeDataKey). */
  private currentCommitteeKeyId: string | null = null;
  private epochCounter = 0;
  /**
   * Test-only — the cleartext symmetric data key, indexed by key_id. In
   * production NO such map exists; the data key lives only inside
   * sealed-box wraps for active members. Tests need it so wrap/unwrap
   * round-trips succeed without a real X25519 transport.
   */
  private dataKeyBytesByKeyIdTestOnly = new Map<string, Uint8Array>();

  private wrapsByUserAndKey = new Map<string, CommitteeKeyWrapRow>(); // key: user_id|key_id

  private activeMembers = new Set<string>();

  private auditRows: AuditRow[] = [];
  private auditSeq = 0;

  /**
   * Per-instance F-04 rotation lock. Per Amendment pass #5 Decision 3
   * (`.context/decisions.md`) the lock MUST be scoped to a single
   * `KeyStore` instance — a module-level lock couples unrelated stores
   * across the JS process. SQL-side `pg_try_advisory_xact_lock` is the
   * production source of truth (lands in T07.1).
   */
  private rotationLockBusy = false;

  private hmacKey: Buffer;
  private nowProvider: () => number;

  constructor(nowProvider: () => number = Date.now, hmacKey?: Buffer) {
    // Allow callers (the test harness) to share an HMAC key with the
    // AuthStore so pseudonyms stay equal across the two stores. ADR-0016
    // §Decision 1 — "same key, same algorithm, same surface".
    this.hmacKey = hmacKey ?? randomBytes(32);
    this.nowProvider = nowProvider;
  }

  // -------------------------------------------------------------------
  // Pseudonym — HMAC-SHA-256 keyed (ADR-0016 §Decision 1)
  // -------------------------------------------------------------------
  pseudonymOf(uid: string): string {
    return createHmac('sha256', this.hmacKey).update(uid).digest('hex').slice(0, 16);
  }

  // -------------------------------------------------------------------
  // Identity keys
  // -------------------------------------------------------------------
  async storeIdentityKeys(
    user_id: string,
    keypair: { public_key: Uint8Array; private_key: Uint8Array }
  ): Promise<void> {
    // The server-shaped row carries the public half only — mirrors the
    // SQL `identity_keys.public_key` column. The private half is held in
    // a separate device-local map so the test surface can do the F-03
    // self-test and the unwrap round-trip without breaking Invariant 1.
    this.identityRows.set(user_id, {
      user_id,
      public_key: new Uint8Array(keypair.public_key),
      created_at: this.nowProvider(),
      revoked_at: null
    });
    this.identityPrivateKeysDeviceLocal.set(user_id, new Uint8Array(keypair.private_key));
  }

  async getIdentityPublicKey(user_id: string): Promise<Uint8Array> {
    const row = this.identityRows.get(user_id);
    if (!row) {
      throw new Error(`MemoryKeyStore: identity public key not found for ${user_id}`);
    }
    return row.public_key;
  }

  async __getIdentityPrivateKeyLocalOnly(user_id: string): Promise<Uint8Array> {
    const sk = this.identityPrivateKeysDeviceLocal.get(user_id);
    if (!sk) {
      throw new Error(
        `MemoryKeyStore: device-local private key not found for ${user_id}` +
          ' (F-03 self-test or unwrap path called before enrollment).'
      );
    }
    return sk;
  }

  // -------------------------------------------------------------------
  // Recovery blob (F-08, F-12)
  // -------------------------------------------------------------------
  async storeRecoveryBlob(opts: {
    user_id: string;
    blob_ciphertext: Uint8Array;
    kdf_params: KdfParams;
  }): Promise<{ ok: true } | { ok: false; reason: 'duplicate' }> {
    const existing = this.recoveryBlobs.get(opts.user_id);
    if (existing && !this.recoveryResetIssued.has(opts.user_id)) {
      return { ok: false, reason: 'duplicate' };
    }
    // Reset consumed by this successful store.
    this.recoveryResetIssued.delete(opts.user_id);
    this.recoveryBlobs.set(opts.user_id, {
      user_id: opts.user_id,
      blob_ciphertext: new Uint8Array(opts.blob_ciphertext),
      kdf_params: { ...opts.kdf_params },
      created_at: this.nowProvider(),
      restored_at: null,
      view_count: 0
    });
    return { ok: true };
  }

  async getRecoveryBlob(user_id: string): Promise<RecoveryBlobRow | null> {
    return this.recoveryBlobs.get(user_id) ?? null;
  }

  async recordRecoveryBlobViewed(opts: {
    user_id: string;
    actor_pseudonym: string;
    enrollment_session_id: string;
    reveal_count_in_session: number;
  }): Promise<void> {
    const row = this.recoveryBlobs.get(opts.user_id);
    if (row) {
      row.view_count += 1;
    }
    await this.recordKeyEvent({
      event_type: 'identity_privkey.recovery_blob.viewed',
      actor_pseudonym: opts.actor_pseudonym,
      meta: {
        actor_id: opts.user_id,
        enrollment_session_id: opts.enrollment_session_id,
        reveal_count_in_session: opts.reveal_count_in_session
      }
    });
  }

  async markRecoveryResetIssued(user_id: string): Promise<void> {
    this.recoveryResetIssued.add(user_id);
  }

  // -------------------------------------------------------------------
  // Committee data key
  // -------------------------------------------------------------------
  async initCommitteeDataKey(opts: {
    actor_user_id: string;
    actor_pseudonym: string;
    // The test harness passes the freshly-generated symmetric data key
    // through `__testSetDataKeyBytes` immediately after this call.
  }): Promise<{ key_id: string; epoch: number }> {
    this.epochCounter += 1;
    const key_id = randomUUID();
    const row: CommitteeKeyMetadataRow = {
      key_id,
      epoch: this.epochCounter,
      created_at: this.nowProvider(),
      rotated_at: null
    };
    this.committeeKeyMetaByKeyId.set(key_id, row);
    this.currentCommitteeKeyId = key_id;
    // The actor is implicitly an active member (you cannot init a key
    // unless you are one).
    this.activeMembers.add(opts.actor_user_id);
    return { key_id, epoch: row.epoch };
  }

  async getCurrentCommitteeKeyMetadata(): Promise<CommitteeKeyMetadataRow | null> {
    if (!this.currentCommitteeKeyId) return null;
    return this.committeeKeyMetaByKeyId.get(this.currentCommitteeKeyId) ?? null;
  }

  async insertCommitteeKeyWrap(opts: {
    member_user_id: string;
    key_id: string;
    wrapped_ciphertext: Uint8Array;
  }): Promise<{ ok: true } | { ok: false; reason: 'rls_denied' }> {
    // RLS-equivalent active-member check (F-01).
    if (!this.activeMembers.has(opts.member_user_id)) {
      return { ok: false, reason: 'rls_denied' };
    }
    if (!this.committeeKeyMetaByKeyId.has(opts.key_id)) {
      return { ok: false, reason: 'rls_denied' };
    }
    this.wrapsByUserAndKey.set(`${opts.member_user_id}|${opts.key_id}`, {
      user_id: opts.member_user_id,
      key_id: opts.key_id,
      wrapped_ciphertext: new Uint8Array(opts.wrapped_ciphertext)
    });
    return { ok: true };
  }

  async getCurrentCommitteeKeyWrap(user_id: string): Promise<CommitteeKeyWrapRow | null> {
    if (!this.currentCommitteeKeyId) return null;
    return this.wrapsByUserAndKey.get(`${user_id}|${this.currentCommitteeKeyId}`) ?? null;
  }

  async deleteWrapsForMember(member_user_id: string): Promise<number> {
    let removed = 0;
    for (const key of [...this.wrapsByUserAndKey.keys()]) {
      if (key.startsWith(`${member_user_id}|`)) {
        this.wrapsByUserAndKey.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async markCommitteeKeyRotated(key_id: string, now: number): Promise<void> {
    const row = this.committeeKeyMetaByKeyId.get(key_id);
    if (row) row.rotated_at = now;
  }

  async listActiveMemberIds(): Promise<string[]> {
    return [...this.activeMembers];
  }

  async isActiveMember(user_id: string): Promise<boolean> {
    return this.activeMembers.has(user_id);
  }

  // -------------------------------------------------------------------
  // Rotation lock (F-04) — per Amendment pass #5 Decision 3
  // -------------------------------------------------------------------
  /**
   * Atomic check-and-set on the in-memory rotation lock. The two reads /
   * writes are sequenced on the JS event loop with no interleaving await
   * boundary, so two concurrent invocations cannot both return true.
   * Production `SupabaseKeyStore` (T07.1) implements this via
   * `pg_try_advisory_xact_lock` which provides the same contract at the
   * database layer.
   */
  async tryAcquireRotationLock(): Promise<boolean> {
    if (this.rotationLockBusy) return false;
    this.rotationLockBusy = true;
    return true;
  }

  async releaseRotationLock(): Promise<void> {
    this.rotationLockBusy = false;
  }

  // -------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------
  async recordKeyEvent(event: KeyAuditEmission): Promise<void> {
    this.auditSeq += 1;
    this.auditRows.push({
      id: this.auditSeq,
      ts: new Date(this.nowProvider()).toISOString(),
      event_type: event.event_type,
      actor_pseudonym: event.actor_pseudonym,
      rotation_id: event.rotation_id ?? null,
      meta: event.meta
    });
  }

  // -------------------------------------------------------------------
  // Test-only — used by the harness
  // -------------------------------------------------------------------
  __setActiveMember(user_id: string, active: boolean): void {
    if (active) this.activeMembers.add(user_id);
    else this.activeMembers.delete(user_id);
  }

  __setDataKeyBytesForKeyId(key_id: string, bytes: Uint8Array): void {
    this.dataKeyBytesByKeyIdTestOnly.set(key_id, new Uint8Array(bytes));
  }

  __getDataKeyBytesForKeyId(key_id: string): Uint8Array | null {
    return this.dataKeyBytesByKeyIdTestOnly.get(key_id) ?? null;
  }

  __debugAuditRows(): readonly AuditRow[] {
    return this.auditRows;
  }

  __debugCommitteeMeta(): readonly CommitteeKeyMetadataRow[] {
    return [...this.committeeKeyMetaByKeyId.values()];
  }

  __debugWraps(): readonly CommitteeKeyWrapRow[] {
    return [...this.wrapsByUserAndKey.values()];
  }
}
