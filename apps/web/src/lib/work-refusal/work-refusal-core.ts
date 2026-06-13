/**
 * Work-refusal operations (T14).
 *
 * Per ADR-0002 Amendment H this is library code. The store is injected
 * — `MemoryWorkRefusalStore` in tests, `SupabaseWorkRefusalStore`
 * (T14.1) in production.
 *
 * Operations exposed:
 *   - `submitWorkRefusal`     — encrypt + insert + audit (F-21)
 *   - `readWorkRefusalEntry`  — audit-emit-then-decrypt (HG-6 mirror;
 *                                Amendment A extension)
 *   - `listWorkRefusalFeed`   — pseudonymized projection
 *                                (Amendment D extension)
 *
 * Source: ADR-0003 Amendments A extension / B / D extension +
 * observability/audit-log.md + threat-model §3.4 F-21.
 */

import { hmacSha256 } from '../crypto/hash';
import { ready } from '../crypto/sodium';
import type { WorkRefusalStore } from './work-refusal-store';
import type { WorkRefusalEntry, WorkRefusalIntake, WorkRefusalListItem } from './types';

export interface WorkRefusalCoreOpts {
  store: WorkRefusalStore;
  /**
   * Symmetric committee data key. Per ADR-0003 Invariant 1, the key
   * NEVER leaves the device's memory.
   */
  committeeKeyBytes: Uint8Array;
  /** ms-epoch clock. */
  now: () => number;
}

export interface SubmitWorkRefusalOk {
  ok: true;
  id: string;
}

export interface SubmitWorkRefusalDenied {
  ok: false;
  reason: 'rls_denied' | 'rate_limited';
  status: 403 | 429;
  body: Record<string, unknown>;
}

export type SubmitWorkRefusalResult = SubmitWorkRefusalOk | SubmitWorkRefusalDenied;

export interface ReadWorkRefusalOk {
  ok: true;
  /** Decrypted notes (s.43 narrative). */
  notes_plaintext: string;
  title_plaintext: string;
  /** ms-epoch the plaintext was returned (strictly > the audit-row ts). */
  received_at_ts: number;
  /** ms-epoch shim of the wrapping transaction (matches the audit row ts). */
  transaction_ts_ms: number;
  row: WorkRefusalEntry;
}

export interface ReadWorkRefusalDenied {
  ok: false;
  reason: 'not_found' | 'audit_failed' | 'not_authorized';
}

// ---------------------------------------------------------------------------
// Internal helpers (libsodium-wrappers secretbox sealing).
// ---------------------------------------------------------------------------

async function sealUtf8(plaintext: string, key: Uint8Array): Promise<Uint8Array> {
  const s = await ready();
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ptBytes = new Uint8Array(Buffer.from(plaintext, 'utf8'));
  const ct = s.crypto_secretbox_easy(ptBytes, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

const SECRETBOX_MAC_LEN = 16;

async function openUtf8(ciphertext: Uint8Array, key: Uint8Array): Promise<string> {
  const s = await ready();
  const nonceLen = s.crypto_secretbox_NONCEBYTES;
  if (ciphertext.length < nonceLen + SECRETBOX_MAC_LEN) {
    throw new Error('work-refusal-core: ciphertext too short');
  }
  const nonce = ciphertext.slice(0, nonceLen);
  const ct = ciphertext.slice(nonceLen);
  const pt = s.crypto_secretbox_open_easy(ct, nonce, key);
  return Buffer.from(pt).toString('utf8');
}

/**
 * Hash the per-record passphrase. The library uses HMAC-SHA-256 as an
 * opaque placeholder — T14.1's SupabaseWorkRefusalStore replaces the
 * slot with a bcrypt/argon2 hash + verify step (mirrors T13's G-T13-6
 * scope under G-T14-*).
 */
async function passphraseHash(passphrase: string, key: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(new TextEncoder().encode(passphrase), key);
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * Insert a work-refusal entry.
 *
 * Order of operations:
 *   1. Encrypt title + notes under the committee key (ADR-0003 Inv 1).
 *   2. INSERT with active-certified-member RLS gate. On deny: 403 + no
 *      PI body.
 *   3. Audit emit `work_refusal.created` — F-17 carries the actor
 *      pseudonym.
 */
export async function submitWorkRefusal(
  core: WorkRefusalCoreOpts,
  actor: { user_id: string },
  intake: WorkRefusalIntake
): Promise<SubmitWorkRefusalResult> {
  const { store, committeeKeyBytes, now } = core;
  const t = now();

  const title_ct = await sealUtf8(intake.title, committeeKeyBytes);
  const notes_ct = await sealUtf8(intake.body, committeeKeyBytes);
  const per_record_passphrase_hash = await passphraseHash(intake.passphrase, committeeKeyBytes);

  const insert = await store.insertWorkRefusal({
    actor_id: actor.user_id,
    actor_pseudonym: store.pseudonymOf(actor.user_id),
    title_ct,
    notes_ct,
    per_record_passphrase_hash,
    now: t
  });
  if (insert.ok === false) return insert;

  await store.recordWorkRefusalEvent({
    event_type: 'work_refusal.created',
    actor_pseudonym: store.pseudonymOf(actor.user_id),
    target_id: insert.id,
    meta: {
      // No plaintext echoed back into meta — privacy-review §2 obligation.
      created_at: t
    }
  });
  return { ok: true, id: insert.id };
}

/**
 * Read a work-refusal entry through the server-side audited path
 * (HG-6 mirror per Amendment A extension).
 *
 * The order of operations is the load-bearing security invariant: the
 * `work_refusal.read` audit row MUST be persisted BEFORE the plaintext
 * is handed back. If the audit emission fails, the read MUST abort
 * with no plaintext returned.
 *
 * The production SECURITY DEFINER view (T14.1) wraps the entire flow
 * in a single transaction. The library mirrors the ordering with
 * strict `await` discipline: any throw inside the audit-write step
 * bubbles before the decrypt + return — same pattern as T13's
 * `readReprisalEntry`.
 */
export async function readWorkRefusalEntry(
  core: WorkRefusalCoreOpts,
  actor: { user_id: string },
  id: string
): Promise<ReadWorkRefusalOk | ReadWorkRefusalDenied> {
  const { store, committeeKeyBytes, now } = core;

  // F-21 SELECT gate (certified_member OR co-chair via the view).
  const canRead = await store.canReadWorkRefusal(actor.user_id);
  if (!canRead) return { ok: false, reason: 'not_authorized' };

  const row = await store.getWorkRefusalById(id);
  if (!row) return { ok: false, reason: 'not_found' };

  const transaction_ts_ms = now();

  // HG-6 mirror — emit-then-decrypt. The `await` is load-bearing. If
  // the audit store rejects (e.g., the test's
  // `__test_revoke_audit_insert_for_role` shim), the catch surfaces
  // `audit_failed` and the plaintext NEVER returns.
  try {
    await store.recordWorkRefusalEvent({
      event_type: 'work_refusal.read',
      actor_pseudonym: store.pseudonymOf(actor.user_id),
      target_id: id,
      meta: {
        read_via: 'security_definer_view',
        transaction_ts_ms
      }
    });
  } catch {
    return { ok: false, reason: 'audit_failed' };
  }

  const notes_plaintext = await openUtf8(row.notes_ct, committeeKeyBytes);
  const title_plaintext = await openUtf8(row.title_ct, committeeKeyBytes);
  // F-18 / HG-6 mirror: the audit row above is awaited BEFORE this
  // return, so the audit MUST have committed by the time the caller
  // sees the plaintext. The ordering is enforced by the `await` (not
  // by the returned timestamp). Prior: `now() + 1` (G-T14 mirror of
  // G-T08-14 / G-T13-9; cleanup closed via .context/known-gaps.md).
  const received_at_ts = now();
  return {
    ok: true,
    notes_plaintext,
    title_plaintext,
    received_at_ts,
    transaction_ts_ms,
    row
  };
}

// ---------------------------------------------------------------------------
// Pseudonymized feed projection (Amendment D extension)
// ---------------------------------------------------------------------------

export async function listWorkRefusalFeed(
  core: WorkRefusalCoreOpts
): Promise<{ items: WorkRefusalListItem[] }> {
  const items = await core.store.listWorkRefusalFeed();
  return { items };
}
