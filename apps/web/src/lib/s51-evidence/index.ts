/**
 * s.51 critical-injury evidence library (T14) — OHSA s.51.
 *
 * Per ADR-0002 Amendment H this module ships only the library code:
 *   - Types + S51EvidenceStore interface
 *   - MemoryS51EvidenceStore (test wiring)
 *   - s51-evidence-core operations
 *
 * The SupabaseS51EvidenceStore + SQL migration land in T14.1 per the
 * sibling-task pattern (see `.context/known-gaps.md` G-T14-*).
 *
 * NOTE: `decryptS51PhotoTestOnly` is intentionally NOT re-exported.
 * It is the test-only bypass for the HG-5 round-trip assertion; the
 * test harness deep-imports it (mirrors T13's `decryptBodyViaCkPriv
 * TestOnly` convention).
 */

export type {
  S51EvidenceAuditEvent,
  S51EvidenceEntry,
  S51EvidenceIntake,
  S51EvidenceListItem,
  S51EvidenceStatus
} from './types';
export { S51_EVIDENCE_AUDIT_EVENTS } from './types';

export type {
  InsertS51EvidenceDenied,
  InsertS51EvidenceOk,
  S51EvidenceAuditEmission,
  S51EvidenceStore
} from './s51-evidence-store';

export { MemoryS51EvidenceStore } from './memory-s51-evidence-store';

export { listS51EvidenceFeed, readS51Evidence, submitS51Evidence } from './s51-evidence-core';

export type {
  ReadS51EvidenceDenied,
  ReadS51EvidenceOk,
  S51EvidenceCoreOpts,
  SubmitS51EvidenceDenied,
  SubmitS51EvidenceOk,
  SubmitS51EvidenceResult
} from './s51-evidence-core';
