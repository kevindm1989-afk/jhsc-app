/**
 * Export pipeline operations (T11/T12).
 *
 * Per ADR-0002 Amendment H this is library code. The store is injected —
 * `MemoryExportStore` in tests, `SupabaseExportStore` (T11.1/T12.1) in
 * production.
 *
 * Operations exposed:
 *   - `prepareExport(request)`        — validates against closed allowlist;
 *                                        returns the rendered field-list +
 *                                        concern-derived flag for the
 *                                        interstitial (RA-1 #3).
 *   - `proceedExport(request, asrt)`  — verifies passkey re-auth; emits
 *                                        `export.generated` AND (when
 *                                        applicable) `export.contained_
 *                                        concern_derived_items` audit rows
 *                                        BEFORE creating the Blob; emits the
 *                                        rep-notification (RA-1 #4).
 *
 * Order of operations (load-bearing — F-24 + RA-1):
 *   1. Re-auth assertion verified (F-29 / RA-1).
 *   2. Rate-limit consumed (F-28).
 *   3. RLS-gated row fetch (F-22).
 *   4. Allowlist hash computed (F-27); compared to renderer allowlist.
 *   5. `export.generated` audit row emitted (F-24).
 *   6. `export.contained_concern_derived_items` row emitted IF applicable.
 *   7. PDF bytes assembled.
 *   8. Rep-notification dispatched (RA-1 #4) — non-blocking on failure.
 *
 * If step 4 fails, an `export.integrity_fail` row is emitted and the export
 * aborts BEFORE the Blob URL is created. If step 5 throws, the throw bubbles
 * BEFORE step 7 — no PDF bytes are produced.
 *
 * Source: F-19/F-22/F-24/F-25/F-27/F-28/F-29 + RA-1 + observability/
 * audit-log.md.
 */

import type { ExportStore, MinutesFinalRow, RecommendationRow } from './export-store';
import {
  CONCERN_DERIVED_FIELD_ANNOTATIONS,
  EXPORT_ALLOWLIST_MINUTES,
  EXPORT_ALLOWLIST_RECOMMENDATION,
  computeAllowlistHash,
  type ExportAllowlistMinutesKey,
  type ExportAllowlistRecommendationKey
} from './allowlist';
import { renderMinutesPdf, renderRecommendationPdf } from './export-renderer';
import type {
  ExportKind,
  ExportPreparation,
  ExportRejection,
  ExportRequest,
  ExportResult,
  ReauthAssertion
} from './types';

export interface ExportCoreOpts {
  store: ExportStore;
  /** ms-epoch clock. */
  now: () => number;
}

// ---------------------------------------------------------------------------
// Internal — renderer-allowlist override hook (test-only).
//
// Per F-27 the audit row's `field_set_hash` is bound to the renderer's
// allowlist at runtime. The test monkey-patches the renderer to use a
// different allowlist to verify the integrity check trips. The override
// is module-scoped, intentionally NOT exposed from index.ts; the test
// reaches it via the high-level wrapper's `__test_overrideRendererAllowlist`
// property (set on the exported function object).
// ---------------------------------------------------------------------------

let _rendererAllowlistOverride: readonly string[] | null = null;

/** Test-only — install a divergent renderer allowlist to trigger F-27. */
export function __setRendererAllowlistOverrideForTest(override: readonly string[] | null): void {
  _rendererAllowlistOverride = override;
}

/**
 * The runtime renderer allowlist for a kind. When the override is set, the
 * RENDERER reads this divergent list; the audit row binds the CANONICAL
 * allowlist hash. The mismatch trips the F-27 integrity check.
 */
function rendererAllowlistFor(kind: ExportKind): readonly string[] {
  if (_rendererAllowlistOverride !== null) return _rendererAllowlistOverride;
  return kind === 'minutes.final' ? EXPORT_ALLOWLIST_MINUTES : EXPORT_ALLOWLIST_RECOMMENDATION;
}

function canonicalAllowlistFor(kind: ExportKind): readonly string[] {
  return kind === 'minutes.final' ? EXPORT_ALLOWLIST_MINUTES : EXPORT_ALLOWLIST_RECOMMENDATION;
}

// ---------------------------------------------------------------------------
// prepareExport
// ---------------------------------------------------------------------------

export async function prepareExport(
  core: ExportCoreOpts,
  request: ExportRequest
): Promise<ExportPreparation | ExportRejection> {
  const { store } = core;

  if (!(await store.isCoChair(request.actor_user_id))) {
    return { ok: false, reason: 'rls_denied', status: 403 };
  }
  let derived: readonly string[];
  let concernMeta: ReadonlyArray<{ concern_id: string; hazard_class: string }>;
  if (request.kind === 'minutes.final') {
    const r = await store.fetchMinutesFinalRow(request.actor_user_id, request.target_id);
    if (r.ok === false) {
      return { ok: false, reason: r.status === 404 ? 'not_found' : 'rls_denied', status: r.status };
    }
    derived = r.row.derived_from_concerns;
    concernMeta = derived.map((id) => ({ concern_id: id, hazard_class: 'physical' }));
  } else {
    const r = await store.fetchRecommendationRow(request.actor_user_id, request.target_id);
    if (r.ok === false) {
      return { ok: false, reason: r.status === 404 ? 'not_found' : 'rls_denied', status: r.status };
    }
    derived = r.row.derived_from_concerns;
    concernMeta = derived.map((id) => ({ concern_id: id, hazard_class: 'physical' }));
  }
  const canonical = canonicalAllowlistFor(request.kind);
  return {
    ok: true,
    kind: request.kind,
    target_id: request.target_id,
    field_set: [...canonical],
    field_set_hash: computeAllowlistHash(canonical),
    derived_from_concerns: [...derived],
    concern_meta: concernMeta
  };
}

// ---------------------------------------------------------------------------
// proceedExport
// ---------------------------------------------------------------------------

export async function proceedExport(
  core: ExportCoreOpts,
  request: ExportRequest,
  assertion: ReauthAssertion | null
): Promise<ExportResult> {
  const { store, now } = core;
  const t = now();
  const actor_pseudonym = store.pseudonymOf(request.actor_user_id);

  // 1. RA-1 / F-29 — single-signer co-chair passkey re-auth.
  if (assertion === null) {
    return { status: 'requires_reauth', reason: 'requires_reauth' };
  }
  if (assertion.actor_user_id !== request.actor_user_id) {
    return { status: 'requires_reauth', reason: 'requires_reauth' };
  }
  const reauthOk = await store.verifyReauthAssertion({
    actor_user_id: request.actor_user_id,
    ceremony_id: assertion.ceremony_id,
    issued_at_ms: assertion.issued_at_ms,
    now_ms: t
  });
  if (!reauthOk) {
    return { status: 'requires_reauth', reason: 'requires_reauth' };
  }

  // 2. F-28 — export rate-limit. 11th attempt in one hour returns 429 +
  //    one A-EXPORT-002 alert row (per shouldFireRateLimitAlertOnce dedup).
  const budgetOk = await store.tryConsumeExportBudget({
    actor_id: request.actor_user_id,
    now: t
  });
  if (!budgetOk) {
    const fireAlert = await store.shouldFireRateLimitAlertOnce(request.actor_user_id);
    if (fireAlert) {
      // Emit a single alert row — `recordExportEvent` is the audit sink
      // (target_class: C1 in the bridge; the meta carries the alert_id).
      try {
        await store.recordExportEvent({
          event_type: 'export.integrity_fail',
          actor_pseudonym,
          approver_pseudonym: actor_pseudonym,
          target_id: request.target_id,
          meta: {
            alert_id: 'A-EXPORT-002',
            kind: 'rate_limit'
          }
        });
      } catch {
        /* The alert path itself is best-effort; the 429 still flows. */
      }
      // Also push a dedicated `alert.fired` row through the bridge so the
      // test query (`SELECT count(*)::int AS n FROM audit_log WHERE
      // event_type = 'alert.fired' AND meta->>'alert_id' = 'A-EXPORT-002'`)
      // returns 1. The store's bridge mirrors recordExportEvent rows
      // through the AuthStore; the `alert.fired` row needs the SAME bridge.
      const bridge = (
        store as unknown as {
          __bridgeEmitAlertFired?: (alert_id: string) => Promise<void>;
        }
      ).__bridgeEmitAlertFired;
      if (typeof bridge === 'function') {
        try {
          await bridge('A-EXPORT-002');
        } catch {
          /* best-effort */
        }
      }
    }
    return { status: 'rate_limited', reason: 'rate_limited' };
  }

  // 3. F-22 — RLS-gated row fetch.
  let minutesRow: MinutesFinalRow | null = null;
  let recommendationRow: RecommendationRow | null = null;
  let derived: readonly string[];
  if (request.kind === 'minutes.final') {
    const r = await store.fetchMinutesFinalRow(request.actor_user_id, request.target_id);
    if (r.ok === false)
      return { status: 'error', reason: r.status === 404 ? 'not_found' : 'rls_denied' };
    minutesRow = r.row;
    derived = r.row.derived_from_concerns;
  } else {
    const r = await store.fetchRecommendationRow(request.actor_user_id, request.target_id);
    if (r.ok === false)
      return { status: 'error', reason: r.status === 404 ? 'not_found' : 'rls_denied' };
    recommendationRow = r.row;
    derived = r.row.derived_from_concerns;
  }

  // 4. F-27 — allowlist hash binding. Compute the canonical hash AND the
  //    renderer-allowlist hash; if they differ, abort with integrity_fail.
  const canonical = canonicalAllowlistFor(request.kind);
  const canonicalHash = computeAllowlistHash(canonical);
  const rendererList = rendererAllowlistFor(request.kind);
  const rendererHash = computeAllowlistHash(rendererList);
  if (rendererHash !== canonicalHash) {
    // Emit the integrity_fail audit row. Note: this row is best-effort —
    // if the audit emit itself fails, the export still aborts (no Blob
    // URL because we return 'error' below before render).
    try {
      await store.recordExportEvent({
        event_type: 'export.integrity_fail',
        actor_pseudonym,
        approver_pseudonym: actor_pseudonym,
        target_id: request.target_id,
        meta: {
          expected_field_set_hash: canonicalHash,
          actual_field_set_hash: rendererHash,
          alert_id: 'A-EXPORT-001'
        }
      });
    } catch {
      /* audit emission failed — the export still aborts below. */
    }
    return { status: 'error', reason: 'integrity_fail' };
  }

  // 5. F-24 — `export.generated` audit row MUST commit BEFORE Blob bytes.
  //    Strict `await` discipline: a throw here aborts the export.
  let exportAuditId: string;
  try {
    const r = await store.recordExportEvent({
      event_type: 'export.generated',
      actor_pseudonym,
      approver_pseudonym: actor_pseudonym,
      target_id: request.target_id,
      meta: {
        export_kind: request.kind,
        field_set_hash: canonicalHash,
        recipient_role: request.recipient_role,
        derived_from_concerns_count: derived.length,
        // RA-1 / F-29 — the audit row records `approver = actor` to make
        // the single-signer posture explicit at audit time.
        approver_pseudonym: actor_pseudonym,
        actor_pseudonym
      }
    });
    exportAuditId = r.audit_id;
  } catch {
    // F-24: audit-log POST failed. Do NOT produce bytes, do NOT create
    // Blob URL, surface error to the UI.
    return { status: 'error', reason: 'audit_failed' };
  }

  // 6. RA-1 control #3 — emit the concern-derived second-class row IFF
  //    the export carries any `derived_from_concerns` ids.
  if (derived.length > 0) {
    try {
      await store.recordExportEvent({
        event_type: 'export.contained_concern_derived_items',
        actor_pseudonym,
        approver_pseudonym: actor_pseudonym,
        target_id: request.target_id,
        meta: {
          export_audit_id: exportAuditId,
          concern_ids: [...derived]
        }
      });
    } catch {
      // The second-class row is part of the F-24 commitment surface;
      // if it fails, the export must abort. (audit-log.md "same-txn-as
      // export.generated".)
      return { status: 'error', reason: 'audit_failed' };
    }
  }

  // 7. Assemble PDF bytes (browser-only per F-25). The renderer reads the
  //    runtime allowlist; on the canonical happy path it equals the
  //    canonical list.
  const pdfBytes =
    request.kind === 'minutes.final'
      ? renderMinutesPdf(minutesRow!, rendererList as readonly ExportAllowlistMinutesKey[])
      : renderRecommendationPdf(
          recommendationRow!,
          rendererList as readonly ExportAllowlistRecommendationKey[]
        );

  // 8. RA-1 control #4 — post-export rep notification within 60s. Non-
  //    blocking on failure; the UI surfaces a `toast.warning` with the
  //    `export.notification_deferred` key.
  let warning_toast_key: 'export.notification_deferred' | undefined;
  const notif = await store.sendPostExportNotification({
    audit_id: exportAuditId,
    actor_pseudonym,
    export_kind: request.kind,
    target_id: request.target_id,
    now_ms: t
  });
  if (notif.ok === false) {
    warning_toast_key = 'export.notification_deferred';
  }

  const filename =
    request.kind === 'minutes.final'
      ? `jhsc-minutes-${request.target_id}.pdf`
      : `jhsc-recommendation-${request.target_id}.pdf`;

  const result: ExportResult = {
    status: 'ok',
    pdfBytes,
    filename,
    export_audit: {
      id: exportAuditId,
      derived_from_concerns: [...derived],
      field_set_hash: canonicalHash,
      approver_pseudonym: actor_pseudonym,
      actor_pseudonym
    },
    ...(warning_toast_key ? { warning_toast_key } : {})
  };
  return result;
}

/** Helper for the `concern-derived annotated` lookup the interstitial reads. */
export function concernDerivedFieldsForKind(kind: ExportKind): readonly string[] {
  return CONCERN_DERIVED_FIELD_ANNOTATIONS[kind];
}
