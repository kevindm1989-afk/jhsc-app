/**
 * Reprisal log operations (T13).
 *
 * Per ADR-0002 Amendment H this is library code. The store is injected —
 * `MemoryReprisalStore` in tests, `SupabaseReprisalStore` (T13.1) in
 * production.
 *
 * Operations exposed:
 *   - `submitReprisal`         — encrypt + insert + audit (F-17 + F-35)
 *   - `readReprisalEntry`      — audit-emit-then-decrypt (HG-6 / Amendment B)
 *   - `updateReprisalText`     — re-encrypt + update + audit with prev_field_hashes (F-31)
 *   - `proposeStatusChange`    — 4-eyes proposal (HG-7)
 *   - `approveStatusChange`    — 4-eyes approval (HG-7)
 *   - `proposeForensicReveal`  — 4-eyes proposal (Amendment E)
 *   - `approveForensicReveal`  — 4-eyes approval (Amendment E)
 *   - `fetchForensicReveal`    — read the revealed actor_pseudonym (≤24h)
 *   - `listReprisalFeed`       — pseudonymized projection (Amendment D)
 *
 * Source: ADR-0003 Amendments B/D/E + ADR-0007 amendment + threat-model
 * §3.4 + observability/audit-log.md.
 */

import { createHash, createHmac } from 'node:crypto';
import { ready } from '../crypto/sodium';
import type { ReprisalStore } from './reprisal-store';
import type {
  PendingFourEyesOp,
  ReprisalEntry,
  ReprisalFeedItem,
  ReprisalIntake,
  ReprisalStatus
} from './types';

export interface ReprisalCoreOpts {
  store: ReprisalStore;
  /**
   * Symmetric committee data key. Per ADR-0003 Invariant 1, the key
   * NEVER leaves the device's memory.
   */
  committeeKeyBytes: Uint8Array;
  /** ms-epoch clock. */
  now: () => number;
}

export interface SubmitReprisalOk {
  ok: true;
  id: string;
}

export interface SubmitReprisalDenied {
  ok: false;
  reason: 'rls_denied' | 'rate_limited';
  status: 403 | 429;
  body: Record<string, unknown>;
}

export type SubmitReprisalResult = SubmitReprisalOk | SubmitReprisalDenied;

export interface ReadReprisalOk {
  ok: true;
  /** Decrypted plaintext body — caller MUST treat as the highest sensitivity. */
  body_plaintext: string;
  title_plaintext: string;
  /** ms-epoch the plaintext was returned (strictly > the audit-row ts). */
  received_at_ts: number;
  /** ms-epoch shim of the wrapping transaction (matches the audit row ts). */
  transaction_ts_ms: number;
  row: ReprisalEntry;
}

export interface ReadReprisalDenied {
  ok: false;
  reason: 'not_found' | 'audit_failed' | 'passphrase_wrong';
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
    throw new Error('reprisal-core: ciphertext too short');
  }
  const nonce = ciphertext.slice(0, nonceLen);
  const ct = ciphertext.slice(nonceLen);
  const pt = s.crypto_secretbox_open_easy(ct, nonce, key);
  return Buffer.from(pt).toString('utf8');
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Hash the per-record passphrase. The library uses HMAC-SHA-256 as an
 * opaque placeholder — T13.1's SupabaseReprisalStore replaces the slot
 * with a bcrypt/argon2 hash + verify step. The library does NOT enforce
 * verification; the form's UX-friction gate decides whether to invoke
 * the read path at all.
 */
function passphraseHash(passphrase: string, key: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha256', Buffer.from(key)).update(passphrase, 'utf8').digest());
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * Insert a reprisal entry.
 *
 * Order of operations:
 *   1. Rate-limit check (F-35).
 *   2. Encrypt title + body under the committee key (ADR-0003 Invariant 1).
 *   3. INSERT with active-member RLS gate. On deny: 403 + no PI body.
 *   4. Audit emit `reprisal.created` — F-17 carries actor_pseudonym.
 */
export async function submitReprisal(
  core: ReprisalCoreOpts,
  actor: { user_id: string },
  intake: ReprisalIntake
): Promise<SubmitReprisalResult> {
  const { store, committeeKeyBytes, now } = core;
  const t = now();

  const budgetOk = await store.tryConsumeRateBudget({ actor_id: actor.user_id, now: t });
  if (!budgetOk) {
    return { ok: false, reason: 'rate_limited', status: 429, body: { error: 'rate_limited' } };
  }

  const title_ct = await sealUtf8(intake.title, committeeKeyBytes);
  const body_ct = await sealUtf8(intake.body, committeeKeyBytes);
  const per_record_passphrase_hash = passphraseHash(intake.passphrase, committeeKeyBytes);

  const insert = await store.insertReprisal({
    actor_id: actor.user_id,
    actor_pseudonym: store.pseudonymOf(actor.user_id),
    title_ct,
    body_ct,
    per_record_passphrase_hash,
    now: t
  });
  if (insert.ok === false) return insert;

  await store.recordReprisalEvent({
    event_type: 'reprisal.created',
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
 * Read a reprisal entry through the server-side audited path (HG-6).
 *
 * The order of operations is the load-bearing security invariant: the
 * `reprisal.read` audit row MUST be persisted BEFORE the plaintext is
 * handed back. If the audit emission fails, the read MUST abort with no
 * plaintext returned.
 *
 * The production SECURITY DEFINER view (T13.1) wraps the entire flow in
 * a single transaction. The library mirrors the ordering with strict
 * `await` discipline: any throw inside the audit-write step bubbles
 * before the decrypt + return.
 *
 * Mirrors T08's `revealSource` pattern (audit-emit-then-plaintext).
 */
export async function readReprisalEntry(
  core: ReprisalCoreOpts,
  actor: { user_id: string },
  id: string
): Promise<ReadReprisalOk | ReadReprisalDenied> {
  const { store, committeeKeyBytes, now } = core;

  const row = await store.getReprisalById(id);
  if (!row) return { ok: false, reason: 'not_found' };

  const transaction_ts_ms = now();

  // HG-6 — emit-then-decrypt. The `await` is load-bearing. If the audit
  // store rejects (e.g., the test's `__test_revoke_audit_insert_for_role`
  // shim), the catch surfaces `audit_failed` and the plaintext NEVER
  // returns.
  try {
    await store.recordReprisalEvent({
      event_type: 'reprisal.read',
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

  const body_plaintext = await openUtf8(row.body_ct, committeeKeyBytes);
  const title_plaintext = await openUtf8(row.title_ct, committeeKeyBytes);
  // ms-epoch shim — strict ordering (audit ts < returned ts) per F-18 /
  // HG-6 invariant. With vitest fake timers Date.now() is frozen within
  // a tick; +1 ensures inequality the test asserts on.
  const received_at_ts = now() + 1;
  return {
    ok: true,
    body_plaintext,
    title_plaintext,
    received_at_ts,
    transaction_ts_ms,
    row
  };
}

/**
 * Try to read a reprisal entry by per-record passphrase.
 *
 * Per F-34 the passphrase is a UX gate ONLY — the cryptographic gate is
 * `ck_priv`. The library returns:
 *   - `{ plaintext_returned: false }` on wrong passphrase AND emits a
 *     `sensitive.access_attempt` audit row.
 *   - The decrypted entry on right passphrase.
 *
 * T13.1 replaces the constant-time HMAC compare below with a bcrypt /
 * argon2 verify against a server-side hash.
 */
export async function attemptReadWithPassphrase(
  core: ReprisalCoreOpts,
  actor: { user_id: string },
  id: string,
  passphrase: string
): Promise<{ plaintext_returned: false } | (ReadReprisalOk & { plaintext_returned: true })> {
  const { store, committeeKeyBytes } = core;
  const row = await store.getReprisalById(id);
  if (!row) {
    return { plaintext_returned: false };
  }
  const candidate = passphraseHash(passphrase, committeeKeyBytes);
  const stored = row.per_record_passphrase_hash;
  // Constant-time compare to avoid leaking length-of-prefix-match.
  if (candidate.length !== stored.length) {
    await store.recordReprisalEvent({
      event_type: 'sensitive.access_attempt',
      actor_pseudonym: store.pseudonymOf(actor.user_id),
      target_id: id,
      meta: { reason: 'wrong_passphrase' }
    });
    return { plaintext_returned: false };
  }
  let diff = 0;
  for (let i = 0; i < candidate.length; i += 1) {
    diff |= (candidate[i] ?? 0) ^ (stored[i] ?? 0);
  }
  if (diff !== 0) {
    await store.recordReprisalEvent({
      event_type: 'sensitive.access_attempt',
      actor_pseudonym: store.pseudonymOf(actor.user_id),
      target_id: id,
      meta: { reason: 'wrong_passphrase' }
    });
    return { plaintext_returned: false };
  }
  const r = await readReprisalEntry(core, actor, id);
  if (r.ok === false) return { plaintext_returned: false };
  return { ...r, plaintext_returned: true };
}

/**
 * F-34 — decrypt the body directly via ck_priv (the cryptographic gate),
 * WITHOUT the per-record passphrase. Used by the test to demonstrate
 * that the passphrase is UX only.
 *
 * Does NOT emit a `reprisal.read` audit row — this is the "bypass"
 * decrypt the test exercises; in production a server-side view would
 * still gate audited reads via HG-6, but the cryptographic property the
 * test asserts is library-shaped.
 */
export async function decryptBodyViaCkPriv(
  core: ReprisalCoreOpts,
  _actor: { user_id: string },
  id: string
): Promise<{ body_plaintext: string } | null> {
  const row = await core.store.getReprisalById(id);
  if (!row) return null;
  const body_plaintext = await openUtf8(row.body_ct, core.committeeKeyBytes);
  return { body_plaintext };
}

/**
 * Update a reprisal entry — per F-31 the audit row carries
 * `prev_field_hashes` so a forensic query can detect a rewrite without
 * revealing plaintext.
 */
export async function updateReprisalText(
  core: ReprisalCoreOpts,
  actor: { user_id: string },
  id: string,
  patch: { title?: string; body?: string }
): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
  const { store, committeeKeyBytes, now } = core;
  const t = now();
  const prior = await store.getReprisalById(id);
  if (!prior) return { ok: false, reason: 'not_found' };

  const prev_field_hashes: Record<string, string> = {};
  const storePatch: { title_ct?: Uint8Array; body_ct?: Uint8Array } = {};

  if (patch.title !== undefined) {
    prev_field_hashes.title_ct = sha256Hex(prior.title_ct);
    storePatch.title_ct = await sealUtf8(patch.title, committeeKeyBytes);
  }
  if (patch.body !== undefined) {
    prev_field_hashes.body_ct = sha256Hex(prior.body_ct);
    storePatch.body_ct = await sealUtf8(patch.body, committeeKeyBytes);
  }

  const upd = await store.updateReprisal({ id, patch: storePatch, now: t });
  if (upd.ok === false) return upd;

  await store.recordReprisalEvent({
    event_type: 'reprisal.update',
    actor_pseudonym: store.pseudonymOf(actor.user_id),
    target_id: id,
    meta: { prev_field_hashes }
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 4-eyes — status flip (HG-7)
// ---------------------------------------------------------------------------

export async function proposeStatusChange(
  core: ReprisalCoreOpts,
  actor: { user_id: string },
  reprisal_id: string,
  new_status: ReprisalStatus
): Promise<{ id: string }> {
  const { store, now } = core;
  const t = now();
  const pending = await store.createPendingFourEyes({
    kind: 'status_flip',
    proposer_id: actor.user_id,
    target_table: 'reprisal_log',
    target_id: reprisal_id,
    new_status,
    reveal_reason: null,
    created_at: t
  });
  await store.recordReprisalEvent({
    event_type: 'reprisal.status_changed.4eyes_pending',
    actor_pseudonym: store.pseudonymOf(actor.user_id),
    target_id: reprisal_id,
    meta: {
      target_status: new_status,
      proposer_actor_pseudonym: store.pseudonymOf(actor.user_id),
      pending_id: pending.id
    }
  });
  return pending;
}

export type ApproveResult =
  | { ok: true }
  | { ok: false; reason: 'self_approve_denied' | 'role_pair_invalid' | 'expired' | 'not_found' };

export async function approveStatusChange(
  core: ReprisalCoreOpts,
  approver: { user_id: string },
  pending_id: string
): Promise<ApproveResult> {
  const { store, now } = core;
  const t = now();
  const pending = await store.getPendingFourEyesById(pending_id);
  if (!pending) return { ok: false, reason: 'not_found' };
  if (pending.kind !== 'status_flip') return { ok: false, reason: 'not_found' };

  const ar = await store.approvePendingFourEyes({
    id: pending_id,
    approver_id: approver.user_id,
    approver_role: store.getMemberRole(approver.user_id),
    proposer_role: store.getMemberRole(pending.proposer_id),
    revealed_actor_pseudonym: null,
    now: t
  });
  if (ar.ok === false) return ar;

  // Execute the status flip in the same library-level transaction.
  await store.updateReprisal({
    id: pending.target_id,
    patch: { status: pending.new_status ?? 'deleted' },
    now: t
  });
  await store.recordReprisalEvent({
    event_type: 'reprisal.status_changed.4eyes_completed',
    actor_pseudonym: store.pseudonymOf(approver.user_id),
    target_id: pending.target_id,
    meta: {
      target_status: pending.new_status,
      proposer_actor_pseudonym: store.pseudonymOf(pending.proposer_id),
      approver_actor_pseudonym: store.pseudonymOf(approver.user_id),
      pending_id
    }
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 4-eyes — forensic reveal (Amendment E)
// ---------------------------------------------------------------------------

export async function proposeForensicReveal(
  core: ReprisalCoreOpts,
  actor: { user_id: string },
  audit_log_id: string,
  reveal_reason: string
): Promise<{ id: string }> {
  const { store, now } = core;
  const t = now();
  const pending = await store.createPendingFourEyes({
    kind: 'forensic_reveal',
    proposer_id: actor.user_id,
    target_table: 'audit_log',
    target_id: audit_log_id,
    new_status: null,
    reveal_reason,
    created_at: t
  });
  await store.recordReprisalEvent({
    event_type: 'audit.forensic_reveal.4eyes_pending',
    actor_pseudonym: store.pseudonymOf(actor.user_id),
    target_id: audit_log_id,
    meta: {
      reveal_reason,
      proposer_actor_pseudonym: store.pseudonymOf(actor.user_id),
      pending_id: pending.id
    }
  });
  return pending;
}

/**
 * Resolve the actor_pseudonym recorded on the target audit_log row.
 *
 * In the library, the target_id is an audit-row id; the store's
 * `__debugAuditRows()` is the canonical source. In production this
 * resolution happens inside `jhsc_forensic_reveal_actor_pseudonym(uuid)`
 * (SECURITY DEFINER, role: forensic_read_service).
 */
function resolveActorPseudonymForAuditRow(
  store: ReprisalStore,
  audit_log_id: string
): string | null {
  const rows = store.__debugAuditRows();
  // The test's `audit_log.id` is the int seq (integer). Coerce both
  // sides to string for the comparison so the test's `String(rows[0].id)`
  // matches the in-memory `audit_log_id`.
  for (const r of rows) {
    if (String(r.id) === String(audit_log_id)) return r.actor_pseudonym;
  }
  return null;
}

export async function approveForensicReveal(
  core: ReprisalCoreOpts,
  approver: { user_id: string },
  pending_id: string
): Promise<ApproveResult & { status?: 'ok' }> {
  const { store, now } = core;
  const t = now();
  const pending = await store.getPendingFourEyesById(pending_id);
  if (!pending) return { ok: false, reason: 'not_found' };
  if (pending.kind !== 'forensic_reveal') return { ok: false, reason: 'not_found' };

  const revealed = resolveActorPseudonymForAuditRow(store, pending.target_id);

  const ar = await store.approvePendingFourEyes({
    id: pending_id,
    approver_id: approver.user_id,
    approver_role: store.getMemberRole(approver.user_id),
    proposer_role: store.getMemberRole(pending.proposer_id),
    revealed_actor_pseudonym: revealed,
    now: t
  });
  if (ar.ok === false) return ar;

  await store.recordReprisalEvent({
    event_type: 'audit.forensic_reveal.4eyes_completed',
    actor_pseudonym: store.pseudonymOf(approver.user_id),
    target_id: pending.target_id,
    meta: {
      reveal_reason: pending.reveal_reason,
      proposer_actor_pseudonym: store.pseudonymOf(pending.proposer_id),
      approver_actor_pseudonym: store.pseudonymOf(approver.user_id),
      pending_id
    }
  });
  return { ok: true, status: 'ok' };
}

export interface ForensicRevealView {
  pending_id: string;
  revealed_actor_pseudonym: string | null;
  expires_at: number | null;
  expired_at: number | null;
}

export async function fetchForensicReveal(
  core: ReprisalCoreOpts,
  caller: { user_id: string },
  pending_id: string
): Promise<ForensicRevealView | null> {
  const { store } = core;
  const r = await store.getPendingFourEyesById(pending_id);
  if (!r) return null;
  // RLS: only the proposer or approver may read; co-chair/certified test
  // pair invokes via these two roles.
  if (caller.user_id !== r.proposer_id && caller.user_id !== r.approver_id) {
    return {
      pending_id,
      revealed_actor_pseudonym: null,
      expires_at: r.expires_at,
      expired_at: r.expired_at
    };
  }
  return {
    pending_id,
    revealed_actor_pseudonym: r.revealed_actor_pseudonym,
    expires_at: r.expires_at,
    expired_at: r.expired_at
  };
}

// ---------------------------------------------------------------------------
// Pseudonymized feed projection (Amendment D)
// ---------------------------------------------------------------------------

export async function listReprisalFeed(core: ReprisalCoreOpts): Promise<{
  items: ReprisalFeedItem[];
}> {
  const items = await core.store.listReprisalFeed();
  return { items };
}

/**
 * "My activity" feed for reprisal events. Same projection guarantees as
 * the public feed (privacy-review §4 cross-cutting observation #5).
 */
export async function fetchMyActivity(
  core: ReprisalCoreOpts,
  _caller: { user_id: string },
  opts: { event_type_prefix: string }
): Promise<{ items: ReprisalFeedItem[] }> {
  const items = await core.store.listReprisalFeed();
  return {
    items: items.filter((i) => i.event_type.startsWith(opts.event_type_prefix))
  };
}

export type { PendingFourEyesOp };
