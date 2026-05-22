/**
 * Test harness shape — the implementer wires this to a real Supabase local
 * stack (supabase start) + the project schema migrations.
 *
 * Until the implementer wires it up, importing TestSupabase methods will
 * throw — the tests will FAIL with a useful message naming the missing
 * piece.
 *
 * Source obligations:
 *   - ADR-0001 — Canadian region pin; verified per test via project metadata.
 *   - ADR-0004 — RLS on every table.
 *   - ADR-0006 — SvelteKit + Vitest.
 *   - The test plan in `.context/test-plan.md` §3 (infrastructure proposals)
 *     names the supabase local boot strategy.
 */

const NOT_IMPLEMENTED = (name: string) => {
  throw new Error(
    `[test-harness] ${name} is not implemented. ` +
      `The implementer must wire this in apps/web/test/_helpers/supabase-test.ts ` +
      `against a Supabase local stack (see .context/test-plan.md §3).`
  );
};

export interface TestSupabase {
  authClient(): any;
  enrollUser(uid: string, opts?: { role?: string; active?: boolean }): Promise<any>;
  makeAuthSession(uid: string): Promise<any>;
  loginAs(user: any): Promise<any>;
  coChairIssueInvite(opts: any): Promise<any>;
  coChairUpdateMembership(uid: string, opts: any): Promise<any>;
  coChairIssueRecoveryReset(cochair: any, target: string): Promise<any>;
  client(user: any): any;
  fetch(path: string, opts?: any): Promise<any>;
  callProtected(jwt: string, opts?: any): Promise<any>;
  adminQuery(sql: string, params?: any[]): Promise<{ rows: any[] }>;
  pseudonymOf(uid: string): string;
  idb: any;
  startLogCapture(): void;
  stopLogCapture(): any[];
  startSentryCapture(): void;
  stopSentryCapture(): any[];
  startEdgeFunctionLogCapture(): void;
  stopEdgeFunctionLogCapture(): any[];
  spyAuditWrites(): any;
  spyIntegrityRuns(): any;
  __forceAuditEndpoint500ForEvent(event: string): void;
  __forceNotificationEndpoint500(): void;
  __emitAuditRowForTest(event: string, meta: any): Promise<any>;
  __seedAuditRowAtAge(event: string, ageLabel: string): Promise<{ id: number }>;
  getRouteInventory(): Array<{
    path: string;
    methods: string[];
    auth_required: boolean;
    params?: string[];
    responses?: Array<{ content_type: string }>;
  }>;
  keyCore(): any;
  retentionService: { runOnce: (opts?: any) => Promise<any>; runDryRun: () => Promise<any>; runDriftCheck: () => Promise<any> };
  integrityService: {
    runScheduled: () => Promise<any>;
    runWithBackupDiff: () => Promise<any>;
  };
  backupService: { takeSnapshot: () => Promise<any> };
  expiryService: { runOnce: () => Promise<any> };
  startInspectionSession(user: any, opts?: any): Promise<any>;
  captureSnapshotsDuring(fn: () => Promise<any>, sql: string): Promise<any[]>;
  simulateNextPageLoad(): Promise<{ routeName: string }>;
  tearDown(): Promise<void>;
}

export async function createTestSupabase(): Promise<TestSupabase> {
  NOT_IMPLEMENTED('createTestSupabase');
  throw new Error('unreachable');
}
