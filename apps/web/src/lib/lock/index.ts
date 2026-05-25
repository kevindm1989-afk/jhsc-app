/**
 * Public re-exports for the lock / panic-wipe library.
 *
 * @see ADR-0020 §Decision 1 (file-level structure)
 */

export { panicWipe, IDB_DATABASE_NAMES } from './panic-wipe';
export type { PanicWipeResult, PanicWipeStatus } from './panic-wipe';
export { BrowserWipeStore, MemoryWipeStore } from './wipe-store';
export type { WipeStore, TestWipeStore, PanicWipeAuditRow, WipeClass } from './wipe-store';
