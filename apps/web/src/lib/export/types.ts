/**
 * Export pipeline types (T11/T12).
 *
 * The export pipeline is the only egress at trust boundary B3 — the
 * worker side hands a co-chair-rendered, allowlist-filtered PDF to the
 * employer co-chair. The library deliverable per ADR-0002 Amendment H
 * stops at the closed-allowlist render path + the audit-emit-then-blob
 * discipline (F-24). The SupabaseExportStore + SQL migration land in
 * T11.1/T12.1 (G-T11-* and G-T12-* in `.context/known-gaps.md`).
 *
 * Source obligations:
 *   - F-19 — closed allowlist; ESLint forbids spread.
 *   - F-22 — RLS on finalized minutes.
 *   - F-24 / HG-6 mirror — audit row commits BEFORE Blob URL creation.
 *   - F-25 — no server-side PDF rendering.
 *   - F-27 — allowlist hash bound to the renderer.
 *   - F-28 — 10 exports/co-chair/hour; 11th = 429.
 *   - F-29 / HG-1 / RA-1 — single-signer co-chair passkey re-auth.
 *   - RA-1 compensating control #3 — concern-derived-items flag.
 *   - RA-1 compensating control #4 — post-export rep notification.
 *   - observability/audit-log.md `export.*` event shapes.
 */

/**
 * Export document kind. The renderer dispatches on this tag to choose
 * the allowlist + the PDF layout.
 */
export type ExportKind = 'minutes.final' | 'recommendation';

/**
 * Request input to `prepareExport` / `proceedExport`. The caller (the
 * Svelte interstitial) constructs this from the row id; the library
 * fetches the row data internally.
 */
export interface ExportRequest {
  kind: ExportKind;
  target_id: string;
  actor_user_id: string;
  /** Recipient role label rendered into the audit row and the UI. */
  recipient_role: 'employer_co_chair';
}

/**
 * The closed-set audit events the export library may emit. Mirrors the
 * `audit-log.md` enum.
 */
export const EXPORT_AUDIT_EVENTS = [
  'export.generated',
  'export.contained_concern_derived_items',
  'export.integrity_fail'
] as const;

export type ExportAuditEvent = (typeof EXPORT_AUDIT_EVENTS)[number];

/**
 * Result returned by `prepareExport`. The interstitial uses this shape to
 * render the field list (by label) and the concern-derived flag.
 */
export interface ExportPreparation {
  ok: true;
  kind: ExportKind;
  target_id: string;
  /** The full field-list to render in the interstitial, in display order. */
  field_set: readonly string[];
  /** SHA-256 of the rendered field-list — bound into the audit row (F-27). */
  field_set_hash: string;
  /** Originating concern IDs (RA-1 control #3). Empty array when absent. */
  derived_from_concerns: readonly string[];
  /** Hazard class per originating concern (UI annotation). */
  concern_meta: ReadonlyArray<{ concern_id: string; hazard_class: string }>;
}

export interface ExportRejection {
  ok: false;
  reason:
    | 'requires_reauth'
    | 'rate_limited'
    | 'rls_denied'
    | 'integrity_fail'
    | 'not_found'
    | 'audit_failed';
  status?: number;
  body?: Record<string, unknown>;
}

/**
 * `proceedExport` result. The PDF bytes are returned to the caller; the
 * caller (the Svelte component) is responsible for creating the Blob URL
 * AFTER it confirms the audit row landed.
 *
 * The `status` discriminator:
 *   - `'ok'`            → audit landed + bytes produced; warning_toast_key
 *                         may carry the post-export notification deferral
 *                         signal (RA-1 control #4).
 *   - `'error'`         → audit failed OR integrity check failed; NO bytes,
 *                         NO Blob URL is allowed downstream.
 *   - `'requires_reauth'` → single-signer re-auth assertion missing or invalid.
 *   - `'rate_limited'`  → F-28 budget exceeded.
 */
export interface ExportResultOk {
  status: 'ok';
  pdfBytes: Uint8Array;
  filename: string;
  export_audit: {
    id: string;
    derived_from_concerns: readonly string[];
    field_set_hash: string;
    approver_pseudonym: string;
    actor_pseudonym: string;
  };
  /** Set when the rep-notification path failed; non-blocking (RA-1 #4). */
  warning_toast_key?: 'export.notification_deferred';
}

export interface ExportResultError {
  status: 'error' | 'requires_reauth' | 'rate_limited';
  reason: ExportRejection['reason'];
}

export type ExportResult = ExportResultOk | ExportResultError;

/**
 * Re-auth assertion handed from the WebAuthn ceremony to `proceedExport`.
 * The library does NOT validate the assertion shape beyond presence + the
 * `actor_user_id` match; the production T11.1 wires a real
 * `navigator.credentials.get()` flow + server verification.
 */
export interface ReauthAssertion {
  /** Opaque ceremony id — the production gate verifies signature + counter. */
  ceremony_id: string;
  /** The actor who completed the assertion (must equal `request.actor_user_id`). */
  actor_user_id: string;
  /** ms-epoch the assertion was issued; library rejects > 5 min old. */
  issued_at_ms: number;
}
