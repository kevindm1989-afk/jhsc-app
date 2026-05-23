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
