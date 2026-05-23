/**
 * Reprisal log library (T13).
 *
 * Per ADR-0002 Amendment H this module ships only the library code:
 *   - Types + ReprisalStore interface
 *   - MemoryReprisalStore (test wiring)
 *   - reprisal-core operations
 *
 * The SupabaseReprisalStore + SQL migration land in T13.1 per the
 * sibling-task pattern (see `.context/known-gaps.md` G-T13-*).
 */

export type {
  MemberRole,
  PendingFourEyesOp,
  ReprisalAuditEvent,
  ReprisalEntry,
  ReprisalFeedItem,
  ReprisalIntake,
  ReprisalStatus
} from './types';
export { REPRISAL_AUDIT_EVENTS } from './types';

export type {
  InsertReprisalDenied,
  InsertReprisalOk,
  ReprisalAuditEmission,
  ReprisalStore
} from './reprisal-store';

export { MemoryReprisalStore } from './memory-reprisal-store';

export {
  approveForensicReveal,
  approveStatusChange,
  attemptReadWithPassphrase,
  fetchForensicReveal,
  fetchMyActivity,
  listReprisalFeed,
  proposeForensicReveal,
  proposeStatusChange,
  readReprisalEntry,
  submitReprisal,
  updateReprisalText
} from './reprisal-core';

export type {
  ApproveResult,
  ForensicRevealView,
  ReadReprisalDenied,
  ReadReprisalOk,
  ReprisalCoreOpts,
  SubmitReprisalDenied,
  SubmitReprisalOk,
  SubmitReprisalResult
} from './reprisal-core';
