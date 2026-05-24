/**
 * Re-export the in-memory wipe store from the wipe-store module so test
 * files can deep-import either path interchangeably.
 *
 * The TestWipeStore split is documented in ./wipe-store.ts per ADR-0020
 * Decision 4.
 */

export { MemoryWipeStore } from './wipe-store';
export type { TestWipeStore, WipeStore, PanicWipeAuditRow, WipeClass } from './wipe-store';
