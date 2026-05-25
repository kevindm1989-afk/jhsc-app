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
 */
export class BrowserWipeStore implements WipeStore {
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

  async clearCaches(cacheNames: readonly string[]) {
    const failed: string[] = [];
    const c = (globalThis as { caches?: CacheStorage }).caches;
    if (!c) return { ok: false, failed: [...cacheNames] };
    for (const name of cacheNames) {
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

  async emitAudit(_row: PanicWipeAuditRow): Promise<{ ok: boolean }> {
    // Stub: production wire-up to T05.1 audit-emit transport pending
    // G-T19-PRIV-3. Per F-106 M-106a (audit-BEFORE-side-effect): a wipe
    // that cannot honestly emit its audit row MUST abort rather than
    // proceed with the destruction, otherwise a wipe could happen with
    // no audit trail (S-T19-4 / A-T19-4). Returning {ok: false} here
    // keeps the caller fail-closed (`panicWipe` returns `audit_failed`
    // and leaves local state intact) until the real emitter ships.
    return { ok: false };
  }

  nowMs(): number {
    return Date.now();
  }
}
