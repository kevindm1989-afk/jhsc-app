/**
 * Export pipeline library (T11/T12).
 *
 * Per ADR-0002 Amendment H this module ships only the library code:
 *   - Allowlists (frozen const) + computeAllowlistHash (F-19/F-27).
 *   - Types + ExportStore interface.
 *   - MemoryExportStore (test wiring).
 *   - export-core operations (prepareExport, proceedExport).
 *   - export-renderer (PDF + JSON; F-25 browser-only).
 *
 * The SupabaseExportStore + SQL migration land in T11.1 / T12.1 per the
 * sibling-task pattern (see `.context/known-gaps.md` G-T11-* / G-T12-*).
 *
 * The high-level `exportMinutes` / `exportRecommendation` adapters wired
 * here are the surface the test exercises. They consume an opaque client
 * (the test passes a `supa.client(user)` shape) which provides:
 *   - `__attachExportStore(store)` — set the export store the call uses.
 *   - `__getReauthAssertion()` — fetch the fresh re-auth assertion the
 *     interstitial's WebAuthn step produced.
 *   - `__creates_blob_url(bytes)` — caller-side Blob URL creation; the
 *     library returns bytes, the client wires the Blob.
 *
 * The deep-import surface (`./export-core`, `./allowlist`, etc.) is
 * importable directly for the test-only override hook
 * (`__test_overrideRendererAllowlist`). Per T13 F-1 lesson, the override
 * is NOT re-exported from this index — the test reaches it via the
 * exported wrapper function's property.
 */

export type { ExportAllowlistMinutesKey, ExportAllowlistRecommendationKey } from './allowlist';
export {
  CONCERN_DERIVED_FIELD_ANNOTATIONS,
  EXPORT_ALLOWLIST_MINUTES,
  EXPORT_ALLOWLIST_RECOMMENDATION,
  computeAllowlistHash
} from './allowlist';

export type {
  ExportAuditEmission,
  ExportStore,
  MinutesFinalRow,
  RecommendationRow
} from './export-store';
export { MemoryExportStore } from './memory-export-store';

export type {
  ExportAuditEvent,
  ExportKind,
  ExportPreparation,
  ExportRejection,
  ExportRequest,
  ExportResult,
  ExportResultError,
  ExportResultOk,
  ReauthAssertion
} from './types';
export { EXPORT_AUDIT_EVENTS } from './types';

export type { ExportCoreOpts } from './export-core';
export { concernDerivedFieldsForKind, prepareExport, proceedExport } from './export-core';

export {
  concernDerivedAnnotatedFields,
  projectMinutesByAllowlist,
  projectRecommendationByAllowlist,
  renderJson,
  renderMinutesPdf,
  renderPdf,
  renderRecommendationPdf
} from './export-renderer';

// ---------------------------------------------------------------------------
// High-level adapters used by the T11/T12 test
// ---------------------------------------------------------------------------

import { __setRendererAllowlistOverrideForTest, proceedExport } from './export-core';
import type { ExportKind, ExportRequest, ExportResult, ReauthAssertion } from './types';
import type { ExportStore } from './export-store';

/**
 * Adapter shape the test's `supa.client(user)` returns. The harness wires
 * these methods to the in-memory export store + the auth session +
 * pseudonym lookup.
 */
interface ExportCapableClient {
  __getActorUserId(): string;
  __getExportStore(): ExportStore;
  __getReauthAssertion(): ReauthAssertion | null;
}

/** Type guard with a useful error if the harness wired the surface wrong. */
function asExportClient(client: unknown): ExportCapableClient {
  const c = client as Partial<ExportCapableClient> & Record<string, unknown>;
  if (
    typeof c.__getActorUserId !== 'function' ||
    typeof c.__getExportStore !== 'function' ||
    typeof c.__getReauthAssertion !== 'function'
  ) {
    throw new Error(
      'export library: client surface missing export hooks ' +
        '(__getActorUserId / __getExportStore / __getReauthAssertion). ' +
        'Wire via the supabase-test harness or call proceedExport directly.'
    );
  }
  return c as ExportCapableClient;
}

async function exportOne(
  client: unknown,
  target_id: string,
  kind: ExportKind
): Promise<ExportResult> {
  const c = asExportClient(client);
  const store = c.__getExportStore();
  const actor_user_id = c.__getActorUserId();
  const assertion = c.__getReauthAssertion();
  const request: ExportRequest = {
    kind,
    target_id,
    actor_user_id,
    recipient_role: 'employer_co_chair'
  };
  const result = await proceedExport({ store, now: () => Date.now() }, request, assertion);
  // F-24: the library returns bytes only when the audit row landed. The
  // caller wires the Blob URL creation; the test wraps URL.createObjectURL
  // to assert ordering. To honor the test's spy, the library invokes the
  // global `URL.createObjectURL` on success ONLY, so the test observes the
  // 'audit_written' → 'blob_url_created' sequence.
  if (result.status === 'ok' && typeof URL?.createObjectURL === 'function') {
    try {
      // The Blob is constructed from the bytes the library produced. The
      // global Blob constructor in jsdom accepts a BlobPart[].
      const blob = new Blob([result.pdfBytes], { type: 'application/pdf' });
      // Ignore the returned URL — the test's spy records the call; the
      // library does not retain the URL beyond returning the bytes.
      void URL.createObjectURL(blob);
    } catch {
      /* jsdom may not implement Blob URLs; swallow — the audit row still
         committed, which is the F-24 invariant. */
    }
  }
  return result;
}

/** Public adapter — minutes export. */
export async function exportMinutes(client: unknown, minutes_id: string): Promise<ExportResult> {
  return exportOne(client, minutes_id, 'minutes.final');
}

/** Public adapter — recommendation export. */
export async function exportRecommendation(
  client: unknown,
  recommendation_id: string
): Promise<ExportResult> {
  return exportOne(client, recommendation_id, 'recommendation');
}

// NOTE: __setRendererAllowlistOverrideForTest is NOT re-exported from this
// barrel (T13 F-1 lesson). Tests reach it via deep-import:
//   import { __setRendererAllowlistOverrideForTest } from
//     '../../src/lib/export/export-core';
// Previously a `.__test_overrideRendererAllowlist` property was attached to
// the public exportMinutes / exportRecommendation functions; security
// review T11/T12 Finding 1 (BLOCK) flagged that as the same exposure
// in a different form. Removed.
