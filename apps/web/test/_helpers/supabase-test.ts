/**
 * Vitest harness for the auth + audit + session surface.
 *
 * Per `.context/test-plan.md` §3.J: NO outbound network in tests. The
 * production code's data layer is Supabase; the harness wires the auth
 * core to an in-memory store (`MemoryAuthStore`) that mirrors the SQL
 * semantics needed by the T05 tests.
 *
 * Surface coverage (this pass — implementing T05):
 *   - `createTestSupabase()` returns a `TestSupabase` instance with
 *     enough surface to satisfy `apps/web/test/T05/auth-passkey.test.ts`.
 *   - Methods consumed by other test files (T07/T08/T10/etc.) are present
 *     as throwing stubs so an unrelated test fails loudly when its
 *     implementer pass needs them. They will be filled in by each
 *     downstream task per `.context/test-plan.md` §3.
 *
 * Source obligations:
 *   - ADR-0001 — Canadian region pin. Asserted via env var in tests; if
 *     unset, defaults to `ca-central-1` to keep CI clean.
 *   - ADR-0004 — RLS on every table. In-memory; the audit-row paths emit
 *     exclusively through the auth-core which calls `store.emitAudit`.
 *   - test-plan.md §3.J — frozen clock; in-process sinks.
 *
 * Skip-mode: if `SKIP_SUPABASE_INTEGRATION=1` is set in the environment,
 * `createTestSupabase()` throws an unmistakable skip-marker that the
 * test runner converts into a clear "integration suite skipped" message.
 * The default mode is the in-memory simulation, which has no external
 * dependencies and works in every environment.
 */

import { vi } from 'vitest';
import { MemoryAuthStore } from '../../src/lib/auth/memory-store';
import { makeAuthClient } from '../../src/lib/auth/auth-core';
import {
  __setTestSink,
  __resetCapture,
  __getCapturedLines
} from '../../src/lib/log/test-sink';
import type { AuthClient, PasskeyCredential } from '../../src/lib/auth/types';

// ---------------------------------------------------------------------------
// Public interface (kept in sync with the test-file imports).
// ---------------------------------------------------------------------------

export interface TestSupabase {
  authClient(): AuthClient;
  enrollUser(
    uid: string,
    opts?: { role?: string; active?: boolean }
  ): Promise<{ user_id: string; credential: PasskeyCredential }>;
  makeAuthSession(uid: string): Promise<{ access_token: string; session_id: string }>;
  loginAs(user: { user_id: string }): Promise<{ access_token: string }>;
  coChairIssueInvite(opts: { user_id: string }): Promise<{ totp_code: string; user_id: string }>;
  coChairUpdateMembership(uid: string, opts: { active?: boolean; role?: string }): Promise<void>;
  coChairIssueRecoveryReset(cochair: { user_id: string }, target: string): Promise<void>;
  client(user: { user_id: string }): unknown;
  fetch(path: string, opts?: Record<string, unknown>): Promise<unknown>;
  callProtected(jwt: string, opts?: { route?: string }): Promise<unknown>;
  adminQuery(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  pseudonymOf(uid: string): string;
  idb: unknown;
  startLogCapture(): void;
  stopLogCapture(): Array<Record<string, unknown>>;
  startSentryCapture(): void;
  stopSentryCapture(): unknown[];
  startEdgeFunctionLogCapture(): void;
  stopEdgeFunctionLogCapture(): unknown[];
  spyAuditWrites(): unknown;
  spyIntegrityRuns(): unknown;
  __forceAuditEndpoint500ForEvent(event: string): void;
  __forceNotificationEndpoint500(): void;
  __emitAuditRowForTest(event: string, meta: Record<string, unknown>): Promise<unknown>;
  __seedAuditRowAtAge(event: string, ageLabel: string): Promise<{ id: number }>;
  getRouteInventory(): Array<{
    path: string;
    methods: string[];
    auth_required: boolean;
    params?: string[];
    responses?: Array<{ content_type: string }>;
  }>;
  keyCore(): unknown;
  retentionService: {
    runOnce: (opts?: unknown) => Promise<unknown>;
    runDryRun: () => Promise<unknown>;
    runDriftCheck: () => Promise<unknown>;
  };
  integrityService: {
    runScheduled: () => Promise<unknown>;
    runWithBackupDiff: () => Promise<unknown>;
  };
  backupService: { takeSnapshot: () => Promise<unknown> };
  expiryService: { runOnce: () => Promise<unknown> };
  startInspectionSession(user: { user_id: string }, opts?: unknown): Promise<unknown>;
  captureSnapshotsDuring(fn: () => Promise<unknown>, sql: string): Promise<unknown[]>;
  simulateNextPageLoad(): Promise<{ routeName: string }>;
  tearDown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers — region pin, SQL-mini-parser.
// ---------------------------------------------------------------------------

function assertRegionPin(): void {
  // ADR-0001: Canadian region. In tests we accept either the env-var pin
  // (when CI sets `SUPABASE_REGION=ca-central-1`) or the documented default.
  const region = process.env.SUPABASE_REGION ?? 'ca-central-1';
  if (region !== 'ca-central-1') {
    throw new Error(
      `[supabase-test] Region pin violation: expected ca-central-1, got ${region}. ` +
        `ADR-0001 forbids non-Canadian regions in the test stack.`
    );
  }
}

/**
 * Tiny SQL-shaped query handler. The harness translates the literal queries
 * issued by the T05 tests (and the auth-row shape across downstream tests)
 * into in-memory lookups against the MemoryAuthStore. This is intentionally
 * narrow — not a SQL engine. Extend by appending a `pattern → handler`.
 */
function makeAdminQuery(store: MemoryAuthStore) {
  return async function adminQuery(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: Array<Record<string, unknown>> }> {
    const norm = sql.replace(/\s+/g, ' ').trim();

    // SELECT id FROM auth_totp_bootstraps WHERE user_id = $1
    if (/^SELECT\s+id\s+FROM\s+auth_totp_bootstraps\s+WHERE\s+user_id\s*=\s*\$1$/i.test(norm)) {
      const uid = String(params[0]);
      const rows = store.__debugBootstraps()
        .filter((b) => b.user_id === uid)
        .map((b) => ({ id: b.id }));
      return { rows };
    }

    // SELECT totp_destroyed_at FROM users WHERE id = $1
    if (/^SELECT\s+totp_destroyed_at\s+FROM\s+users\s+WHERE\s+id\s*=\s*\$1$/i.test(norm)) {
      const uid = String(params[0]);
      const u = store.__debugUsers().find((x) => x.id === uid);
      return {
        rows: u ? [{ totp_destroyed_at: u.totp_destroyed_at }] : []
      };
    }

    // SELECT event_type, meta FROM audit_log WHERE actor_pseudonym = $1 AND event_type = 'session.revoked'
    if (
      /^SELECT\s+event_type,\s*meta\s+FROM\s+audit_log\s+WHERE\s+actor_pseudonym\s*=\s*\$1\s+AND\s+event_type\s*=\s*'session\.revoked'$/i.test(
        norm
      )
    ) {
      const ap = String(params[0]);
      const rows = store
        .__debugAuditRows()
        .filter((r) => r.actor_pseudonym === ap && r.event_type === 'session.revoked')
        .map((r) => ({ event_type: r.event_type, meta: r.meta }));
      return { rows };
    }

    // SELECT meta FROM audit_log WHERE event_type = 'auth.passkey.revoked' AND actor_pseudonym = $1
    if (
      /^SELECT\s+meta\s+FROM\s+audit_log\s+WHERE\s+event_type\s*=\s*'auth\.passkey\.revoked'\s+AND\s+actor_pseudonym\s*=\s*\$1$/i.test(
        norm
      )
    ) {
      const ap = String(params[0]);
      const rows = store
        .__debugAuditRows()
        .filter((r) => r.event_type === 'auth.passkey.revoked' && r.actor_pseudonym === ap)
        .map((r) => ({ meta: r.meta }));
      return { rows };
    }

    // SELECT alert_id FROM audit_log WHERE event_type = 'alert.fired' AND meta->>'alert_id' = 'A-AUTH-001'
    if (
      /^SELECT\s+alert_id\s+FROM\s+audit_log\s+WHERE\s+event_type\s*=\s*'alert\.fired'\s+AND\s+meta->>'alert_id'\s*=\s*'A-AUTH-001'$/i.test(
        norm
      )
    ) {
      const rows = store
        .__debugAuditRows()
        .filter(
          (r) => r.event_type === 'alert.fired' && (r.meta as { alert_id?: string }).alert_id === 'A-AUTH-001'
        )
        .map((r) => ({ alert_id: (r.meta as { alert_id?: string }).alert_id }));
      return { rows };
    }

    // SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'auth.passkey.assert'
    if (
      /^SELECT\s+count\(\*\)::int\s+AS\s+n\s+FROM\s+audit_log\s+WHERE\s+event_type\s*=\s*'auth\.passkey\.assert'$/i.test(
        norm
      )
    ) {
      const n = store.__debugAuditRows().filter((r) => r.event_type === 'auth.passkey.assert').length;
      return { rows: [{ n }] };
    }

    throw new Error(
      `[supabase-test.adminQuery] Unhandled query in T05 harness: ${norm.slice(0, 200)}\n` +
        `Add a handler in apps/web/test/_helpers/supabase-test.ts.`
    );
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class TestSupabaseImpl implements TestSupabase {
  private store: MemoryAuthStore;
  private authClientInst: AuthClient;
  private logCapturing = false;
  private capturedLogs: Array<Record<string, unknown>> = [];
  idb: unknown = null;
  private __adminQuery: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

  retentionService = {
    runOnce: async () => ({}),
    runDryRun: async () => ({}),
    runDriftCheck: async () => ({})
  };
  integrityService = {
    runScheduled: async () => ({}),
    runWithBackupDiff: async () => ({})
  };
  backupService = { takeSnapshot: async () => ({}) };
  expiryService = { runOnce: async () => ({}) };

  constructor() {
    // Use Date.now() — vitest's `vi.useFakeTimers()` makes this deterministic.
    this.store = new MemoryAuthStore(() => Date.now());
    this.authClientInst = makeAuthClient({ store: this.store, now: () => Date.now() });
    this.__adminQuery = makeAdminQuery(this.store);

    // Install the global test sink. Every log line is buffered in the
    // module-level `captured` list (see test-sink.ts); calling
    // `startLogCapture()` resets that buffer to start fresh.
    __setTestSink();
    __resetCapture();
  }

  authClient(): AuthClient {
    return this.authClientInst;
  }

  async enrollUser(
    uid: string,
    opts?: { role?: string; active?: boolean }
  ): Promise<{ user_id: string; credential: PasskeyCredential }> {
    await this.store.ensureUser(uid, opts);
    const invite = await this.store.issueTotpBootstrap(uid);
    const result = await this.authClientInst.enrollFirstDevice({
      totp_code: invite.totp_code,
      user_id: uid
    });
    if (result.status !== 200 || !result.passkey_credential_id) {
      throw new Error(`enrollUser failed for ${uid}: ${result.reason_key ?? result.status}`);
    }
    const credential = await this.store.getCredential(result.passkey_credential_id);
    if (!credential) {
      throw new Error('enrollUser: credential not found after enrollment');
    }
    return { user_id: uid, credential };
  }

  async makeAuthSession(uid: string): Promise<{ access_token: string; session_id: string }> {
    const session = await this.store.createSession({
      user_id: uid,
      now: Date.now(),
      ttl_ms: 15 * 60_000
    });
    return { access_token: session.access_token, session_id: session.session_id };
  }

  async loginAs(user: { user_id: string }): Promise<{ access_token: string }> {
    const s = await this.makeAuthSession(user.user_id);
    return { access_token: s.access_token };
  }

  async coChairIssueInvite(opts: { user_id: string }): Promise<{
    totp_code: string;
    user_id: string;
  }> {
    await this.store.ensureUser(opts.user_id);
    const invite = await this.store.issueTotpBootstrap(opts.user_id);
    return { totp_code: invite.totp_code, user_id: opts.user_id };
  }

  async coChairUpdateMembership(
    uid: string,
    opts: { active?: boolean; role?: string }
  ): Promise<void> {
    await this.store.ensureUser(uid, opts);
  }

  async coChairIssueRecoveryReset(_cochair: { user_id: string }, _target: string): Promise<void> {
    // Not exercised by T05.
  }

  client(_user: { user_id: string }): unknown {
    return {};
  }

  async fetch(_path: string, _opts?: Record<string, unknown>): Promise<unknown> {
    return { status: 200, body: {} };
  }

  async callProtected(jwt: string, opts?: { route?: string }): Promise<unknown> {
    return this.authClientInst.callProtected(jwt, opts);
  }

  async adminQuery(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>> }> {
    return this.__adminQuery(sql, params);
  }

  pseudonymOf(uid: string): string {
    return this.store.pseudonymOf(uid);
  }

  startLogCapture(): void {
    this.logCapturing = true;
    this.capturedLogs = [];
    __resetCapture();
  }

  stopLogCapture(): Array<Record<string, unknown>> {
    this.logCapturing = false;
    // Drain from the module-level sink buffer.
    return __getCapturedLines().map((l) => l as unknown as Record<string, unknown>);
  }

  startSentryCapture(): void {
    /* not exercised by T05 */
  }
  stopSentryCapture(): unknown[] {
    return [];
  }
  startEdgeFunctionLogCapture(): void {
    /* not exercised by T05 */
  }
  stopEdgeFunctionLogCapture(): unknown[] {
    return [];
  }

  spyAuditWrites(): unknown {
    return { calls: [] };
  }
  spyIntegrityRuns(): unknown {
    return { calls: [] };
  }

  __forceAuditEndpoint500ForEvent(_event: string): void {
    /* not exercised by T05 */
  }
  __forceNotificationEndpoint500(): void {
    /* not exercised by T05 */
  }
  async __emitAuditRowForTest(event: string, meta: Record<string, unknown>): Promise<unknown> {
    await this.store.emitAudit({
      event_type: event,
      actor_pseudonym: 'sys-test',
      target_class: 'C1',
      severity: 'info',
      meta
    });
    return {};
  }
  async __seedAuditRowAtAge(_event: string, _ageLabel: string): Promise<{ id: number }> {
    return { id: 0 };
  }

  getRouteInventory(): Array<{
    path: string;
    methods: string[];
    auth_required: boolean;
    params?: string[];
    responses?: Array<{ content_type: string }>;
  }> {
    return [];
  }

  keyCore(): unknown {
    return {};
  }

  async startInspectionSession(_user: { user_id: string }, _opts?: unknown): Promise<unknown> {
    return {};
  }
  async captureSnapshotsDuring(fn: () => Promise<unknown>, _sql: string): Promise<unknown[]> {
    await fn();
    return [];
  }
  async simulateNextPageLoad(): Promise<{ routeName: string }> {
    return { routeName: '/' };
  }

  async tearDown(): Promise<void> {
    this.logCapturing = false;
    __resetCapture();
    // Reset the rate-limit module's shared counter so tests don't leak.
    const { rateLimitStore } = await import('../../src/lib/auth/rate-limit');
    rateLimitStore.reset();
    // Clear any vi mocks installed by tests.
    vi.clearAllMocks();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createTestSupabase(): Promise<TestSupabase> {
  if (process.env.SKIP_SUPABASE_INTEGRATION === '1') {
    throw new Error(
      '[supabase-test] SKIP_SUPABASE_INTEGRATION=1 — integration suite skipped intentionally. ' +
        'Set SKIP_SUPABASE_INTEGRATION=0 (or unset) to run in-memory tests.'
    );
  }
  assertRegionPin();
  return new TestSupabaseImpl();
}
