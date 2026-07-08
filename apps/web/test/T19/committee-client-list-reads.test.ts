/**
 * T19.1 / ADR-0029 P1-8a (Amendment A-8.3) — the TWO co-chair READ methods on
 * `SupabaseCommitteeClient`:
 *   - `listRoster()`         → committee-op `list_roster`         (B1, A-8.1)
 *   - `listPendingInvites()` → committee-op `list_pending_invites` (B2, A-8.2)
 *
 * Sibling to committee-client-factory.test.ts (issueInvite) and
 * committee-client-reissue-totp.test.ts (reissueTotp) — both UNTOUCHED. Both
 * underlying RPCs are SETOF, so each method unwraps to an ARRAY on `data`.
 *
 * RED-FIRST: neither `listRoster` nor `listPendingInvites` exists on `main`
 * (the class today exposes only issueInvite / reissueTotp,
 * apps/web/src/lib/committee/supabase-committee-client.ts:112-166). The calls
 * below fail to type/resolve until P1-8a lands — the intended red. The factory
 * (`createSupabaseCommitteeClient`) + shared transport already exist (P1-3), so
 * the failure is specifically the two missing client METHODS.
 *
 * Scope note (P1-8a is READS ONLY): the setRoles / removeMember /
 * reactivateMember client methods are P1-8e — NOT exercised here.
 *
 * Most transport semantics (URL composition, JWT resolution, 401 →
 * onSessionRevoked, network → status 0) are covered by
 * edge-fn-fetch-transport.test.ts + committee-client-factory.test.ts. These
 * tests pin the read-specific wiring: the op name + parameterless body, the JWT
 * header, the unwrap-to-array ergonomics, the pinned column sets, the F-39
 * onSessionRevoked matrix, and the F-178/F-176 client-side PI leak floor.
 *
 * Hermetic: inject a stub `fetchImpl` that records the request shape + returns
 * canned responses. No real network, RNG, or clock.
 *
 * Findings covered (threat-model §3.18):
 *   F-39  (carry-forward) — 401 → onSessionRevoked fires only on the server's
 *                          session-revoked signal; never on 200 / 403 / network.
 *   F-178 — the roster/pending reads are co-chair-gated SERVER-side; HERE we pin
 *           the client posts WITH the JWT header (so the gate runs against the
 *           real auth.uid()), the returned rows match the pinned column sets
 *           (B2 carries NO bootstrap_id), and NO member PI (display_name /
 *           off_employer_contact / raw uid) reaches a project log / storage / URL.
 *   F-176 — the client-side PI leak floor (parity with the code-leak sweeps on
 *           issueInvite / reissueTotp).
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
      json: async () => r.body
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// PI canaries — the roster projects users.display_name / off_employer_contact
// (PI) + the RAW user_id (A-8.1). None may reach a log / storage / URL. Values
// are synthetic (no real PI in fixtures).
const CANARY_DISPLAY_NAME = 'Nadia Privacy';
const CANARY_EMPLOYER_CONTACT = 'nadia@home.example';
const CANARY_UID = '00000000-0000-0000-0000-000000000a01';

// The pinned column sets (A-8.1 / A-8.2). The client's returned rows must match
// EXACTLY — no bootstrap_id / secret adjacency on the pending-invite rows.
const ROSTER_KEYS = [
  'user_id',
  'roles',
  'active',
  'invited_at',
  'activated_at',
  'deactivated_at',
  'grace_until',
  'display_name',
  'off_employer_contact',
  'has_identity_key',
  'has_live_wrap'
];
const PENDING_KEYS = [
  'invite_id',
  'target_user_id',
  'display_name',
  'roles',
  'issued_at',
  'expires_at'
];

const ROSTER_ROWS = [
  {
    user_id: CANARY_UID,
    roles: ['worker_member'],
    active: true,
    invited_at: '2026-01-01T00:00:00.000Z',
    activated_at: '2026-01-02T00:00:00.000Z',
    deactivated_at: null,
    grace_until: null,
    display_name: CANARY_DISPLAY_NAME,
    off_employer_contact: CANARY_EMPLOYER_CONTACT,
    has_identity_key: true,
    has_live_wrap: false
  }
];

const PENDING_ROWS = [
  {
    invite_id: '00000000-0000-0000-0000-00000000a001',
    target_user_id: CANARY_UID,
    display_name: CANARY_DISPLAY_NAME,
    roles: ['worker_member'],
    issued_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-01-08T00:00:00.000Z'
  }
];

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
// METHOD SHAPE — both reads are on the same client instance as issueInvite.
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-8a — SupabaseCommitteeClient read methods (method shape)', () => {
  it('the factory-built client exposes listRoster + listPendingInvites methods', () => {
    const { fetchImpl } = stubFetch([]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => null,
      fetchImpl
    });
    expect(client).toBeInstanceOf(SupabaseCommitteeClient);
    expect(typeof (client as unknown as { listRoster?: unknown }).listRoster).toBe('function');
    expect(typeof (client as unknown as { listPendingInvites?: unknown }).listPendingInvites).toBe(
      'function'
    );
  });
});

// ---------------------------------------------------------------------------
// HAPPY PATH — the reads POST a parameterless op to committee-op + unwrap array.
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-8a — listRoster (transport wiring)', () => {
  it('POSTs {op:"list_roster"} to ${baseUrl}/functions/v1/committee-op with the JWT header + unwraps the array', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { ok: true, data: ROSTER_ROWS } }]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt-token-xyz',
      fetchImpl
    });

    const r = await client.listRoster();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // SETOF → array, passed through unchanged.
    expect(r.data).toEqual(ROSTER_ROWS);

    expect(calls).toHaveLength(1);
    // The read rides the EXISTING committee-op EF (A-8.3 — no new EF name).
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/committee-op');
    expect(calls[0]?.init.method).toBe('POST');

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    // F-178: the JWT header MUST be present so the server co-chair gate runs
    // against the real auth.uid() (a missing bearer → the route's 403 role-gate).
    expect(headers['Authorization']).toBe('Bearer jwt-token-xyz');

    // Parameterless body — ONLY the op. No target uid / filter is threaded (the
    // co-chair identity is the JWT; the roster is whole-committee).
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body).toEqual({ op: 'list_roster' });
  });

  it('strips trailing slashes from baseUrl (canonical endpoint, parity with other methods)', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { ok: true, data: ROSTER_ROWS } }]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co////',
      getJwt: () => 'jwt-x',
      fetchImpl
    });
    await client.listRoster();
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/committee-op');
  });

  it('omits Authorization header when getJwt() returns null (unauthenticated → server rejects)', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => null,
      fetchImpl
    });
    await client.listRoster();
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });
});

describe('ADR-0029 P1-8a — listPendingInvites (transport wiring)', () => {
  it('POSTs {op:"list_pending_invites"} to committee-op with the JWT header + unwraps the array', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, data: PENDING_ROWS } }
    ]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt-token-xyz',
      fetchImpl
    });

    const r = await client.listPendingInvites();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual(PENDING_ROWS);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/committee-op');
    expect(calls[0]?.init.method).toBe('POST');

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer jwt-token-xyz');

    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body).toEqual({ op: 'list_pending_invites' });
  });
});

// ---------------------------------------------------------------------------
// TYPE / COLUMN-SET SHAPE — the returned rows match the pinned column sets.
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-8a — returned rows match the pinned column sets', () => {
  it('a roster row has EXACTLY the 11 pinned columns (A-8.1)', async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: { ok: true, data: ROSTER_ROWS } }]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'co-chair-jwt',
      fetchImpl
    });
    const r = await client.listRoster();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.data[0]).sort()).toEqual([...ROSTER_KEYS].sort());
  });

  it('🔒 a pending-invite row has EXACTLY the 6 pinned columns and NO bootstrap_id / secret_hash (A-8.2)', async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: { ok: true, data: PENDING_ROWS } }]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'co-chair-jwt',
      fetchImpl
    });
    const r = await client.listPendingInvites();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.data[0]).sort()).toEqual([...PENDING_KEYS].sort());
    expect(r.data[0]).not.toHaveProperty('bootstrap_id');
    expect(r.data[0]).not.toHaveProperty('secret_hash');
  });
});

// ---------------------------------------------------------------------------
// ERROR MAPPING — the existing CommitteeReason set (P1-8a adds none).
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-8a — read error mapping', () => {
  it('maps the EF 403 rls_denied (non-co-chair roster read) into ok:false / rls_denied / 403', async () => {
    const { fetchImpl } = stubFetch([{ status: 403, body: { ok: false, error: 'rls_denied' } }]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'worker-member-jwt',
      fetchImpl
    });
    const r = await client.listRoster();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rls_denied');
    expect(r.status).toBe(403);
  });

  it('surfaces a network error as ok:false / reason:unknown / status:0 (parity)', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt',
      fetchImpl
    });
    const r = await client.listPendingInvites();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(0);
    expect(r.reason).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// onSessionRevoked — F-39 / session-jwt-store contract (parity with issueInvite).
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-8a — read onSessionRevoked (401 → clearJwt loop)', () => {
  it('fires onSessionRevoked when committee-op returns 401 on listRoster (F-39 loop parity)', async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'stale-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.listRoster();
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onSessionRevoked on 403 (live session, co-chair gate denied the read)', async () => {
    const { fetchImpl } = stubFetch([{ status: 403, body: { ok: false, error: 'rls_denied' } }]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.listRoster();
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('does NOT fire onSessionRevoked on 200 success', async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: { ok: true, data: ROSTER_ROWS } }]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.listRoster();
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('does NOT fire onSessionRevoked on a network error (status 0) for listPendingInvites', async () => {
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
    await client.listPendingInvites();
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('back-compat: works when onSessionRevoked is undefined (401 still surfaces to the caller)', async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'stale-jwt',
      fetchImpl
    });
    const r = await client.listRoster();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// F-178 / F-176 — member PI (display_name / off_employer_contact / raw uid)
// MUST NEVER appear in any project-emitted log line, storage, or URL.
// ---------------------------------------------------------------------------

describe('ADR-0029 P1-8a — F-178/F-176 client-side PI leak sweep', () => {
  it('roster PI + raw uid NEVER land in the project structured-log capture on a happy listRoster', async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: { ok: true, data: ROSTER_ROWS } }]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'co-chair-jwt',
      fetchImpl
    });
    await client.listRoster();

    const blob = __getCapturedLines()
      .map((l) => JSON.stringify(l))
      .join('|');
    expect(blob).not.toContain(CANARY_DISPLAY_NAME);
    expect(blob).not.toContain(CANARY_EMPLOYER_CONTACT);
    expect(blob).not.toContain(CANARY_UID);
  });

  it('pending-invite PI + uid NEVER land in the project structured-log capture on a happy listPendingInvites', async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: { ok: true, data: PENDING_ROWS } }]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'co-chair-jwt',
      fetchImpl
    });
    await client.listPendingInvites();

    const blob = __getCapturedLines()
      .map((l) => JSON.stringify(l))
      .join('|');
    expect(blob).not.toContain(CANARY_DISPLAY_NAME);
    expect(blob).not.toContain(CANARY_UID);
  });

  it('roster PI NEVER lands in the project log on a denial branch (rls_denied)', async () => {
    const { fetchImpl } = stubFetch([{ status: 403, body: { ok: false, error: 'rls_denied' } }]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'worker-member-jwt',
      fetchImpl
    });
    await client.listRoster();

    const blob = __getCapturedLines()
      .map((l) => JSON.stringify(l))
      .join('|');
    expect(blob).not.toContain(CANARY_DISPLAY_NAME);
    expect(blob).not.toContain(CANARY_UID);
  });

  it('roster PI + raw uid NEVER land in sessionStorage / localStorage / URL across a listRoster call', async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: { ok: true, data: ROSTER_ROWS } }]);
    const client = createSupabaseCommitteeClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'co-chair-jwt',
      fetchImpl
    });
    await client.listRoster();

    if (typeof sessionStorage !== 'undefined') {
      let blob = '';
      for (let j = 0; j < sessionStorage.length; j++) {
        const k = sessionStorage.key(j);
        if (k === null) continue;
        blob += k + '=' + (sessionStorage.getItem(k) ?? '') + ';';
      }
      expect(blob).not.toContain(CANARY_DISPLAY_NAME);
      expect(blob).not.toContain(CANARY_UID);
    }
    if (typeof localStorage !== 'undefined') {
      let blob = '';
      for (let j = 0; j < localStorage.length; j++) {
        const k = localStorage.key(j);
        if (k === null) continue;
        blob += k + '=' + (localStorage.getItem(k) ?? '') + ';';
      }
      expect(blob).not.toContain(CANARY_DISPLAY_NAME);
      expect(blob).not.toContain(CANARY_UID);
    }
    if (typeof window !== 'undefined' && window.location) {
      expect(window.location.href).not.toContain(CANARY_DISPLAY_NAME);
      expect(window.location.href).not.toContain(CANARY_UID);
    }
  });
});
