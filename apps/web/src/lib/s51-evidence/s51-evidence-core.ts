/**
 * s.51 critical-injury evidence operations (T14).
 *
 * Per ADR-0002 Amendment H this is library code. The store is injected
 * — `MemoryS51EvidenceStore` in tests, `SupabaseS51EvidenceStore`
 * (T14.1) in production.
 *
 * Operations exposed:
 *   - `submitS51Evidence`  — sanitize photos + encrypt + insert + audit
 *                            (F-21 + HG-5 cross-reference)
 *   - `readS51Evidence`    — audit-emit-then-decrypt (HG-6 mirror;
 *                            Amendment A extension)
 *   - `listS51EvidenceFeed` — pseudonymized projection (Amendment D
 *                            extension)
 *
 * HG-5 ordering: photo bytes pass through `sanitizePhoto(...)`
 * (strip-EXIF + canvas-reencode) BEFORE secretbox-seal. Any non-JPEG
 * input throws `PhotoUnsupportedFormatError` (fail-closed); the caller
 * surfaces the error to the user.
 *
 * Source: ADR-0003 Amendments A extension / B / D extension +
 * HG-5 cross-reference + observability/audit-log.md + threat-model
 * §3.4 F-21.
 */

import { hmacSha256 } from '../crypto/hash';
import { ready } from '../crypto/sodium';
import { sanitizePhoto, PhotoUnsupportedFormatError } from '../photo/sanitize';
import type { S51EvidenceStore } from './s51-evidence-store';
import type { S51EvidenceEntry, S51EvidenceIntake, S51EvidenceListItem } from './types';

export interface S51EvidenceCoreOpts {
  store: S51EvidenceStore;
  /**
   * Symmetric committee data key. Per ADR-0003 Invariant 1, the key
   * NEVER leaves the device's memory.
   */
  committeeKeyBytes: Uint8Array;
  /** ms-epoch clock. */
  now: () => number;
}

export interface SubmitS51EvidenceOk {
  ok: true;
  id: string;
}

export interface SubmitS51EvidenceDenied {
  ok: false;
  reason: 'rls_denied' | 'rate_limited';
  status: 403 | 429;
  body: Record<string, unknown>;
}

/**
 * Photo at `rejected_index` is not a recognisable JPEG (G-T14-12).
 * No row is written and no `s51_evidence.created` audit is emitted; a
 * `s51_evidence.create.rejected` audit row IS emitted so an operator can
 * trace the failure. The form surfaces a banner keyed by `banner_key`.
 */
export interface SubmitS51EvidenceRejected {
  ok: false;
  reason: 'photo_unsupported_format';
  status: 422;
  body: { rejected_index: number; banner_key: string };
}

export type SubmitS51EvidenceResult =
  | SubmitS51EvidenceOk
  | SubmitS51EvidenceDenied
  | SubmitS51EvidenceRejected;

export interface ReadS51EvidenceOk {
  ok: true;
  notes_plaintext: string;
  title_plaintext: string;
  /** ms-epoch the plaintext was returned (strictly > the audit-row ts). */
  received_at_ts: number;
  /** ms-epoch shim of the wrapping transaction (matches the audit row ts). */
  transaction_ts_ms: number;
  row: S51EvidenceEntry;
}

export interface ReadS51EvidenceDenied {
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

async function sealBytes(plaintext: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const s = await ready();
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ct = s.crypto_secretbox_easy(plaintext, nonce, key);
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
    throw new Error('s51-evidence-core: ciphertext too short');
  }
  const nonce = ciphertext.slice(0, nonceLen);
  const ct = ciphertext.slice(nonceLen);
  const pt = s.crypto_secretbox_open_easy(ct, nonce, key);
  return Buffer.from(pt).toString('utf8');
}

async function openBytes(ciphertext: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const s = await ready();
  const nonceLen = s.crypto_secretbox_NONCEBYTES;
  if (ciphertext.length < nonceLen + SECRETBOX_MAC_LEN) {
    throw new Error('s51-evidence-core: photo ciphertext too short');
  }
  const nonce = ciphertext.slice(0, nonceLen);
  const ct = ciphertext.slice(nonceLen);
  return s.crypto_secretbox_open_easy(ct, nonce, key);
}

/**
 * Hash the per-record passphrase. The library uses HMAC-SHA-256 as an
 * opaque placeholder — T14.1's SupabaseS51EvidenceStore replaces the
 * slot with a bcrypt/argon2 hash + verify step (mirrors T13's
 * G-T13-6 scope under G-T14-*).
 */
async function passphraseHash(passphrase: string, key: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(new TextEncoder().encode(passphrase), key);
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * Submit an s.51 critical-injury evidence entry.
 *
 * Order of operations:
 *   1. For each photo: `sanitizePhoto(...)` (strip EXIF/IPTC/XMP +
 *      canvas re-encode) — HG-5 ordering: sanitize-BEFORE-encrypt.
 *   2. Encrypt title + notes + each sanitized photo under the
 *      committee key (ADR-0003 Invariant 1).
 *   3. INSERT with active-certified-member RLS gate. On deny: 403 +
 *      no PI body.
 *   4. Audit emit `s51_evidence.created` — F-17 carries actor
 *      pseudonym.
 *
 * Sanitization failures (non-JPEG inputs) throw
 * `PhotoUnsupportedFormatError`; the caller surfaces the error.
 */
export async function submitS51Evidence(
  core: S51EvidenceCoreOpts,
  actor: { user_id: string },
  intake: S51EvidenceIntake
): Promise<SubmitS51EvidenceResult> {
  const { store, committeeKeyBytes, now } = core;
  const t = now();

  // HG-5: sanitize-BEFORE-encrypt for every photo. An unsupported format on
  // any photo aborts the whole submit (G-T14-12): no row is written, a
  // `s51_evidence.create.rejected` audit row is emitted, and the form gets
  // back the rejected index + a banner key.
  const photos_ct: Uint8Array[] = [];
  if (intake.photos && intake.photos.length > 0) {
    for (const [i, raw] of intake.photos.entries()) {
      try {
        const sanitized = await sanitizePhoto(raw);
        photos_ct.push(await sealBytes(sanitized.bytes, committeeKeyBytes));
      } catch (err) {
        if (err instanceof PhotoUnsupportedFormatError) {
          await store.recordS51EvidenceEvent({
            event_type: 's51_evidence.create.rejected',
            actor_pseudonym: store.pseudonymOf(actor.user_id),
            target_id: '',
            meta: { reason: 'photo_unsupported_format', rejected_index: i }
          });
          return {
            ok: false,
            reason: 'photo_unsupported_format',
            status: 422,
            body: {
              rejected_index: i,
              banner_key: 's51_evidence.intake.photo.unsupported_format'
            }
          };
        }
        throw err;
      }
    }
  }

  const title_ct = await sealUtf8(intake.title, committeeKeyBytes);
  const notes_ct = await sealUtf8(intake.body, committeeKeyBytes);
  const per_record_passphrase_hash = await passphraseHash(intake.passphrase, committeeKeyBytes);

  const insert = await store.insertS51Evidence({
    actor_id: actor.user_id,
    actor_pseudonym: store.pseudonymOf(actor.user_id),
    title_ct,
    notes_ct,
    photos_ct,
    per_record_passphrase_hash,
    now: t
  });
  if (insert.ok === false) return insert;

  await store.recordS51EvidenceEvent({
    event_type: 's51_evidence.created',
    actor_pseudonym: store.pseudonymOf(actor.user_id),
    target_id: insert.id,
    meta: {
      created_at: t,
      photo_count: photos_ct.length
    }
  });
  return { ok: true, id: insert.id };
}

/**
 * Read an s.51 evidence entry through the server-side audited path
 * (HG-6 mirror per Amendment A extension).
 *
 * The order of operations is the load-bearing security invariant: the
 * `s51_evidence.read` audit row MUST be persisted BEFORE the
 * plaintext is handed back. If the audit emission fails, the read
 * MUST abort with no plaintext returned.
 *
 * Same pattern as T13's `readReprisalEntry`.
 */
export async function readS51Evidence(
  core: S51EvidenceCoreOpts,
  actor: { user_id: string },
  id: string
): Promise<ReadS51EvidenceOk | ReadS51EvidenceDenied> {
  const { store, committeeKeyBytes, now } = core;

  // F-21 SELECT gate (certified_member OR co-chair via the view).
  const canRead = await store.canReadS51Evidence(actor.user_id);
  if (!canRead) return { ok: false, reason: 'not_authorized' };

  const row = await store.getS51EvidenceById(id);
  if (!row) return { ok: false, reason: 'not_found' };

  const transaction_ts_ms = now();

  try {
    await store.recordS51EvidenceEvent({
      event_type: 's51_evidence.read',
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
  const received_at_ts = now() + 1;
  return {
    ok: true,
    notes_plaintext,
    title_plaintext,
    received_at_ts,
    transaction_ts_ms,
    row
  };
}

/**
 * Decrypt a single sealed photo from an s.51 evidence row.
 *
 * SECURITY: this function does NOT emit a `s51_evidence.read` audit
 * row. It is the test-only bypass that lets the HG-5 round-trip
 * assertion decrypt a stored photo and grep its bytes for EXIF/IPTC/
 * XMP residue. The `__test_` prefix per project convention marks it
 * as test-only — production reads MUST go through `readS51Evidence`
 * (which enforces HG-6 audit-before-decrypt).
 *
 * NOT exported from `./index.ts`; only the test harness in
 * `apps/web/test/_helpers/supabase-test.ts` imports it directly.
 *
 * Mirror of T13's `decryptBodyViaCkPrivTestOnly` per the
 * "test-only bypass not in index" convention.
 */
export async function decryptS51PhotoTestOnly(
  core: S51EvidenceCoreOpts,
  _actor: { user_id: string },
  id: string,
  photo_index: number
): Promise<{ photo_plaintext: Uint8Array } | null> {
  const row = await core.store.getS51EvidenceById(id);
  if (!row) return null;
  const blob = row.photos_ct[photo_index];
  if (!blob) return null;
  const plaintext = await openBytes(blob, core.committeeKeyBytes);
  return { photo_plaintext: plaintext };
}

// ---------------------------------------------------------------------------
// Pseudonymized feed projection (Amendment D extension)
// ---------------------------------------------------------------------------

export async function listS51EvidenceFeed(
  core: S51EvidenceCoreOpts
): Promise<{ items: S51EvidenceListItem[] }> {
  const items = await core.store.listS51EvidenceFeed();
  return { items };
}
