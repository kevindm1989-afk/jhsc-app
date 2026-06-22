/**
 * Concern intake library (T08).
 *
 * Per ADR-0002 Amendment H this module ships only the library code:
 *   - Types + ConcernStore interface
 *   - MemoryConcernStore (test wiring)
 *   - submitConcern / updateConcernText / listConcerns / revealSource
 *
 * The SupabaseConcernStore + SQL migration land in T08.1 per the
 * sibling-task pattern (see `.context/known-gaps.md` G-T08-*).
 */

export type {
  ConcernAuditEvent,
  ConcernIntake,
  ConcernListItem,
  ConcernRow,
  ConcernSource,
  ConcernSourceReveal,
  ConcernUpdate,
  HazardClass,
  Severity
} from './types';
export { CONCERN_AUDIT_EVENTS } from './types';
export type { ConcernAuditEmission, ConcernStore, InsertDenied, InsertOk } from './concern-store';
export { MemoryConcernStore } from './memory-concern-store';
export { listConcerns, revealSource, submitConcern, updateConcernText } from './concern-core';
export type {
  ConcernCoreOpts,
  SubmitConcernDenied,
  SubmitConcernOk,
  SubmitConcernResult
} from './concern-core';

// Phase 2a PR2 (ADR-0027 / P2a-5) — public seal/open surface re-export so the
// production compositions and any other consumer can import from
// `$lib/concerns` (the rule-of-three extraction note).
export { openUtf8, sealUtf8 } from './seal';

// Phase 2a PR2 (ADR-0027 / P2a-7) — production compositions over the
// CommitteeKeyHolder dwell (Decision 1) + the unwrap composition (PR1).
export {
  listConcernsViaProduction,
  revealConcernSourceViaProduction,
  submitConcernViaProduction
} from './production-flows';
export type {
  ListConcernsViaProductionArgs,
  ListConcernsViaProductionResult,
  ListedConcern,
  RevealConcernSourceViaProductionArgs,
  RevealConcernSourceViaProductionResult,
  SubmitConcernViaProductionArgs,
  SubmitConcernViaProductionResult
} from './production-flows';
