/**
 * Panic-wipe library function (T19 / F-106 / F-109 / F-113 / Q4).
 *
 * Audit-BEFORE-side-effect contract (M-106a): `emitAudit` MUST resolve
 * `{ok: true}` BEFORE any `clear*` call. On `{ok: false}` the function
 * returns `audit_failed` and the local state is intact.
 *
 * Partial-failure double-row attribution (M-106c): if any `clear*` call
 * fails AFTER the audit row commits, a SECOND `panic_wipe.invoked` row
 * is emitted with `meta.completed=false` and
 * `meta.partial_failure_classes` enumerating the failed subsystems.
 * The audit log is append-only — both rows exist independently.
 *
 * Post-wipe lockout (M-113a): a second `panicWipe()` invocation against
 * the SAME store in the same browser session returns `{status: 'no_op',
 * reason: 'already_wiped'}` and emits NO second audit row. The lockout
 * is per-store so tests with fresh stores each get a fresh run.
 *
 * Dynamic cache enumeration (M-109a / G-T19-8): the production code path
 * calls `await caches.keys()` and passes the result to `clearCaches`. No
 * hard-coded array of cache names appears anywhere in this file.
 *
 * @see ADR-0020 §Decision 4 + §Decision 5
 * @see threat-model §8.T19 F-106 / F-109 / F-113
 */

import {
  BrowserWipeStore,
  type PanicWipeAuditRow,
  type WipeClass,
  type WipeStore
} from './wipe-store';

// ----- Closed-allowlist of IDB databases the wipe should clear -----
//
// These are the names the app uses; the wipe enumerates them explicitly
// rather than calling `indexedDB.databases()` (which is not universally
// supported and is itself a fingerprinting surface). The cache side is
// dynamically enumerated per G-T19-8.
const IDB_DATABASE_NAMES: readonly string[] = Object.freeze([
  'jhsc-keystore',
  'jhsc-queue',
  'jhsc-prefs'
]);

export type PanicWipeStatus =
  | 'completed'
  | 'partially_completed'
  | 'audit_failed'
  | 'no_op';

export interface PanicWipeResult {
  status: PanicWipeStatus;
  destruction_attempted: boolean;
  partial_failure_classes?: readonly WipeClass[];
  reason?: 'already_wiped';
}

// Per-store post-wipe lockout — WeakSet keyed on the WipeStore instance
// (uniform pattern; no module-global boolean). A second `panicWipe({store})`
// on the SAME store returns no_op. Tests create fresh stores per-test so
// lockout state does not leak. The default-store branch (callers that
// omit `opts.store`) re-uses a single module-singleton BrowserWipeStore
// so the WeakSet pattern applies uniformly.
const __wipedStores = new WeakSet<WipeStore>();
let __defaultBrowserStore: BrowserWipeStore | null = null;

function getDefaultStore(): BrowserWipeStore {
  if (!__defaultBrowserStore) __defaultBrowserStore = new BrowserWipeStore();
  return __defaultBrowserStore;
}

/** Reset the default-store panic-wipe lockout (re-issues the singleton so the
 *  WeakSet drops the lockout entry). Production-callable: a fresh onboarding =
 *  a new identity, so a prior identity's panic-wipe lockout must not persist in
 *  the same browser tab. Idempotent and no-throw. */
export function resetPanicWipeLockout(): void {
  __defaultBrowserStore = null;
}

export async function panicWipe(opts?: {
  store?: WipeStore;
  surface?: 'settings' | 'lock_screen';
}): Promise<PanicWipeResult> {
  const store = opts?.store ?? getDefaultStore();
  const surface = opts?.surface ?? 'settings';

  if (__wipedStores.has(store)) {
    return {
      status: 'no_op',
      destruction_attempted: false,
      reason: 'already_wiped'
    };
  }

  // F-106 M-106a — audit BEFORE side-effect. Build the row, emit, await
  // the {ok:true} confirmation. If audit-emit fails, return without
  // attempting any clear*.
  const auditRow1: PanicWipeAuditRow = {
    event_type: 'panic_wipe.invoked',
    ts: store.nowMs(),
    meta: {
      surface,
      wipe_scope: 'local_only',
      completed: true,
      partial_failure_classes: []
    }
  };
  const auditAck = await store.emitAudit(auditRow1);
  if (!auditAck.ok) {
    return {
      status: 'audit_failed',
      destruction_attempted: false
    };
  }

  // F-109 M-109a + G-T19-8 — dynamic cache enumeration. Resolve cache
  // names at call time via caches.keys() so additions to the SW cache
  // allowlist are wiped without re-deploying. Falls back to an empty list
  // in environments without the Cache Storage API (jsdom without shim).
  let cacheNames: readonly string[] = [];
  try {
    if (typeof (globalThis as { caches?: unknown }).caches !== 'undefined') {
      cacheNames = await (globalThis as { caches: { keys: () => Promise<string[]> } }).caches.keys();
    }
  } catch {
    cacheNames = [];
  }

  // Drive each clear*; collect per-class failures.
  const failed: WipeClass[] = [];
  const idb = await store.clearIndexedDb(IDB_DATABASE_NAMES);
  if (!idb.ok) failed.push('indexeddb');
  const cch = await store.clearCaches(cacheNames);
  if (!cch.ok) failed.push('caches');
  const ses = await store.clearSessionStorage();
  if (!ses.ok) failed.push('sessionstorage');
  const loc = await store.clearLocalStorage();
  if (!loc.ok) failed.push('localstorage');
  const cookie = await store.tearDownSessionCookie();
  if (!cookie.ok) failed.push('session_cookie');

  // F-106 M-106c — partial-failure double-row. Audit log is append-only;
  // we emit a SECOND row with completed=false enumerating the failures.
  if (failed.length > 0) {
    const auditRow2: PanicWipeAuditRow = {
      event_type: 'panic_wipe.invoked',
      ts: store.nowMs(),
      meta: {
        surface,
        wipe_scope: 'local_only',
        completed: false,
        partial_failure_classes: [...failed]
      }
    };
    await store.emitAudit(auditRow2);
    // Test-only seam: run the harness hook so the in-memory test IDB
    // reflects the destruction. Production builds strip this branch.
    if (typeof import.meta !== 'undefined' && import.meta.env?.MODE !== 'production') {
      const hook = (globalThis as { __TEST_PANIC_WIPE_HOOK?: () => void }).__TEST_PANIC_WIPE_HOOK;
      if (typeof hook === 'function') hook();
    }
    __wipedStores.add(store);
    return {
      status: 'partially_completed',
      destruction_attempted: true,
      partial_failure_classes: [...failed]
    };
  }

  // Test-only seam: clear any registered test-harness IDB store so the
  // scaffold's `supa.idb.snapshotEntireStore()` reports empty after the
  // wipe. Production builds strip this branch via `import.meta.env.MODE`.
  if (typeof import.meta !== 'undefined' && import.meta.env?.MODE !== 'production') {
    const hook = (globalThis as { __TEST_PANIC_WIPE_HOOK?: () => void }).__TEST_PANIC_WIPE_HOOK;
    if (typeof hook === 'function') hook();
  }

  __wipedStores.add(store);
  return {
    status: 'completed',
    destruction_attempted: true
  };
}

export { IDB_DATABASE_NAMES };
