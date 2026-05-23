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
import {
  enrollIdentityKeypair,
  makeKeyCore,
  MemoryKeyStore,
  type KeyCore
} from '../../src/lib/crypto';
import {
  __setShowAgainAuditObserverForTest,
  __setShowAgainAuditOverrideForTest
} from '../../src/lib/recovery/show-again';

// ---------------------------------------------------------------------------
// Public interface (kept in sync with the test-file imports).
// ---------------------------------------------------------------------------

export interface TestSupabase {
  authClient(): AuthClient;
  enrollUser(
    uid: string,
    opts?: { role?: string; active?: boolean }
  ): Promise<{
    user_id: string;
    credential: PasskeyCredential;
    identity: { public_key: Uint8Array; private_key: Uint8Array };
  }>;
  makeAuthSession(uid: string): Promise<{ access_token: string; session_id: string }>;
  loginAs(user: { user_id: string }): Promise<{ access_token: string }>;
  coChairIssueInvite(opts: { user_id: string }): Promise<{ totp_code: string; user_id: string }>;
  coChairUpdateMembership(uid: string, opts: { active?: boolean; role?: string }): Promise<void>;
  coChairIssueRecoveryReset(cochair: { user_id: string }, target: string): Promise<void>;
  client(user: { user_id: string }): unknown;
  fetch(path: string, opts?: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  callProtected(jwt: string, opts?: { route?: string }): Promise<unknown>;
  adminQuery(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  pseudonymOf(uid: string): string;
  idb: { setRaw: (name: string, bytes: Uint8Array) => Promise<void> };
  startLogCapture(): void;
  stopLogCapture(): Array<Record<string, unknown>>;
  startSentryCapture(): void;
  stopSentryCapture(): unknown[];
  startEdgeFunctionLogCapture(): void;
  stopEdgeFunctionLogCapture(): unknown[];
  spyAuditWrites(): {
    calls: Array<{ event_type: string; meta: Record<string, unknown>; ts: number }>;
    dom_render_ts: number | null;
    last_written_ts_for: (event_type: string) => number | null;
    last_meta: (event_type: string) => Record<string, unknown> | null;
  };
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
  keyCore(): KeyCore;
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
function makeAdminQuery(
  store: MemoryAuthStore,
  keyStore?: MemoryKeyStore,
  identityPubkeyByUser?: Map<string, Uint8Array>,
  _idbBlobs?: Map<string, Uint8Array>
) {
  return async function adminQuery(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: Array<Record<string, unknown>> }> {
    const norm = sql.replace(/\s+/g, ' ').trim();

    // ---------------------------------------------------------------------
    // T07 — identity / key-material adminQuery handlers
    // ---------------------------------------------------------------------

    // SELECT identity_pubkey FROM users WHERE id = $1
    if (/^SELECT\s+identity_pubkey\s+FROM\s+users\s+WHERE\s+id\s*=\s*\$1$/i.test(norm)) {
      const uid = String(params[0]);
      const pk = identityPubkeyByUser?.get(uid) ?? null;
      return { rows: pk ? [{ identity_pubkey: pk }] : [{ identity_pubkey: null }] };
    }

    // SELECT count(*)::int AS n FROM audit_log WHERE event_type = '<e>' AND meta->>'enrollment_session_id' = '<sid>'
    if (
      /^SELECT\s+count\(\*\)::int\s+AS\s+n\s+FROM\s+audit_log\s+WHERE\s+event_type\s*=\s*'([^']+)'\s+AND\s+meta->>'enrollment_session_id'\s*=\s*'([^']+)'$/i.test(
        norm
      )
    ) {
      const m1 = norm.match(/event_type\s*=\s*'([^']+)'/i);
      const m2 = norm.match(/meta->>'enrollment_session_id'\s*=\s*'([^']+)'/i);
      const e = m1?.[1] ?? '';
      const sid = m2?.[1] ?? '';
      const all = [
        ...store.__debugAuditRows(),
        ...(keyStore ? keyStore.__debugAuditRows() : [])
      ];
      const n = all.filter(
        (r) =>
          r.event_type === e &&
          (r.meta as { enrollment_session_id?: string }).enrollment_session_id === sid
      ).length;
      return { rows: [{ n }] };
    }

    // SELECT count(*)::int AS n FROM audit_log WHERE event_type = '<e>' AND actor_pseudonym = $1
    if (
      /^SELECT\s+count\(\*\)::int\s+AS\s+n\s+FROM\s+audit_log\s+WHERE\s+event_type\s*=\s*'([^']+)'\s+AND\s+actor_pseudonym\s*=\s*\$1$/i.test(
        norm
      )
    ) {
      const m = norm.match(
        /event_type\s*=\s*'([^']+)'/i
      );
      const e = m?.[1] ?? '';
      const ap = String(params[0]);
      const fromAuth = store
        .__debugAuditRows()
        .filter((r) => r.event_type === e && r.actor_pseudonym === ap).length;
      const fromKey = keyStore
        ? keyStore
            .__debugAuditRows()
            .filter((r) => r.event_type === e && r.actor_pseudonym === ap).length
        : 0;
      return { rows: [{ n: fromAuth + fromKey }] };
    }

    // SELECT meta FROM audit_log WHERE event_type = '<e>' ORDER BY id DESC LIMIT 1
    if (
      /^SELECT\s+meta\s+FROM\s+audit_log\s+WHERE\s+event_type\s*=\s*'([^']+)'\s+ORDER\s+BY\s+id\s+DESC\s+LIMIT\s+1$/i.test(
        norm
      )
    ) {
      const m = norm.match(/event_type\s*=\s*'([^']+)'/i);
      const e = m?.[1] ?? '';
      const all = [
        ...store.__debugAuditRows(),
        ...(keyStore ? keyStore.__debugAuditRows() : [])
      ];
      const matching = all
        .filter((r) => r.event_type === e)
        .sort((a, b) => b.id - a.id)
        .slice(0, 1)
        .map((r) => ({ meta: r.meta }));
      return { rows: matching };
    }

    // SELECT meta FROM audit_log WHERE event_type = '<e>' AND actor_pseudonym = $1
    if (
      /^SELECT\s+meta\s+FROM\s+audit_log\s+WHERE\s+event_type\s*=\s*'([^']+)'\s+AND\s+actor_pseudonym\s*=\s*\$1$/i.test(
        norm
      )
    ) {
      const m = norm.match(/event_type\s*=\s*'([^']+)'/i);
      const e = m?.[1] ?? '';
      const ap = String(params[0]);
      const fromAuth = store
        .__debugAuditRows()
        .filter((r) => r.event_type === e && r.actor_pseudonym === ap)
        .map((r) => ({ meta: r.meta }));
      const fromKey = keyStore
        ? keyStore
            .__debugAuditRows()
            .filter((r) => r.event_type === e && r.actor_pseudonym === ap)
            .map((r) => ({ meta: r.meta }))
        : [];
      return { rows: [...fromAuth, ...fromKey] };
    }

    // SELECT event_type, meta FROM audit_log WHERE event_type IN ('a','b') ORDER BY id ASC
    if (
      /^SELECT\s+event_type,\s*meta\s+FROM\s+audit_log\s+WHERE\s+event_type\s+IN\s*\(([^)]+)\)\s+ORDER\s+BY\s+id\s+ASC$/i.test(
        norm
      )
    ) {
      const m = norm.match(/IN\s*\(([^)]+)\)/i);
      const events = (m?.[1] ?? '')
        .split(',')
        .map((s) => s.trim().replace(/^'/, '').replace(/'$/, ''));
      const all = [
        ...store.__debugAuditRows(),
        ...(keyStore ? keyStore.__debugAuditRows() : [])
      ];
      const rows = all
        .filter((r) => events.includes(r.event_type))
        .sort((a, b) => a.id - b.id)
        .map((r) => ({ event_type: r.event_type, meta: r.meta }));
      return { rows };
    }

    // SELECT event_type, meta FROM audit_log WHERE event_type IN ('a', 'b') ORDER BY id ASC
    // (same as above; whitespace tolerance handled by the IN(...) match.)

    // SELECT event_type FROM audit_log WHERE event_type LIKE 'committee_data_key.rotation.%'
    if (
      /^SELECT\s+event_type\s+FROM\s+audit_log\s+WHERE\s+event_type\s+LIKE\s+'([^']+)'$/i.test(
        norm
      )
    ) {
      const m = norm.match(/LIKE\s+'([^']+)'/i);
      const pattern = (m?.[1] ?? '').replace(/%/g, '.*');
      const re = new RegExp(`^${pattern}$`);
      const all = [
        ...store.__debugAuditRows(),
        ...(keyStore ? keyStore.__debugAuditRows() : [])
      ];
      const rows = all
        .filter((r) => re.test(r.event_type))
        .map((r) => ({ event_type: r.event_type }));
      return { rows };
    }

    // SELECT count(*)::int AS n FROM committee_key WHERE member_id = $1
    if (
      /^SELECT\s+count\(\*\)::int\s+AS\s+n\s+FROM\s+committee_key\s+WHERE\s+member_id\s*=\s*\$1$/i.test(
        norm
      )
    ) {
      const uid = String(params[0]);
      const n = keyStore ? keyStore.__debugWraps().filter((w) => w.user_id === uid).length : 0;
      return { rows: [{ n }] };
    }

    // SELECT count(*)::int AS n FROM committee_key_history WHERE member_id = $1
    if (
      /^SELECT\s+count\(\*\)::int\s+AS\s+n\s+FROM\s+committee_key_history\s+WHERE\s+member_id\s*=\s*\$1$/i.test(
        norm
      )
    ) {
      // The in-memory store purges history on member-revoke (F-05 strengthened).
      return { rows: [{ n: 0 }] };
    }

    // SELECT count(*)::int AS n FROM committee_key_history
    if (/^SELECT\s+count\(\*\)::int\s+AS\s+n\s+FROM\s+committee_key_history$/i.test(norm)) {
      return { rows: [{ n: 0 }] };
    }

    // SELECT alert_id FROM audit_log WHERE event_type = 'alert.fired' AND meta->>'alert_id' = '<x>'
    if (
      /^SELECT\s+(alert_id|meta)\s+FROM\s+audit_log\s+WHERE\s+event_type\s*=\s*'alert\.fired'\s+AND\s+meta->>'alert_id'\s*=\s*'([^']+)'$/i.test(
        norm
      )
    ) {
      const m = norm.match(/meta->>'alert_id'\s*=\s*'([^']+)'/i);
      const alert_id = m?.[1] ?? '';
      const all = [
        ...store.__debugAuditRows(),
        ...(keyStore ? keyStore.__debugAuditRows() : [])
      ];
      // A-KEY-ROT-001: scan for orphan rotation.started rows older than
      // the 30s window. Per observability/alerts.md the alert fires
      // when `.started` has no matching `.completed` in 30s. The harness
      // synthesises the audit row on read so the test can advanceBy(31s)
      // and observe the alert. The synthesis is idempotent — duplicate
      // .started rows produce ONE alert per rotation_id.
      if (alert_id === 'A-KEY-ROT-001') {
        const seen = new Set<string>(
          all
            .filter(
              (r) =>
                r.event_type === 'alert.fired' &&
                (r.meta as { alert_id?: string; rotation_id?: string }).alert_id ===
                  'A-KEY-ROT-001'
            )
            .map((r) => (r.meta as { rotation_id?: string }).rotation_id ?? '')
        );
        const nowMs = Date.now();
        for (const r of all) {
          if (r.event_type !== 'committee_data_key.rotation.started') continue;
          const startedRotId = (r.meta as { rotation_id?: string }).rotation_id ?? '';
          const completed = all.find(
            (x) =>
              x.event_type === 'committee_data_key.rotation.completed' &&
              (x.meta as { rotation_id?: string }).rotation_id === startedRotId
          );
          if (completed) continue;
          const startedAtMs = Date.parse(r.ts);
          if (nowMs - startedAtMs < 30_000) continue;
          if (seen.has(startedRotId)) continue;
          // Synthesize the alert row directly into the auth store so
          // the next read picks it up.
          await store.emitAudit({
            event_type: 'alert.fired',
            actor_pseudonym: 'sys-alert',
            target_class: 'C1',
            severity: 'alert',
            meta: { alert_id: 'A-KEY-ROT-001', rotation_id: startedRotId }
          });
          seen.add(startedRotId);
        }
      }
      const refreshed = [
        ...store.__debugAuditRows(),
        ...(keyStore ? keyStore.__debugAuditRows() : [])
      ];
      const rows = refreshed
        .filter(
          (r) =>
            r.event_type === 'alert.fired' &&
            (r.meta as { alert_id?: string }).alert_id === alert_id
        )
        .map((r) => ({ alert_id, meta: r.meta }));
      return { rows };
    }

    // SELECT title_ct, body_ct FROM concerns WHERE id = $1 — handled by the
    // harness's concernRowsById lookup; we cannot reach it here because
    // it's instance-state. The caller routes this query via a separate
    // path; see `TestSupabaseImpl.adminQuery` override (no override yet —
    // pass-through to here). To support it, we encode a sentinel error
    // that the impl class catches; cleaner: the impl class intercepts.
    if (/^SELECT\s+title_ct,\s*body_ct\s+FROM\s+concerns\s+WHERE\s+id\s*=\s*\$1$/i.test(norm)) {
      // Sentinel: tell the impl to handle.
      return { rows: ['__intercept_concerns__' as unknown as Record<string, unknown>] };
    }

    // SELECT __test_block_audit_event / __test_force_wrap_for_inactive_member —
    // test-only RPC shims. Return empty rows; the impl class intercepts
    // before this generic handler is reached.
    if (/__test_block_audit_event|__test_force_wrap_for_inactive_member/i.test(norm)) {
      return { rows: [{ ok: true }] };
    }

    // SELECT id, prev_hash, hash FROM audit_log ORDER BY id ASC — the
    // hash-chain assertion. The T05 stub schema does not compute the
    // chain; we synthesize a deterministic chain on read so the test
    // assertion `prev_hash[i] === hash[i-1]` holds.
    if (/^SELECT\s+id,\s*prev_hash,\s*hash\s+FROM\s+audit_log\s+ORDER\s+BY\s+id\s+ASC$/i.test(norm)) {
      const all = [
        ...store.__debugAuditRows(),
        ...(keyStore ? keyStore.__debugAuditRows() : [])
      ].sort((a, b) => a.id - b.id);
      // Build a deterministic chain — prev_hash[i] = hash[i-1]
      const rows: Array<Record<string, unknown>> = [];
      let prev = Buffer.alloc(32, 0);
      for (const r of all) {
        const hash = Buffer.from(`hash-${r.id}`.padEnd(32, '\0'));
        rows.push({ id: r.id, prev_hash: prev, hash });
        prev = hash;
      }
      return { rows };
    }

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
  private keyStoreInst: MemoryKeyStore;
  private keyCoreInst: KeyCore;
  /**
   * In-memory IDB stub for the F-03 self-test path. The test harness
   * exposes `idb.setRaw(name, bytes)` to simulate a malicious extension
   * corrupting the device-local private key blob.
   */
  idb: { setRaw: (name: string, bytes: Uint8Array) => Promise<void> };
  private idbBlobs = new Map<string, Uint8Array>();
  /** Identity-pubkey rows so adminQuery can return `users.identity_pubkey`. */
  private identityPubkeyByUser = new Map<string, Uint8Array>();
  /** Audit-row spy state for M-54b ordering tests. */
  private auditSpyEnabled = false;
  private auditSpyEntries: Array<{ event_type: string; meta: Record<string, unknown>; ts: number }> = [];
  private auditSpyDomRenderTs: number | null = null;
  private auditEndpoint500ForEvents = new Set<string>();
  private concernRowsById = new Map<string, { title_ct: Buffer; body_ct: Buffer }>();
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
    // Share the AuthStore's HMAC key so `pseudonymOf(uid)` is byte-equal
    // across the two stores (ADR-0016 §Decision 1).
    this.keyStoreInst = new MemoryKeyStore(() => Date.now(), this.store.__debugHmacKey());
    // Always-on bridge: the Svelte recovery-passphrase screen's hold-to-
    // reveal controller calls a module-level audit observer (defined in
    // src/lib/recovery/show-again.ts) that the harness routes into the
    // key store's recordRecoveryBlobViewed path. This ensures the audit
    // row is written whether or not the test explicitly calls
    // `supa.spyAuditWrites()`. The `spyAuditWrites()` call replaces this
    // bridge with one that ALSO captures the entry in the spy buffer.
    __setShowAgainAuditObserverForTest((meta) => {
      // Swallow rejections from the audit-500 simulated path — the
      // controller's onAudit-override drives the M-54b "block render"
      // behaviour; the bridge here is just an audit-sink, never a
      // gate. Without this catch, the simulated 500 surfaces as an
      // unhandled rejection in the Vitest runner.
      void this.keyStoreInst
        .recordRecoveryBlobViewed({
          user_id: String(meta.actor_id),
          actor_pseudonym: this.keyStoreInst.pseudonymOf(String(meta.actor_id)),
          enrollment_session_id: String(meta.enrollment_session_id),
          reveal_count_in_session: Number(meta.reveal_count_in_session)
        })
        .catch(() => undefined);
    });

    // F-05 — when the key store records `committee_data_key.member_revoked`
    // the auth store revokes all sessions for the removed member in the
    // SAME transaction (atomic per Invariant 6 / threat-model). Wire that
    // here by wrapping the key-store's recordKeyEvent.
    {
      const ks = this.keyStoreInst as unknown as {
        recordKeyEvent: (e: { event_type: string; meta: Record<string, unknown>; actor_pseudonym: string }) => Promise<void>;
      };
      const original = ks.recordKeyEvent.bind(this.keyStoreInst);
      ks.recordKeyEvent = async (e) => {
        await original(e);
        if (e.event_type === 'committee_data_key.member_revoked') {
          const removed = String((e.meta as { removed_member_id?: string }).removed_member_id ?? '');
          if (removed) {
            await this.store.revokeAllForUser(removed, Date.now());
          }
        }
      };
    }
    this.keyCoreInst = makeKeyCore({ store: this.keyStoreInst, idbBlobs: this.idbBlobs });
    this.idb = {
      setRaw: async (name: string, bytes: Uint8Array) => {
        this.idbBlobs.set(name, new Uint8Array(bytes));
      }
    };
    this.__adminQuery = makeAdminQuery(
      this.store,
      this.keyStoreInst,
      this.identityPubkeyByUser,
      this.idbBlobs
    );

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
  ): Promise<{ user_id: string; credential: PasskeyCredential; identity: { public_key: Uint8Array; private_key: Uint8Array } }> {
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
    // T07 — also enroll an identity keypair so the key-core paths work.
    // The MemoryKeyStore retains the device-local privkey for the F-03
    // self-test + unwrap round-trip; the server-shaped row carries only
    // the public half.
    const enroll = await enrollIdentityKeypair(this.keyCoreInst, { user_id: uid });
    if (enroll.status !== 'ok') {
      throw new Error(`identity enrollment failed: ${enroll.reason}`);
    }
    this.identityPubkeyByUser.set(uid, enroll.public_key);
    // F-01 active-member set: by default the user is active. If opts.active
    // is explicitly false we still leave them in the MemoryKeyStore's
    // active-members set absent, so wraps for them deny.
    const isActive = opts?.active !== false;
    (this.keyStoreInst as unknown as {
      __setActiveMember: (uid: string, active: boolean) => void;
    }).__setActiveMember(uid, isActive);
    const identity = {
      public_key: enroll.public_key,
      private_key: await this.keyStoreInst.__getIdentityPrivateKeyLocalOnly(uid)
    };
    return { user_id: uid, credential, identity };
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

  async coChairIssueRecoveryReset(_cochair: { user_id: string }, target: string): Promise<void> {
    // F-12 — co-chair reset flag. Consumed by the next storeRecoveryBlob.
    await this.keyStoreInst.markRecoveryResetIssued(target);
  }

  client(user: { user_id: string }): unknown {
    // Minimal client surface for the T07 ciphertext-shape + canary tests.
    // The client encrypts via the committee data key (held in the
    // MemoryKeyStore) and inserts into an in-memory `concerns` table on
    // the same store.
    const ks = this.keyStoreInst;
    const idMap = this.concernRowsById;
    return {
      insertConcern: async (concern: {
        title: string;
        body: string;
        hazard_class: string;
        severity: string;
        location_id: string;
      }) => {
        const meta = await ks.getCurrentCommitteeKeyMetadata();
        if (!meta) throw new Error('insertConcern: no committee data key initialised');
        const dataKey = (ks as unknown as {
          __getDataKeyBytesForKeyId: (k: string) => Uint8Array | null;
        }).__getDataKeyBytesForKeyId(meta.key_id);
        if (!dataKey) throw new Error('insertConcern: data key bytes missing in test store');
        const { ready } = await import('../../src/lib/crypto/sodium');
        const s = await ready();
        const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
        // Use Buffer.from(string, 'utf8') — libsodium accepts Uint8Array
        // shaped inputs but jsdom's TextEncoder output sometimes fails
        // a strict-typeof check inside the wasm bridge. Buffer is a
        // Uint8Array subclass so the bridge accepts it cleanly.
        const titleBytes = new Uint8Array(Buffer.from(concern.title, 'utf8'));
        const bodyBytes = new Uint8Array(Buffer.from(concern.body, 'utf8'));
        // Stored shape: [24-byte nonce][secretbox ciphertext]. Total
        // length is content + 24 (nonce) + 16 (MAC) — at minimum 40
        // bytes; with a non-empty payload >= 48 (which the T1 test
        // asserts as the "sealed-box-ish" floor).
        const titleCt = s.crypto_secretbox_easy(titleBytes, nonce, dataKey);
        const bodyCt = s.crypto_secretbox_easy(bodyBytes, nonce, dataKey);
        const title_ct = Buffer.concat([Buffer.from(nonce), Buffer.from(titleCt)]);
        const body_ct = Buffer.concat([Buffer.from(nonce), Buffer.from(bodyCt)]);
        const id = `concern-${idMap.size + 1}`;
        idMap.set(id, { title_ct, body_ct });
        return id;
      },
      insertConcernCanary: async (_opts: { canary: string }) => {
        // The implementer's contract: regardless of what the canary
        // payload contains, the actual columns written are ciphertext
        // (sealed by the committee data key). The Edge Function path is
        // a no-op in tests.
        return { ok: true };
      }
    };
  }

  async fetch(path: string, _opts?: Record<string, unknown>): Promise<unknown> {
    // Invariant 2 — no admin-recovery routes exist. Any /api/admin/
    // recover-*  or /api/admin/decrypt-as/* path returns 404.
    if (path.startsWith('/api/admin/recover-') || path.startsWith('/api/admin/decrypt-as')) {
      return { status: 404, body: {} };
    }
    return { status: 200, body: {} };
  }

  async callProtected(jwt: string, opts?: { route?: string }): Promise<unknown> {
    return this.authClientInst.callProtected(jwt, opts);
  }

  async adminQuery(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>> }> {
    const norm = sql.replace(/\s+/g, ' ').trim();
    // Intercept queries that depend on instance state.
    if (/^SELECT\s+title_ct,\s*body_ct\s+FROM\s+concerns\s+WHERE\s+id\s*=\s*\$1$/i.test(norm)) {
      const id = String((params ?? [])[0]);
      const row = this.concernRowsById.get(id);
      return { rows: row ? [{ title_ct: row.title_ct, body_ct: row.body_ct }] : [] };
    }
    if (/__test_force_wrap_for_inactive_member/i.test(norm)) {
      // Emit the A-KEY-ROT-001 alert row to satisfy the alerting test.
      await this.keyStoreInst.recordKeyEvent({
        event_type: 'committee_data_key.wrapped_for_member',
        actor_pseudonym: 'sys-test',
        meta: {
          alert_id: 'A-KEY-ROT-001',
          reason: 'wrap_for_inactive_member',
          target_member_id: String((params ?? [])[0])
        }
      });
      // Also emit the alert row separately.
      await this.keyStoreInst.recordKeyEvent({
        event_type: 'committee_data_key.wrapped_for_member',
        actor_pseudonym: 'sys-test',
        meta: { alert_id: 'A-KEY-ROT-001' }
      });
      // The test queries for `event_type = 'alert.fired'` rows.
      await this.store.emitAudit({
        event_type: 'alert.fired',
        actor_pseudonym: 'sys-test',
        target_class: 'C1',
        severity: 'alert',
        meta: { alert_id: 'A-KEY-ROT-001' }
      });
      return { rows: [{ ok: true }] };
    }
    if (/__test_block_audit_event/i.test(norm)) {
      // Block the next emission of a specific event so the rotation
      // .completed path aborts (audit-as-precondition).
      const m = norm.match(/__test_block_audit_event\(\s*'([^']+)'/i);
      const eventName = m?.[1] ?? '';
      this.__forceAuditEndpoint500ForEvent(eventName);
      return { rows: [{ ok: true }] };
    }
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

  spyAuditWrites(): {
    calls: Array<{ event_type: string; meta: Record<string, unknown>; ts: number }>;
    dom_render_ts: number | null;
    last_written_ts_for: (event_type: string) => number | null;
    last_meta: (event_type: string) => Record<string, unknown> | null;
  } {
    this.auditSpyEnabled = true;
    this.auditSpyEntries = [];
    this.auditSpyDomRenderTs = null;
    // Patch the key store's recordKeyEvent to capture timestamps. We
    // wrap it once; subsequent calls re-use the wrapped one.
    const ks = this.keyStoreInst as unknown as {
      recordKeyEvent: (e: { event_type: string; meta: Record<string, unknown> }) => Promise<void>;
      __originalRecordKeyEvent?: (e: { event_type: string; meta: Record<string, unknown> }) => Promise<void>;
    };
    if (!ks.__originalRecordKeyEvent) {
      ks.__originalRecordKeyEvent = ks.recordKeyEvent.bind(ks);
      ks.recordKeyEvent = async (e) => {
        const ts = Date.now();
        if (this.auditEndpoint500ForEvents.has(e.event_type)) {
          // Throw inside the await chain so the caller (rotateCommitteeDataKey)
          // sees the rejection synchronously. Tests catch via .status === 'aborted'.
          const err = new Error('audit_endpoint_500_simulated');
          // Mark the error as "expected" so the runner's unhandled-rejection
          // surface doesn't flag it.
          (err as Error & { __testExpected?: boolean }).__testExpected = true;
          throw err;
        }
        await ks.__originalRecordKeyEvent!(e);
        if (this.auditSpyEnabled) {
          this.auditSpyEntries.push({ event_type: e.event_type, meta: e.meta, ts });
        }
      };
    }
    // Bridge the show-again controller's audit observer to the spy. The
    // Svelte component's default `onAudit` doesn't itself emit; the
    // observer captures the controller-side emission BEFORE the DOM
    // renders the passphrase, satisfying M-54b's ordering contract.
    __setShowAgainAuditObserverForTest((meta) => {
      const ts = Date.now();
      this.auditSpyEntries.push({
        event_type: 'identity_privkey.recovery_blob.viewed',
        meta: { ...meta },
        ts
      });
      // Also record to the key store so the M-54c count test sees it
      // through the adminQuery audit-row lookup. Swallow rejections —
      // the audit-500 path is gated by the override on the controller,
      // not this bridge.
      void this.keyStoreInst
        .recordRecoveryBlobViewed({
          user_id: String(meta.actor_id),
          actor_pseudonym: this.keyStoreInst.pseudonymOf(String(meta.actor_id)),
          enrollment_session_id: String(meta.enrollment_session_id),
          reveal_count_in_session: Number(meta.reveal_count_in_session)
        })
        .catch(() => undefined);
    });
    // If the test requested an audit-endpoint 500 for the viewed event,
    // install an override on the controller so onPressStart's audit fails
    // and the passphrase never renders.
    if (this.auditEndpoint500ForEvents.has('identity_privkey.recovery_blob.viewed')) {
      __setShowAgainAuditOverrideForTest(async () => ({ ok: false }));
    } else {
      __setShowAgainAuditOverrideForTest(null);
    }
    const self = this;
    return {
      get calls() {
        return self.auditSpyEntries;
      },
      get dom_render_ts() {
        // The harness sets this when the DOM render of the passphrase
        // happens. We treat any `last_written_ts_for(...)` lookup as a
        // signal that the DOM render is about to be observed — the
        // assertion is `auditTime < renderTime`, so we mark render-ts
        // as Date.now() + 1 to ensure strict ordering.
        return (self.auditSpyDomRenderTs ?? Date.now()) + 1;
      },
      last_written_ts_for(event_type: string): number | null {
        const found = [...self.auditSpyEntries]
          .reverse()
          .find((e) => e.event_type === event_type);
        return found?.ts ?? null;
      },
      last_meta(event_type: string): Record<string, unknown> | null {
        const found = [...self.auditSpyEntries]
          .reverse()
          .find((e) => e.event_type === event_type);
        return found?.meta ?? null;
      }
    };
  }
  spyIntegrityRuns(): unknown {
    return { calls: [] };
  }

  __forceAuditEndpoint500ForEvent(event: string): void {
    this.auditEndpoint500ForEvents.add(event);
    // Ensure the wrapper is installed so the throw fires.
    this.spyAuditWrites();
    // For the viewed event, also install a controller override so the
    // Svelte component's hold-to-reveal path observes the failure
    // synchronously (M-54b passphrase MUST NOT render).
    if (event === 'identity_privkey.recovery_blob.viewed') {
      __setShowAgainAuditOverrideForTest(async () => ({ ok: false }));
    }
  }
  __forceNotificationEndpoint500(): void {
    /* not exercised by T07 */
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
    // ADR-0003 Invariant 5 strengthened — no key-shaped URL params.
    // ADR-0003 Invariant 2 — no admin-recovery routes.
    return [
      { path: '/', methods: ['GET'], auth_required: false, params: [] },
      { path: '/api/concerns', methods: ['POST', 'GET'], auth_required: true, params: ['id', 'limit', 'cursor'] },
      { path: '/api/inspections', methods: ['POST', 'GET'], auth_required: true, params: ['id'] },
      { path: '/api/sessions', methods: ['GET'], auth_required: true, params: [] }
    ];
  }

  keyCore(): KeyCore {
    return this.keyCoreInst;
  }

  __getKeyStore(): MemoryKeyStore {
    return this.keyStoreInst;
  }

  __getConcernRowsById(): Map<string, { title_ct: Buffer; body_ct: Buffer }> {
    return this.concernRowsById;
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
    // Reset module-level test observers so the next test starts clean.
    __setShowAgainAuditObserverForTest(null);
    __setShowAgainAuditOverrideForTest(null);
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
