/**
 * T19.1 / ADR-0029 P1-3 — production wiring helper for the new
 * `SupabaseCommitteeClient` (committee-op Edge Function, the `issue_invite`
 * op the EF gains in P1-3).
 *
 * RED-FIRST: neither `createSupabaseCommitteeClient` nor a
 * `SupabaseCommitteeClient` exists on `main`. The imports below resolve
 * only after P1-3 lands; the failing reason at run time is
 * "cannot find module 'committee-client-factory'" (the missing peer of
 * t07/concern/reprisal/t14 client-factory.ts).
 *
 * Most of the transport semantics (URL composition, JWT resolution, 401 →
 * onSessionRevoked matrix, network → status 0, non-JSON → body null) are
 * already covered by `edge-fn-fetch-transport.test.ts` since this factory
 * delegates to the shared helper. These tests pin the committee-op-specific
 * wiring: the URL targets `/functions/v1/committee-op` (NOT a new EF name —
 * ADR-0029 Decision 3 slots the new op into the existing EF), the
 * SupabaseCommitteeClient is constructed correctly over the transport, the
 * `issueInvite({roles, code, ttl_minutes})` method posts the right body
 * + unwraps `data`, the F-39 onSessionRevoked option threads through, and
 * F-176 holds client-side (the 6-digit code never reaches a project log).
 *
 * Style mirrors t07-client-factory.test.ts / concern-client-factory.test.ts
 * / reprisal-client-factory.test.ts verbatim (stubFetch, ResponseInit
 * recording, vi.fn() for onSessionRevoked).
 *
 * Hermetic: tests inject a stub `fetchImpl` that records the request shape
 * + returns canned responses. No real network. No real RNG.
 *
 * Findings covered (threat-model §3.18):
 *   F-39  (carry-forward) — 401 → onSessionRevoked is fired exactly when the
 *                          server's session_is_live gate denies; never on
 *                          200 / 403 / network / 500 (parity with the other
 *                          *-client-factory tests).
 *   F-175 — the issuance surface is on committee-op (co-chair-gated server-
 *           side); HERE we pin the client posts with the JWT header, so a
 *           code-less / unauthenticated call is server-rejected (not
 *           silently swallowed) — closing the "client forgot to attach the
 *           bearer and the server's gate carried us anyway" gap.
 *   F-176 — the raw 6-digit code MUST NEVER appear in any project-emitted
 *           structured log line during issueInvite (captured via the shared
 *           lib/log test-sink). The client returns the code to the caller
 *           in-memory ONLY; the link / clipboard handling is the UI's
 *           concern (P1-8), not this client's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
// RED-FIRST imports — the implementer creates both modules in P1-3 / P1-5.
// (The factory is the P1-3 transport surface; SupabaseCommitteeClient is its
// instance type, the production peer of MemoryCommitteeStore. The factory
// fixes opName: 'committee-op' just like t07/concern/reprisal/t14.)
import { createSupabaseCommitteeClient } from '../../src/lib/server-client/committee-client-factory';
import { SupabaseCommitteeClient } from '../../src/lib/committee/supabase-committee-client';

interface StubResponse {
  status: number;
  body: unknown;
}

function stubFetch(responses: StubResponse[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: typeof url === 'string' ? url : url.toString(), init: init ?? {} });
    const r = responses[i++];
    if (!r) throw new Error('no response queued');
    return {
      status: r.status,
      json: async () => r.body
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// Canonical successful keystone response (mirrors the SQL keystone's TABLE
// return + the wire shape committee-op emits: { ok:true, data: {...} }).
const SQL_OK_DATA = {
  invite_id: '00000000-0000-0000-0000-000000000a11',
  invitee_user_id: '00000000-0000-0000-0000-000000000b22',
  bootstrap_id: '00000000-0000-0000-0000-000000000c33'
};

// The 6-digit code the test passes through the client and sweeps for in logs.
const CANARY_CODE = '424242';

// Lifecycle: clean test-sink + storage between tests (parity with the
// existing leak-sweep tests, e.g. T13b/phase2b-key-material-leak-sweep.test.ts).
beforeEach(() => {
  __resetCapture();
  __setTestSink();
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

afterEach(() => {
  __resetCapture();
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// FACTORY SHAPE — peer of the other *-client-factory.ts files.
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-3 — createSupabaseCommitteeClient (factory shape)', () => {
  it('returns a SupabaseCommitteeClient instance', () => {
    const { fetchImpl } = stubFetch([]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => null,
      fetchImpl
    });
    expect(client).toBeInstanceOf(SupabaseCommitteeClient);
  });
});

// ---------------------------------------------------------------------------
// HAPPY PATH — issueInvite posts the right body to committee-op + unwraps data.
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-3 — createSupabaseCommitteeClient.issueInvite (transport wiring)', () => {
  it('POSTs to ${baseUrl}/functions/v1/committee-op with the issue_invite op + JWT header', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, data: SQL_OK_DATA } }
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt-token-xyz',
      fetchImpl
    });

    const r = await client.issueInvite({
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });

    expect(r.ok).toBe(true);
    // Unwrap to `data` (mirrors the rest of the project's *OpResult ergonomics).
    if (!r.ok) return;
    expect(r.data).toEqual(SQL_OK_DATA);

    expect(calls).toHaveLength(1);
    // F-168 (carry-forward): the new op rides the EXISTING committee-op EF —
    // ADR-0029 Decision 3 explicitly does NOT add a new EF name.
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/committee-op');
    expect(calls[0]?.init.method).toBe('POST');

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    // F-175: the JWT header MUST be present so the server-side
    // _committee_is_active_co_chair gate runs against the real auth.uid().
    expect(headers['Authorization']).toBe('Bearer jwt-token-xyz');

    // Body shape — `op: 'issue_invite'` plus the three keystone args. Field
    // names are pinned: roles / code / ttl_minutes (the client surface)
    // become the EF's roles / code / ttl_minutes (passed through to the
    // core fn, which then renames to p_roles / p_totp_code / p_ttl_minutes).
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body).toEqual({
      op: 'issue_invite',
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });
  });

  it('strips trailing slashes from baseUrl (canonical endpoint, parity with other factories)', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, data: SQL_OK_DATA } }
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co////',
      getJwt: () => 'jwt-x',
      fetchImpl
    });
    await client.issueInvite({
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/committee-op');
  });

  it('forwards a multi-role array verbatim — the EF/SQL normalize, the client does not pre-sort', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, data: SQL_OK_DATA } }
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt',
      fetchImpl
    });
    await client.issueInvite({
      roles: ['worker_member', 'worker_co_chair'],
      code: '535353',
      ttl_minutes: 10080
    });
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.roles).toEqual(['worker_member', 'worker_co_chair']);
  });

  it('omits Authorization header when getJwt() returns null (unauthenticated → server rejects)', async () => {
    // F-175 negative: an unauthenticated client call MUST present no bearer
    // (so the EF's "bearer required" gate at committee-op/index.ts:78-80
    // can return rls_denied 401). The client must not invent / cache one.
    const { fetchImpl, calls } = stubFetch([
      { status: 401, body: { ok: false, error: 'rls_denied' } }
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => null,
      fetchImpl
    });
    await client.issueInvite({
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ERROR MAPPING — the existing CommitteeReason set (P1-3 does not extend it).
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-3 — createSupabaseCommitteeClient.issueInvite (error mapping)', () => {
  it('maps the EF 403 rls_denied (non-co-chair) into ok:false / reason:rls_denied / status:403', async () => {
    const { fetchImpl } = stubFetch([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'worker-member-jwt',
      fetchImpl
    });
    const r = await client.issueInvite({
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rls_denied');
    expect(r.status).toBe(403);
  });

  it('maps the EF 422 invalid_role (out-of-enum array) into ok:false / reason:invalid_role / status:422', async () => {
    const { fetchImpl } = stubFetch([
      { status: 422, body: { ok: false, error: 'invalid_role' } }
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'co-chair-jwt',
      fetchImpl
    });
    const r = await client.issueInvite({
      roles: ['superuser'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid_role');
    expect(r.status).toBe(422);
  });

  it('surfaces a network error as ok:false / reason:unknown / status:0 (offline / DNS, parity with other factories)', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt',
      fetchImpl
    });
    const r = await client.issueInvite({
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(0);
    expect(r.reason).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// onSessionRevoked — F-39 / session-jwt-store contract closure (parity with
// t07 / concern / reprisal client-factory tests).
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-3 — createSupabaseCommitteeClient onSessionRevoked (401 → clearJwt loop)', () => {
  it('fires onSessionRevoked when committee-op returns 401 (F-39 loop parity)', async () => {
    const { fetchImpl } = stubFetch([
      { status: 401, body: { ok: false, error: 'rls_denied' } }
    ]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'stale-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.issueInvite({
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onSessionRevoked on 403 (live session, co-chair gate denied this op)', async () => {
    const { fetchImpl } = stubFetch([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.issueInvite({
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('does NOT fire onSessionRevoked on 200 success', async () => {
    const { fetchImpl } = stubFetch([
      { status: 200, body: { ok: true, data: SQL_OK_DATA } }
    ]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.issueInvite({
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('does NOT fire onSessionRevoked on a network error (status 0 — not a server revocation signal)', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const onSessionRevoked = vi.fn();
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.issueInvite({
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('back-compat: works when onSessionRevoked is undefined (401 still surfaces to the caller)', async () => {
    const { fetchImpl } = stubFetch([
      { status: 401, body: { ok: false, error: 'rls_denied' } }
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'stale-jwt',
      fetchImpl
    });
    const r = await client.issueInvite({
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// F-176 — the 6-digit code MUST NEVER appear in any project-emitted
// structured log line during a happy or failure-branch issueInvite call.
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-3 — createSupabaseCommitteeClient F-176 client-side leak sweep', () => {
  it('the raw code NEVER lands in the project structured-log capture surface on a happy issueInvite', async () => {
    const { fetchImpl } = stubFetch([
      { status: 200, body: { ok: true, data: SQL_OK_DATA } }
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'co-chair-jwt',
      fetchImpl
    });
    await client.issueInvite({
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });

    const blob = __getCapturedLines()
      .map((l) => JSON.stringify(l))
      .join('|');
    // The canonical Decision-8 invariant: the code is response-body-only.
    // A factory/client that "logs the body for debugging" would round-trip
    // the code into the project log — F-176 NO-GO.
    expect(blob).not.toContain(CANARY_CODE);
  });

  it('the raw code NEVER lands in the project structured-log capture surface on a denial branch (rls_denied)', async () => {
    const { fetchImpl } = stubFetch([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'worker-member-jwt',
      fetchImpl
    });
    await client.issueInvite({
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });

    const blob = __getCapturedLines()
      .map((l) => JSON.stringify(l))
      .join('|');
    expect(blob).not.toContain(CANARY_CODE);
  });

  it('the raw code NEVER lands in the project structured-log capture surface on a network error', async () => {
    // Sweep the failure surface too — an implementer that wraps the fetch
    // throw in a logged error including the request body would leak the code.
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'co-chair-jwt',
      fetchImpl
    });
    await client.issueInvite({
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });

    const blob = __getCapturedLines()
      .map((l) => JSON.stringify(l))
      .join('|');
    expect(blob).not.toContain(CANARY_CODE);
  });

  it('the raw code NEVER lands in sessionStorage / localStorage / URL across an issueInvite call', async () => {
    // Decision 8: the link carries only `invite_id` (response data), never
    // the code. The client must hand the code back IN MEMORY only — never
    // persist it. (UI persistence is P1-8's concern; this is the transport
    // floor.)
    const { fetchImpl } = stubFetch([
      { status: 200, body: { ok: true, data: SQL_OK_DATA } }
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'co-chair-jwt',
      fetchImpl
    });
    await client.issueInvite({
      roles: ['worker_member'],
      code: CANARY_CODE,
      ttl_minutes: 10080
    });

    if (typeof sessionStorage !== 'undefined') {
      let blob = '';
      for (let j = 0; j < sessionStorage.length; j++) {
        const k = sessionStorage.key(j);
        if (k === null) continue;
        blob += k + '=' + (sessionStorage.getItem(k) ?? '') + ';';
      }
      expect(blob).not.toContain(CANARY_CODE);
    }
    if (typeof localStorage !== 'undefined') {
      let blob = '';
      for (let j = 0; j < localStorage.length; j++) {
        const k = localStorage.key(j);
        if (k === null) continue;
        blob += k + '=' + (localStorage.getItem(k) ?? '') + ';';
      }
      expect(blob).not.toContain(CANARY_CODE);
    }
    if (typeof window !== 'undefined' && window.location) {
      expect(window.location.href).not.toContain(CANARY_CODE);
      expect(window.location.hash).not.toContain(CANARY_CODE);
      expect(window.location.search).not.toContain(CANARY_CODE);
    }
  });
});
