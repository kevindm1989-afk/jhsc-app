/**
 * SupabaseWorkRefusalClient + SupabaseS51EvidenceClient — production-shaped
 * clients for the t14-op Edge Function (T14.1 / G-T14-2).
 *
 * Same design rationale as SupabaseT07Client / SupabaseConcernClient /
 * SupabaseReprisalClient: the test orchestrator's WorkRefusalStore /
 * S51EvidenceStore interfaces decompose a single high-level operation into
 * many small steps; PRODUCTION folds these into one SECURITY DEFINER SQL
 * function per high-level op (work_refusal_submit / work_refusal_read /
 * work_refusal_update / s51_evidence_submit / s51_evidence_read /
 * s51_evidence_update from migration 0006). Atomicity is the point. So we
 * expose the six high-level ops 1:1 with the t14-op Edge Function ops; the
 * KeyStore/{WorkRefusal,S51Evidence}Store orchestrator surfaces are left
 * for tests.
 *
 * Both classes live in this single module because they share the same
 * transport, the same denial contract (T14OpReason), and the same wire
 * format (bytea hex). They are exported as two distinct classes so
 * downstream callers can wire only the half they need.
 *
 * F-21: write functions gate on is_certified_member; audited reads gate on
 * is_certified_or_cochair. Read ops follow HG-6 (audit-before-ciphertext):
 * the SQL function emits `work_refusal.read` / `s51_evidence.read` BEFORE
 * the rows return, and emits `sensitive.access_attempt` on wrong-passphrase
 * with no rows returned. The wire-level contract collapses both
 * "wrong passphrase" and "row missing" to `{ ok: true, data: null }`.
 *
 * E2EE (ADR-0003 Invariant 1): title_ct, notes_ct, and per-photo wraps
 * (photos_ct[]) are sealed CLIENT-SIDE under the committee key before being
 * handed to this client. The wire carries bytea as PostgREST hex (`\x…`);
 * this layer never sees plaintext or the key.
 *
 * Transport injection: the constructor takes an `invoke` function so this
 * module has zero runtime dependency on `@supabase/supabase-js`.
 */

import { bytesToPgHex, pgHexToBytes } from '../server-client/pg-hex';

// ---------------------------------------------------------------------------
// Wire shape — mirrors supabase/functions/t14-op/core.ts T14Reason.
// ---------------------------------------------------------------------------

export type T14OpReason = 'rls_denied' | 'not_found' | 'invalid_input' | 'unknown';

export type T14OpResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: T14OpReason; status: number };

export type T14OpTransport = (
  body: Record<string, unknown>
) => Promise<{ status: number; body: unknown }>;

interface T14OpWireOk<T> {
  ok: true;
  data: T;
}
interface T14OpWireErr {
  ok: false;
  error: T14OpReason;
}

async function invoke<T>(
  transport: T14OpTransport,
  body: Record<string, unknown>
): Promise<T14OpResult<T>> {
  const r = await transport(body);
  const payload = r.body as Partial<T14OpWireOk<T>> & Partial<T14OpWireErr>;
  if (payload && payload.ok === true) {
    return { ok: true, data: payload.data as T };
  }
  const reason: T14OpReason = (payload?.error as T14OpReason | undefined) ?? 'unknown';
  return { ok: false, reason, status: r.status };
}

export interface SupabaseT14ClientOptions {
  transport: T14OpTransport;
}

// ---------------------------------------------------------------------------
// SupabaseWorkRefusalClient (s.43 OHSA)
// ---------------------------------------------------------------------------

/**
 * Production client for the work_refusal (s.43) surface.
 *
 * F-17: actor_id is always recorded server-side from auth.uid() — the s.43
 * statutory record cannot be filed anonymously. F-21: write gated on
 * is_certified_member; read gated on is_certified_or_cochair.
 */
export class SupabaseWorkRefusalClient {
  constructor(private opts: SupabaseT14ClientOptions) {}

  /**
   * File a work-refusal record. Title and narrative ciphertext are
   * client-sealed under the committee key. Per-record `passphrase` is the
   * F-34 friction-layer gate (G-T14-5/10); the SQL function hashes it with
   * pgcrypto bf.
   */
  submitWorkRefusal(input: {
    title_ct: Uint8Array;
    notes_ct: Uint8Array;
    passphrase?: string | null;
  }): Promise<T14OpResult<{ id: string }>> {
    return invoke<{ id: string }>(this.opts.transport, {
      op: 'wr_submit',
      title_ct: bytesToPgHex(input.title_ct),
      notes_ct: bytesToPgHex(input.notes_ct),
      passphrase: input.passphrase ?? null
    });
  }

  /**
   * HG-6 audited C4 read. The SQL `work_refusal_read` audits BEFORE
   * returning ciphertext (or emits `sensitive.access_attempt` on
   * wrong-passphrase and returns no rows). Wrong-passphrase / row-missing
   * both surface as `{ ok: true, data: null }`.
   */
  async readWorkRefusal(input: {
    id: string;
    passphrase?: string | null;
  }): Promise<T14OpResult<{ title_ct: Uint8Array; notes_ct: Uint8Array } | null>> {
    const r = await invoke<{ title_ct: string; notes_ct: string } | null>(this.opts.transport, {
      op: 'wr_read',
      id: input.id,
      passphrase: input.passphrase ?? null
    });
    if (!r.ok) return r;
    if (!r.data) return { ok: true, data: null };
    return {
      ok: true,
      data: {
        title_ct: pgHexToBytes(r.data.title_ct),
        notes_ct: pgHexToBytes(r.data.notes_ct)
      }
    };
  }

  /**
   * F-31 patch. Only provided fields are forwarded; SQL treats NULL as
   * "unchanged". The audit row carries `prev_field_hashes` (server-computed
   * from the prior ciphertext columns).
   */
  updateWorkRefusal(input: {
    id: string;
    title_ct?: Uint8Array;
    notes_ct?: Uint8Array;
  }): Promise<T14OpResult<null>> {
    const args: Record<string, unknown> = { op: 'wr_update', id: input.id };
    if (input.title_ct !== undefined) args.title_ct = bytesToPgHex(input.title_ct);
    if (input.notes_ct !== undefined) args.notes_ct = bytesToPgHex(input.notes_ct);
    return invoke<null>(this.opts.transport, args);
  }
}

// ---------------------------------------------------------------------------
// SupabaseS51EvidenceClient (s.51 OHSA — critical injury)
// ---------------------------------------------------------------------------

/**
 * Production client for the s51_evidence (s.51 critical-injury) surface.
 *
 * Same F-21 / F-17 / HG-6 contract as work_refusal, plus the photos_ct[]
 * array — each entry is a per-photo sealed blob produced by the HG-5
 * sanitize-before-encrypt pipeline (strip EXIF/IPTC/XMP + canvas re-encode
 * BEFORE the secretbox seal, so workplace GPS coordinates never reach DB
 * ciphertext or backup blobs).
 */
export class SupabaseS51EvidenceClient {
  constructor(private opts: SupabaseT14ClientOptions) {}

  /**
   * File an s.51 evidence record. Each entry in `photos` is a single
   * per-photo sealed blob (the caller is expected to have run the
   * sanitize-and-seal pipeline before reaching here).
   */
  submitS51Evidence(input: {
    title_ct: Uint8Array;
    notes_ct: Uint8Array;
    photos?: Uint8Array[];
    passphrase?: string | null;
  }): Promise<T14OpResult<{ id: string }>> {
    return invoke<{ id: string }>(this.opts.transport, {
      op: 's51_submit',
      title_ct: bytesToPgHex(input.title_ct),
      notes_ct: bytesToPgHex(input.notes_ct),
      photos_ct: (input.photos ?? []).map((p) => bytesToPgHex(p)),
      passphrase: input.passphrase ?? null
    });
  }

  /**
   * HG-6 audited C4 read. Returns the sealed `{title_ct, notes_ct,
   * photos}` or `null` for wrong-passphrase / row-missing.
   */
  async readS51Evidence(input: {
    id: string;
    passphrase?: string | null;
  }): Promise<
    T14OpResult<{ title_ct: Uint8Array; notes_ct: Uint8Array; photos: Uint8Array[] } | null>
  > {
    const r = await invoke<{ title_ct: string; notes_ct: string; photos_ct: string[] } | null>(
      this.opts.transport,
      { op: 's51_read', id: input.id, passphrase: input.passphrase ?? null }
    );
    if (!r.ok) return r;
    if (!r.data) return { ok: true, data: null };
    return {
      ok: true,
      data: {
        title_ct: pgHexToBytes(r.data.title_ct),
        notes_ct: pgHexToBytes(r.data.notes_ct),
        photos: (r.data.photos_ct ?? []).map((hex) => pgHexToBytes(hex))
      }
    };
  }

  /**
   * F-31 patch. Note: the photos array is intentionally NOT mutable here —
   * the photo set is append-only per the s.51 statutory-record posture; a
   * separate add-photo flow lands later. Only title/notes are patchable.
   */
  updateS51Evidence(input: {
    id: string;
    title_ct?: Uint8Array;
    notes_ct?: Uint8Array;
  }): Promise<T14OpResult<null>> {
    const args: Record<string, unknown> = { op: 's51_update', id: input.id };
    if (input.title_ct !== undefined) args.title_ct = bytesToPgHex(input.title_ct);
    if (input.notes_ct !== undefined) args.notes_ct = bytesToPgHex(input.notes_ct);
    return invoke<null>(this.opts.transport, args);
  }
}
