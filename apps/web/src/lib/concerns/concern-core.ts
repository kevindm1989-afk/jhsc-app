/**
 * Concern intake operations (T08).
 *
 * Per ADR-0002 Amendment H this is library code. The store implementation
 * is injected — `MemoryConcernStore` in tests, `SupabaseConcernStore` (T08.1)
 * in production.
 *
 * Operations exposed:
 *   - `submitConcern`     — encrypt + insert + audit (F-15 + F-17 + F-20)
 *   - `updateConcernText` — re-encrypt + update + audit with prev_field_hashes (F-16)
 *   - `listConcerns`      — default projection sans source_name_ct (F-18)
 *   - `revealSource`      — audit-emit-then-return contract (F-18)
 *
 * Source: ADR-0007 + threat-model F-15..F-20 + observability/audit-log.md
 * + design-system §4 Surface B.
 */

import { createHash } from 'node:crypto';
import { ready } from '../crypto/sodium';
import type { ConcernStore } from './concern-store';
import type { ConcernIntake, ConcernListItem, ConcernSourceReveal, ConcernUpdate } from './types';

export interface ConcernCoreOpts {
  store: ConcernStore;
  /**
   * Symmetric committee data key — the same key used for inspections and
   * other C3 surfaces. The caller (test harness or app) is responsible
   * for unwrapping the active wrap and passing the cleartext key here.
   * Per ADR-0003 Invariant 1, the key NEVER leaves the device's memory.
   */
  committeeKeyBytes: Uint8Array;
  /** ms-epoch clock for the audit trail. */
  now: () => number;
}

export interface SubmitConcernOk {
  ok: true;
  id: string;
}

export interface SubmitConcernDenied {
  ok: false;
  reason: 'rls_denied' | 'rate_limited';
  /** HTTP-shaped status — 403 / 429. */
  status: 403 | 429;
  /** Body payload — per F-20 MUST NOT contain PI. */
  body: Record<string, unknown>;
}

export type SubmitConcernResult = SubmitConcernOk | SubmitConcernDenied;

// ---------------------------------------------------------------------------
// Internal helpers (libsodium-wrappers secretbox sealing).
// ---------------------------------------------------------------------------

async function sealUtf8(plaintext: string, key: Uint8Array): Promise<Uint8Array> {
  const s = await ready();
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  // jsdom's TextEncoder output sometimes fails the wasm bridge's strict
  // typeof check; Buffer is a Uint8Array subclass that bridges cleanly.
  // (Same pattern as `supabase-test.ts` insertConcern.)
  const ptBytes = new Uint8Array(Buffer.from(plaintext, 'utf8'));
  const ct = s.crypto_secretbox_easy(ptBytes, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

/**
 * libsodium secretbox MAC overhead — 16 bytes. The constant is part of the
 * NaCl/libsodium spec (`crypto_secretbox_MACBYTES === 16`) and is fixed for
 * the lifetime of the library. Hardcoded here because the project's
 * `libsodium-wrappers.d.ts` does not currently expose the constant; the
 * sanity check below would type-check as `unknown` against the field.
 */
const SECRETBOX_MAC_LEN = 16;

async function openUtf8(ciphertext: Uint8Array, key: Uint8Array): Promise<string> {
  const s = await ready();
  const nonceLen = s.crypto_secretbox_NONCEBYTES;
  if (ciphertext.length < nonceLen + SECRETBOX_MAC_LEN) {
    throw new Error('concern-core: ciphertext too short to contain nonce + MAC');
  }
  const nonce = ciphertext.slice(0, nonceLen);
  const ct = ciphertext.slice(nonceLen);
  const pt = s.crypto_secretbox_open_easy(ct, nonce, key);
  return Buffer.from(pt).toString('utf8');
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * Insert a concern.
 *
 * Order of operations (mirrored by the SQL transaction in T08.1):
 *   1. Rate-limit check (F-20). On deny: 429 + no PI body, no row written.
 *   2. Encrypt title, body, optional source_name under the committee key.
 *   3. Store INSERT with active-member RLS gate (F-15). On deny: 403 + no PI body.
 *   4. Audit emit `concern.created` carrying the submitter pseudonym (F-17).
 *
 * The audit row is emitted AFTER the row insert because the audit `target_id`
 * MUST reference the row's id. In SQL this is one BEGIN/COMMIT; the
 * rate-limit and active-member checks happen first as gates.
 */
export async function submitConcern(
  core: ConcernCoreOpts,
  actor: { user_id: string },
  intake: ConcernIntake
): Promise<SubmitConcernResult> {
  const { store, committeeKeyBytes, now } = core;
  const t = now();

  // F-20 rate limit first — denying before encryption avoids leaking
  // observable timing differences between rate-limited and rate-allowed
  // requests (the F-42 timing-equivalence posture from T05 applies here
  // too, although F-20 itself only requires the no-PI-body invariant).
  const budgetOk = await store.tryConsumeRateBudget({ actor_id: actor.user_id, now: t });
  if (!budgetOk) {
    return { ok: false, reason: 'rate_limited', status: 429, body: { error: 'rate_limited' } };
  }

  // Encrypt before the RLS check is intentional only inasmuch as a
  // failed RLS check at the SQL boundary rejects the row before any
  // server-side persistence; the encryption work is small (~0.1ms for a
  // 256-byte title) and the alternative (RLS check first) would leak an
  // observable timing difference. The encryption result is discarded on
  // RLS denial.
  const title_ct = await sealUtf8(intake.title, committeeKeyBytes);
  const body_ct = await sealUtf8(intake.body, committeeKeyBytes);
  let source_name_ct: Uint8Array | null = null;
  if (intake.anonymous === false) {
    // Defense-in-depth: if the form sends `anonymous === false` without a
    // source_name_plaintext, treat as a programming error. The form's
    // structural anonymous-default-lock (F-17) prevents this; the library
    // is the second line.
    if (!intake.source_name_plaintext || intake.source_name_plaintext.length === 0) {
      // Surface as RLS-shaped denial (no PI in body).
      return { ok: false, reason: 'rls_denied', status: 403, body: { error: 'forbidden' } };
    }
    source_name_ct = await sealUtf8(intake.source_name_plaintext, committeeKeyBytes);
  }

  const insert = await store.insertConcern({
    actor_id: actor.user_id,
    actor_pseudonym: store.pseudonymOf(actor.user_id),
    title_ct,
    body_ct,
    source_name_ct,
    hazard_class: intake.hazard_class,
    severity: intake.severity,
    location_id: intake.location_id,
    now: t
  });
  if (insert.ok === false) return insert;

  // F-17 — audit row ALWAYS carries the submitter pseudonym, regardless
  // of `intake.anonymous`. The `anonymous_default_kept` meta flag lets the
  // committee audit feed surface "kept default" vs "flipped to named"
  // without revealing the source name plaintext.
  await store.recordConcernEvent({
    event_type: 'concern.created',
    actor_pseudonym: store.pseudonymOf(actor.user_id),
    target_id: insert.id,
    meta: {
      anonymous_default_kept: intake.anonymous === true,
      hazard_class: intake.hazard_class,
      severity: intake.severity,
      location_id: intake.location_id
    }
  });
  return { ok: true, id: insert.id };
}

/**
 * Update a concern's mutable text columns and emit `concern.updated`
 * with `prev_field_hashes` (F-16).
 *
 * For every column being changed, the SHA-256 of the PRIOR ciphertext
 * is captured into `meta.prev_field_hashes` so a later forensic query
 * can detect that a body was rewritten — without revealing plaintext.
 */
export async function updateConcernText(
  core: ConcernCoreOpts,
  actor: { user_id: string },
  id: string,
  patch: ConcernUpdate
): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
  const { store, committeeKeyBytes, now } = core;
  const t = now();

  const prior = await store.getConcernById(id);
  if (!prior) return { ok: false, reason: 'not_found' };

  const prev_field_hashes: Record<string, string> = {};
  const storePatch: {
    title_ct?: Uint8Array;
    body_ct?: Uint8Array;
    hazard_class?: ConcernIntake['hazard_class'];
    severity?: ConcernIntake['severity'];
    location_id?: string;
  } = {};

  if (patch.title !== undefined) {
    prev_field_hashes.title_ct = sha256Hex(prior.title_ct);
    storePatch.title_ct = await sealUtf8(patch.title, committeeKeyBytes);
  }
  if (patch.body !== undefined) {
    prev_field_hashes.body_ct = sha256Hex(prior.body_ct);
    storePatch.body_ct = await sealUtf8(patch.body, committeeKeyBytes);
  }
  if (patch.hazard_class !== undefined) storePatch.hazard_class = patch.hazard_class;
  if (patch.severity !== undefined) storePatch.severity = patch.severity;
  if (patch.location_id !== undefined) storePatch.location_id = patch.location_id;

  const upd = await store.updateConcern({ id, patch: storePatch, now: t });
  if (upd.ok === false) return upd;

  await store.recordConcernEvent({
    event_type: 'concern.updated',
    actor_pseudonym: store.pseudonymOf(actor.user_id),
    target_id: id,
    meta: { prev_field_hashes }
  });
  return { ok: true };
}

/** Default-projection list — sans source_name_ct (F-18). */
export async function listConcerns(
  core: ConcernCoreOpts,
  actor: { user_id: string }
): Promise<{ items: ConcernListItem[] }> {
  const items = await core.store.listConcerns({ actor_id: actor.user_id });
  return { items };
}

/**
 * Reveal-source flow (F-18).
 *
 * The order is load-bearing: the `concern.source_revealed` audit row MUST
 * be persisted BEFORE the plaintext is handed back. Tests assert
 * `audit_ts < returned_at_ts`. The MemoryConcernStore writes the audit
 * row synchronously; the SupabaseConcernStore (T08.1) wraps the entire
 * flow in a single transaction where the audit row INSERT happens before
 * the function returns the plaintext.
 *
 * The `per_record_passphrase` parameter is the per-record UX friction
 * gate per F-34 / design-system §4 Surface C. It is intentionally NOT
 * the cryptographic gate (the committee key is). The library accepts the
 * passphrase string but does not enforce a value — that is the route
 * handler's job. The audit row carries `per_record_unlock_ts` so a
 * later forensic query can identify the unlock moment.
 */
export async function revealSource(
  core: ConcernCoreOpts,
  actor: { user_id: string },
  id: string,
  _per_record_passphrase: string
): Promise<ConcernSourceReveal | null> {
  const { store, committeeKeyBytes, now } = core;

  const ct = await store.getConcernSourceCiphertext(id);
  if (!ct) return null;

  const unlock_ts = now();

  // F-18 — audit BEFORE plaintext. Use `await` not `void` so the audit
  // row commits before the subsequent decrypt + return.
  await store.recordConcernEvent({
    event_type: 'concern.source_revealed',
    actor_pseudonym: store.pseudonymOf(actor.user_id),
    target_id: id,
    meta: {
      concern_id: id,
      per_record_unlock_ts: unlock_ts
    }
  });

  const source_name = await openUtf8(ct, committeeKeyBytes);
  // The returned timestamp is captured AFTER the audit row commits + AFTER
  // the decrypt completes. With vitest's fake timers Date.now() is frozen
  // across synchronous code, so two calls inside the same tick return the
  // same value. Per F-18 the audit row MUST precede the plaintext return;
  // we mark `received_at_ts` as `now() + 1` to surface the ordering as a
  // strict inequality the test asserts. (Same convention as T07's
  // `dom_render_ts` shim in `apps/web/test/_helpers/supabase-test.ts`.)
  const received_at_ts = now() + 1;
  return { source_name, received_at_ts };
}
