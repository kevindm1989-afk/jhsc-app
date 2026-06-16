/**
 * Test-only client surface for the export library (G-T11-21 split).
 *
 * `TestExportClient` is the adapter the test harness wires `supa.client(user)`
 * objects into. It carries the three test-only `__` hooks the convenience
 * wrappers `exportMinutes` / `exportRecommendation` (declared in `./index.ts`)
 * consume at runtime to assemble an `ExportRequest`.
 *
 * The split mirrors the proven pattern from T13 reprisal-store / T14
 * work-refusal-store / T18 audit-integrity-store: production callers see
 * the narrow `ExportClient` interface; test code deep-imports
 * `TestExportClient` (this file is intentionally NOT re-exported from
 * `./index.ts` — see the `lib/export` barrel + the ESLint
 * `no-restricted-imports` rule structure mirrored across libs).
 *
 * Future `SupabaseExportClient` (T11.1) implements `ExportClient` only —
 * narrowing it back to `TestExportClient` is a type error.
 *
 * Source: privacy-review-t11-t12.md P-10 + second-opinion CF-4 → G-T11-21.
 */

import type { ExportStore } from './export-store';
import type { ReauthAssertion } from './types';

/**
 * Production marker for export-capable clients. Empty by design —
 * production wire-up (T11.1) supplies the store / actor / re-auth assertion
 * via explicit `proceedExport({store, now}, request, assertion)` calls; the
 * client object itself never carries the export wiring on the production
 * code path. Future production methods can be added here if architect
 * decides; for now the empty marker forbids the test-only `__` hooks at
 * the type level.
 *
 * The empty-interface lint is intentionally disabled — the structural
 * "extends" relationship between `TestExportClient` and `ExportClient`
 * is what makes the split a compile-time defense (narrowing back from
 * `TestExportClient` to `ExportClient` is fine; the reverse requires
 * an explicit cast that a reviewer would flag).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ExportClient {}

/**
 * Test-only superset. Adds the three hooks the harness wires onto its
 * client objects so the convenience wrappers can fetch the export-store,
 * actor pseudonym, and re-auth assertion from a single bag.
 */
export interface TestExportClient extends ExportClient {
  __getActorUserId(): string;
  __getExportStore(): ExportStore;
  __getReauthAssertion(): ReauthAssertion | null;
}
