/**
 * WipeStore interface + MemoryWipeStore + BrowserWipeStore.
 *
 * Per ADR-0020 Decision 4:
 *   - `WipeStore` is the production interface.
 *   - `TestWipeStore extends WipeStore` adds `__debug*` seams.
 *   - `MemoryWipeStore` implements `TestWipeStore` (jsdom-friendly).
 *   - `BrowserWipeStore` implements `WipeStore` only (production path).
 *
 * Per F-106 M-106a: `emitAudit` returns `{ok: false}` to signal
 * audit-emit failure; the caller (`panicWipe`) MUST NOT invoke any
 * `clear*` method when this happens (audit-BEFORE-side-effect).
 *
 * Per F-109 M-109a + G-T19-8: `BrowserWipeStore.clearCaches` calls
 * `await caches.keys()` to enumerate dynamically — no hard-coded
 * cache-name array.
 */

export type WipeClass =
  | 'indexeddb'
  | 'caches'
  | 'sessionstorage'
  | 'localstorage'
  | 'session_cookie';

export interface PanicWipeAuditRow {
  event_type: 'panic_wipe.invoked';
  ts: number;
  meta: {
    surface: 'settings' | 'lock_screen';
    wipe_scope: 'local_only';
    completed: boolean;
    partial_failure_classes: readonly Exclude<WipeClass, 'session_cookie'>[] | readonly WipeClass[];
  };
}

/**
 * G-T19-PRIV-3 — minimal external emitter contract for the production
 * `panic_wipe.invoked` audit row. `BrowserWipeStore` does NOT directly
 * import `SupabaseT07Client` (the lock module stays free of crypto /
 * Supabase coupling); instead, callers construct a thin adapter that
 * routes `recordPanicWipeInvoked` to whatever transport is wired (today:
 * the t07-op `record_panic_wipe` op via `SupabaseT07Client`).
 *
 * The return shape mirrors `emitAudit`'s `{ok: boolean}` contract so
 * the adapter is a one-line shim. `false` on the audit emit means
 * `panicWipe()` MUST abort (F-53 / M-106a audit-before-side-effect).
 */
export interface PanicWipeAuditEmitter {
  recordPanicWipeInvoked(input: { meta: Record<string, unknown> }): Promise<{ ok: boolean }>;
}

export interface WipeStore {
  clearIndexedDb(
    databaseNames: readonly string[]
  ): Promise<{ ok: boolean; failed: readonly string[] }>;
  clearCaches(cacheNames: readonly string[]): Promise<{ ok: boolean; failed: readonly string[] }>;
  clearSessionStorage(): Promise<{ ok: boolean }>;
  clearLocalStorage(): Promise<{ ok: boolean }>;
  tearDownSessionCookie(): Promise<{ ok: boolean }>;
  /** F-106 M-106a — MUST be called BEFORE any clear* call. */
  emitAudit(row: PanicWipeAuditRow): Promise<{ ok: boolean }>;
  /** F-66 monotonic clock shim. */
  nowMs(): number;
}

export interface TestWipeStore extends WipeStore {
  __debugListClearedDatabases(): readonly string[];
  __debugListClearedCaches(): readonly string[];
  __debugListEmittedAuditRows(): readonly PanicWipeAuditRow[];
  __debugSessionStorageCleared(): boolean;
  __debugLocalStorageCleared(): boolean;
  __debugSessionCookieTornDown(): boolean;
  __debugForceAuditFailure(): void;
  __debugForceClearFailure(target: WipeClass): void;
  __debugSetClock(ms: number): void;
}

// ============================================================================
// MemoryWipeStore — TestWipeStore for jsdom suites
// ============================================================================

/**
 * In-memory WipeStore for tests. The `__debugForce*` seams are
 * production-stripped at build time per ADR-0020 Decision 8; runtime
 * usage outside MODE !== 'production' is the test contract.
 */
export class MemoryWipeStore implements TestWipeStore {
  private clearedDatabases: string[] = [];
  private clearedCaches: string[] = [];
  private emittedRows: PanicWipeAuditRow[] = [];
  private sessionStorageCleared = false;
  private localStorageCleared = false;
  private sessionCookieTornDown = false;
  private forceAuditFail = false;
  private forceClearFailures = new Set<WipeClass>();
  private clockMs: number | null = null;

  async clearIndexedDb(databaseNames: readonly string[]) {
    if (this.forceClearFailures.has('indexeddb')) {
      return { ok: false, failed: [...databaseNames] };
    }
    for (const n of databaseNames) this.clearedDatabases.push(n);
    return { ok: true, failed: [] as readonly string[] };
  }
  async clearCaches(cacheNames: readonly string[]) {
    if (this.forceClearFailures.has('caches')) {
      return { ok: false, failed: [...cacheNames] };
    }
    for (const n of cacheNames) this.clearedCaches.push(n);
    return { ok: true, failed: [] as readonly string[] };
  }
  async clearSessionStorage() {
    if (this.forceClearFailures.has('sessionstorage')) return { ok: false };
    this.sessionStorageCleared = true;
    return { ok: true };
  }
  async clearLocalStorage() {
    if (this.forceClearFailures.has('localstorage')) return { ok: false };
    this.localStorageCleared = true;
    return { ok: true };
  }
  async tearDownSessionCookie() {
    if (this.forceClearFailures.has('session_cookie')) return { ok: false };
    this.sessionCookieTornDown = true;
    return { ok: true };
  }
  async emitAudit(row: PanicWipeAuditRow) {
    if (this.forceAuditFail) return { ok: false };
    this.emittedRows.push(row);
    return { ok: true };
  }
  nowMs(): number {
    return this.clockMs ?? Date.now();
  }

  // ----- test-only seams (production-stripped) -----
  __debugListClearedDatabases() {
    return [...this.clearedDatabases];
  }
  __debugListClearedCaches() {
    return [...this.clearedCaches];
  }
  __debugListEmittedAuditRows() {
    return [...this.emittedRows];
  }
  __debugSessionStorageCleared() {
    return this.sessionStorageCleared;
  }
  __debugLocalStorageCleared() {
    return this.localStorageCleared;
  }
  __debugSessionCookieTornDown() {
    return this.sessionCookieTornDown;
  }
  __debugForceAuditFailure() {
    this.forceAuditFail = true;
  }
  __debugForceClearFailure(target: WipeClass) {
    this.forceClearFailures.add(target);
  }
  __debugSetClock(ms: number) {
    this.clockMs = ms;
  }
}

// ============================================================================
// BrowserWipeStore — production path (browser globals)
// ============================================================================

/**
 * Production WipeStore that wraps the browser's IndexedDB / Cache /
 * Storage globals. The `clearCaches` implementation does NOT take a
 * hard-coded subset; callers MUST pass the result of `caches.keys()`
 * (see `panicWipe()` for the dynamic enumeration that satisfies G-T19-8).
 *
 * Optional `auditEmitter` (G-T19-PRIV-3): when provided, `emitAudit`
 * forwards the row's meta through the emitter (production wiring routes
 * to the t07-op `record_panic_wipe` op via `SupabaseT07Client`). When
 * NOT provided — e.g. an offline-first build that hasn't wired auth yet
 * — `emitAudit` stays fail-closed (returns `{ok: false}`) so the F-53
 * audit-before-side-effect contract holds even when the transport is
 * absent. The constructor signature is back-compat: no-args still works
 * for callers that wire the emitter later.
 */
export interface BrowserWipeStoreOptions {
  auditEmitter?: PanicWipeAuditEmitter;
}

export class BrowserWipeStore implements WipeStore {
  private auditEmitter: PanicWipeAuditEmitter | undefined;

  constructor(opts: BrowserWipeStoreOptions = {}) {
    this.auditEmitter = opts.auditEmitter;
  }

  async clearIndexedDb(databaseNames: readonly string[]) {
    const failed: string[] = [];
    for (const name of databaseNames) {
      try {
        await new Promise<void>((resolve, reject) => {
          if (typeof indexedDB === 'undefined') {
            return reject(new Error('indexedDB unavailable'));
          }
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'));
          req.onblocked = () => resolve();
        });
      } catch {
        failed.push(name);
      }
    }
    return { ok: failed.length === 0, failed };
  }

  /**
   * G-T19-8 contract: `BrowserWipeStore.clearCaches` enumerates the
   * Cache Storage API DYNAMICALLY via `caches.keys()` rather than trust
   * the caller-supplied list as the source of truth. This protects against
   * the F-109 mitigation hole where a future ADR-0013 service-worker
   * cache addition lands without the wipe-side allowlist getting
   * updated in lockstep — a hard-coded `clearCaches(['cache-a'])` would
   * silently leave the new cache un-wiped on a panic. The dynamic
   * enumeration captures EVERY cache present at wipe time.
   *
   * The `cacheNames` parameter is preserved for the WipeStore interface
   * contract (MemoryWipeStore still uses it for hermetic test injection)
   * but is IGNORED here — the production behaviour is "wipe everything
   * the browser knows about." If `caches.keys()` fails or the Cache
   * Storage API is absent, we fall back to the caller-supplied list as
   * a best-effort `failed` signal so the panic-wipe outer audit row's
   * `partial_failure_classes` carries useful forensic info.
   */
  async clearCaches(cacheNames: readonly string[]) {
    const failed: string[] = [];
    const c = (globalThis as { caches?: CacheStorage }).caches;
    if (!c) return { ok: false, failed: [...cacheNames] };
    let dynamicNames: string[];
    try {
      dynamicNames = await c.keys();
    } catch {
      // Cache Storage API present but enumeration threw. Treat the
      // caller-supplied list as the failure surface so the audit row
      // carries something useful.
      return { ok: false, failed: [...cacheNames] };
    }
    for (const name of dynamicNames) {
      try {
        const ok = await c.delete(name);
        if (!ok) failed.push(name);
      } catch {
        failed.push(name);
      }
    }
    return { ok: failed.length === 0, failed };
  }

  async clearSessionStorage() {
    try {
      sessionStorage.clear();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async clearLocalStorage() {
    try {
      localStorage.clear();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async tearDownSessionCookie() {
    // Best-effort cookie clear in browser context. Production deployments
    // route through SvelteKit's cookies helper at the server boundary.
    try {
      const expire = 'expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      if (typeof document !== 'undefined') {
        for (const c of document.cookie.split(';')) {
          const name = c.split('=')[0]!.trim();
          document.cookie = `${name}=; ${expire}`;
        }
      }
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async emitAudit(row: PanicWipeAuditRow): Promise<{ ok: boolean }> {
    // G-T19-PRIV-3: when an `auditEmitter` is wired, forward the row's
    // meta verbatim. The SQL function (record_panic_wipe_invoked,
    // migration 0011) adds the server-derived `actor_id` and stamps
    // the canonical event_type / retention_class. When no emitter is
    // wired we stay fail-closed (F-53 / M-106a) so the caller
    // (`panicWipe`) returns `audit_failed` and leaves local state
    // intact rather than performing a wipe with no audit trail.
    if (!this.auditEmitter) return { ok: false };
    try {
      return await this.auditEmitter.recordPanicWipeInvoked({ meta: row.meta });
    } catch {
      // Network error / transport failure → fail-closed. The user can
      // retry once connectivity returns.
      return { ok: false };
    }
  }

  nowMs(): number {
    return Date.now();
  }
}
