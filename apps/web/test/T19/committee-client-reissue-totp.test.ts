/**
 * T19.1 / ADR-0029 P1-6 — `SupabaseCommitteeClient.reissueTotp` client surface
 * (the "re-send code" co-chair action over the committee-op Edge Function).
 *
 * Sibling to committee-client-factory.test.ts (the P1-3 `issueInvite` suite).
 * That file remains UNTOUCHED; this one pins the NEW `reissueTotp` method the
 * P1-6 implementer adds to `SupabaseCommitteeClient` (the production peer of the
 * committee-op `reissue_totp` op, sibling of `issueInvite`).
 *
 * Re-send reissues a FRESH 15-min TOTP against an EXISTING, still-unconsumed
 * invite. Like `issueInvite`, the raw 6-digit code rides the request body to
 * committee-op and is returned to the caller IN-MEMORY only; the client MUST
 * NOT log it, persist it, or echo it through any wrapped-error path (F-176 /
 * Decision 8). The link still carries only `invite_id`, never the code.
 *
 * RED-FIRST: `SupabaseCommitteeClient.reissueTotp` does NOT exist on `main`
 * (the class today exposes only `issueInvite`,
 * apps/web/src/lib/committee/supabase-committee-client.ts:118-129). The calls
 * below fail to type/resolve until P1-6 lands — the intended red. The factory
 * (`createSupabaseCommitteeClient`) and the shared transport already exist
 * (P1-3), so the failure is specifically the missing client METHOD.
 *
 * Most transport semantics (URL composition, JWT resolution, 401 ->
 * onSessionRevoked, network -> status 0, non-JSON -> body null) are covered by
 * edge-fn-fetch-transport.test.ts + committee-client-factory.test.ts. These
 * tests pin the reissue-specific wiring: the op name + body shape, the JWT
 * header, the unwrap-to-data ergonomics, the F-39 onSessionRevoked matrix, and
 * the F-176 client-side leak floor.
 *
 * Hermetic: inject a stub `fetchImpl` that records the request shape + returns
 * canned responses. No real network. No real RNG. No real clock.
 *
 * Findings covered (threat-model §3.18):
 *   F-39  (carry-forward) — 401 -> onSessionRevoked fires only on the server's
 *                          session-revoked signal; never on 200 / 403 / network.
 *   F-175 — the re-send surface is co-chair-gated SERVER-side; HERE we pin the
 *           client posts WITH the JWT header (so the gate runs against the real
 *           auth.uid()) and presents NO bearer when unauthenticated.
 *   F-176 — the raw 6-digit re-send code NEVER appears in any project-emitted
 *           structured log line / sessionStorage / localStorage / URL across a
 *           reissueTotp call (happy + failure branches).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
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
      json: async () => r.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const INVITE_ID = '00000000-0000-0000-0000-000000000a11';

// The canonical re-send success payload. ADR-0029 P1-6 does NOT pin the RETURNS
// column names (CONTRACT-AMBIGUITY-3, flagged in the report); the working shape
// is {invite_id, bootstrap_id} (the new bootstrap). The transport/unwrap and
// leak assertions are independent of the payload shape; reconcile a different
// shape HERE rather than relaxing them.
const SQL_OK_DATA = {
  invite_id: INVITE_ID,
  bootstrap_id: '00000000-0000-0000-0000-000000000c33',
};

// The 6-digit code the test passes through the client and sweeps for in logs.
const CANARY_CODE = '424242';

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
// METHOD SHAPE — reissueTotp is on the same client instance as issueInvite.
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-6 — SupabaseCommitteeClient.reissueTotp (method shape)', () => {
  it('the factory-built client exposes a reissueTotp method', () => {
    const { fetchImpl } = stubFetch([]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => null,
      fetchImpl,
    });
    expect(client).toBeInstanceOf(SupabaseCommitteeClient);
    expect(typeof (client as unknown as { reissueTotp?: unknown }).reissueTotp).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// HAPPY PATH — reissueTotp posts the right body to committee-op + unwraps data.
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-6 — reissueTotp (transport wiring)', () => {
  it('POSTs to ${baseUrl}/functions/v1/committee-op with the reissue_totp op + JWT header', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, data: SQL_OK_DATA } },
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt-token-xyz',
      fetchImpl,
    });

    const r = await client.reissueTotp({ invite_id: INVITE_ID, code: CANARY_CODE });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual(SQL_OK_DATA);

    expect(calls).toHaveLength(1);
    // Re-send rides the EXISTING committee-op EF (ADR-0029 Decision 3 / line
    // 9812: "committee-op extension (new issue_invite + reissue_totp ops)").
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/committee-op');
    expect(calls[0]?.init.method).toBe('POST');

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    // F-175: the JWT header MUST be present so the server-side co-chair gate
    // runs against the real auth.uid().
    expect(headers['Authorization']).toBe('Bearer jwt-token-xyz');

    // Body shape — `op: 'reissue_totp'` plus the two args. Field names pinned:
    // invite_id / code (the client surface) become the EF body, which the core
    // fn renames to p_invite_id / p_totp_code.
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body).toEqual({
      op: 'reissue_totp',
      invite_id: INVITE_ID,
      code: CANARY_CODE,
    });
  });

  it('does NOT post any ttl_minutes / roles (re-send re-arms the TOTP only, not the invite)', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, data: SQL_OK_DATA } },
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt',
      fetchImpl,
    });
    await client.reissueTotp({ invite_id: INVITE_ID, code: CANARY_CODE });
    const body = JSON.parse(calls[0]?.init.body as string);
    // Re-send must NOT re-set the 7-day invite TTL or the role array — those are
    // server-bound at issue and untouched by re-send (P1-6). A client that
    // threaded ttl_minutes would invite a "re-send extends the invite" bug.
    expect(body).not.toHaveProperty('ttl_minutes');
    expect(body).not.toHaveProperty('roles');
  });

  it('omits Authorization header when getJwt() returns null (unauthenticated -> server rejects)', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 401, body: { ok: false, error: 'rls_denied' } },
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => null,
      fetchImpl,
    });
    await client.reissueTotp({ invite_id: INVITE_ID, code: CANARY_CODE });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ERROR MAPPING — the existing CommitteeReason set (P1-6 does not extend it).
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-6 — reissueTotp (error mapping)', () => {
  it('maps the EF 403 rls_denied (non-co-chair) into ok:false / reason:rls_denied / status:403', async () => {
    const { fetchImpl } = stubFetch([
      { status: 403, body: { ok: false, error: 'rls_denied' } },
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'worker-member-jwt',
      fetchImpl,
    });
    const r = await client.reissueTotp({ invite_id: INVITE_ID, code: CANARY_CODE });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rls_denied');
    expect(r.status).toBe(403);
  });

  it('maps the EF 422 invite_invalid (consumed/expired invite) into ok:false / reason:invite_invalid / status:422', async () => {
    // AMBIGUITY-1 (closed oracle): a consumed/expired/non-existent invite all
    // surface as the SAME literal `invite_invalid` (mirrors the keystone).
    const { fetchImpl } = stubFetch([
      { status: 422, body: { ok: false, error: 'invite_invalid' } },
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'co-chair-jwt',
      fetchImpl,
    });
    const r = await client.reissueTotp({ invite_id: INVITE_ID, code: CANARY_CODE });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invite_invalid');
    expect(r.status).toBe(422);
  });

  it('surfaces a network error as ok:false / reason:unknown / status:0 (parity with other factories)', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt',
      fetchImpl,
    });
    const r = await client.reissueTotp({ invite_id: INVITE_ID, code: CANARY_CODE });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(0);
    expect(r.reason).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// onSessionRevoked — F-39 / session-jwt-store contract (parity with issueInvite).
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-6 — reissueTotp onSessionRevoked (401 -> clearJwt loop)', () => {
  it('fires onSessionRevoked when committee-op returns 401 (F-39 loop parity)', async () => {
    const { fetchImpl } = stubFetch([
      { status: 401, body: { ok: false, error: 'rls_denied' } },
    ]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'stale-jwt',
      fetchImpl,
      onSessionRevoked,
    });
    await client.reissueTotp({ invite_id: INVITE_ID, code: CANARY_CODE });
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onSessionRevoked on 403 (live session, co-chair gate denied this op)', async () => {
    const { fetchImpl } = stubFetch([
      { status: 403, body: { ok: false, error: 'rls_denied' } },
    ]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked,
    });
    await client.reissueTotp({ invite_id: INVITE_ID, code: CANARY_CODE });
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('does NOT fire onSessionRevoked on 200 success', async () => {
    const { fetchImpl } = stubFetch([
      { status: 200, body: { ok: true, data: SQL_OK_DATA } },
    ]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked,
    });
    await client.reissueTotp({ invite_id: INVITE_ID, code: CANARY_CODE });
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('does NOT fire onSessionRevoked on a network error (status 0)', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const onSessionRevoked = vi.fn();
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked,
    });
    await client.reissueTotp({ invite_id: INVITE_ID, code: CANARY_CODE });
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F-176 — the 6-digit code MUST NEVER appear in a project log line / storage /
// URL across a happy or failure-branch reissueTotp call.
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-6 — reissueTotp F-176 client-side leak sweep', () => {
  it('the raw code NEVER lands in the project structured-log capture on a happy reissueTotp', async () => {
    const { fetchImpl } = stubFetch([
      { status: 200, body: { ok: true, data: SQL_OK_DATA } },
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'co-chair-jwt',
      fetchImpl,
    });
    await client.reissueTotp({ invite_id: INVITE_ID, code: CANARY_CODE });
    const blob = __getCapturedLines().map((l) => JSON.stringify(l)).join('|');
    expect(blob).not.toContain(CANARY_CODE);
  });

  it('the raw code NEVER lands in the project structured-log capture on a denial branch (rls_denied)', async () => {
    const { fetchImpl } = stubFetch([
      { status: 403, body: { ok: false, error: 'rls_denied' } },
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'worker-member-jwt',
      fetchImpl,
    });
    await client.reissueTotp({ invite_id: INVITE_ID, code: CANARY_CODE });
    const blob = __getCapturedLines().map((l) => JSON.stringify(l)).join('|');
    expect(blob).not.toContain(CANARY_CODE);
  });

  it('the raw code NEVER lands in the project structured-log capture on a network error', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'co-chair-jwt',
      fetchImpl,
    });
    await client.reissueTotp({ invite_id: INVITE_ID, code: CANARY_CODE });
    const blob = __getCapturedLines().map((l) => JSON.stringify(l)).join('|');
    expect(blob).not.toContain(CANARY_CODE);
  });

  it('the raw code NEVER lands in sessionStorage / localStorage / URL across a reissueTotp call', async () => {
    const { fetchImpl } = stubFetch([
      { status: 200, body: { ok: true, data: SQL_OK_DATA } },
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'co-chair-jwt',
      fetchImpl,
    });
    await client.reissueTotp({ invite_id: INVITE_ID, code: CANARY_CODE });

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
