/**
 * Work-refusal library (T14) — OHSA s.43.
 *
 * Per ADR-0002 Amendment H this module ships only the library code:
 *   - Types + WorkRefusalStore interface
 *   - MemoryWorkRefusalStore (test wiring)
 *   - work-refusal-core operations
 *
 * The SupabaseWorkRefusalStore + SQL migration land in T14.1 per the
 * sibling-task pattern (see `.context/known-gaps.md` G-T14-*).
 */

export type {
  WorkRefusalAuditEvent,
  WorkRefusalEntry,
  WorkRefusalIntake,
  WorkRefusalListItem,
  WorkRefusalStatus
} from './types';
export { WORK_REFUSAL_AUDIT_EVENTS } from './types';

export type {
  InsertWorkRefusalDenied,
  InsertWorkRefusalOk,
  WorkRefusalAuditEmission,
  WorkRefusalStore
} from './work-refusal-store';

export { MemoryWorkRefusalStore } from './memory-work-refusal-store';

export { listWorkRefusalFeed, readWorkRefusalEntry, submitWorkRefusal } from './work-refusal-core';

export type {
  ReadWorkRefusalDenied,
  ReadWorkRefusalOk,
  SubmitWorkRefusalDenied,
  SubmitWorkRefusalOk,
  SubmitWorkRefusalResult,
  WorkRefusalCoreOpts
} from './work-refusal-core';
