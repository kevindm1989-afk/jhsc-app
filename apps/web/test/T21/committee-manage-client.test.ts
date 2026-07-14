/**
 * ADR-0029 P1-8e — SupabaseCommitteeClient management-op METHODS
 * (setRoles / removeMember / reactivateMember). Surface K screen 5.
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. It pins the
 * WIRE contract of the three governance-op client methods BEFORE they exist, so
 * every test here fails against `main` for the intended reason: the class today
 * exposes only issueInvite / reissueTotp / listRoster / listPendingInvites
 * (apps/web/src/lib/committee/supabase-committee-client.ts:151-230). Calling
 * `client.setRoles(...)` / `.removeMember(...)` / `.reactivateMember(...)` throws
 * "is not a function" at runtime — the correct red signal.
 *
 * Why the client methods are pinned here (F-181 architecture): the P1-8e card
 * maps the CommitteeOpReason returned by these methods onto the discriminated
 * governance states (4eyes_required / last_co_chair / invalid_role / not_found /
 * done). If the method drops the reason, collapses it, or reshapes the wire,
 * the card's discrimination (finding #4) cannot hold. This file pins:
 *   - op name + body shape (1:1 with the committee-op EF arms — index.ts:44-46,
 *     dispatch :78-83 → core.ts setRoles :132 / removeMember :143 / reactivate :153).
 *   - removeMember unwraps the EF's BARE `grace_until` SCALAR (committee_remove_member
 *     RETURNS timestamptz — a bare string on `data`, NOT `{grace_until}`).
 *   - every CommitteeOpReason maps through 1:1 with its HTTP status (mirrors the
 *     existing `invoke()` mapping used by issueInvite/listRoster).
 *
 * Hermetic: the class's native transport seam is injected (no network, no clock,
 * no RNG). The transport records the posted body and returns a canned wire pair.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
import {
  SupabaseCommitteeClient,
  type CommitteeOpReason,
  type CommitteeOpTransport
} from '../../src/lib/committee/supabase-committee-client';

// The management-op methods are new; type them loosely so this file compiles
// against `main` (where they do not exist) and fails at RUNTIME (the intended
// red), not at a TS resolution error that would mask the signal.
type ManageClient = SupabaseCommitteeClient & {
  setRoles: (input: {
    target_user_id: string;
    roles: string[];
    second_approver_id?: string | null;
  }) => Promise<{ ok: true; data: unknown } | { ok: false; reason: CommitteeOpReason; status: number }>;
  removeMember: (input: {
    target_user_id: string;
    second_approver_id?: string | null;
  }) => Promise<{ ok: true; data: string } | { ok: false; reason: CommitteeOpReason; status: number }>;
  reactivateMember: (input: {
    target_user_id: string;
  }) => Promise<{ ok: true; data: unknown } | { ok: false; reason: CommitteeOpReason; status: number }>;
};

const TARGET = '00000000-0000-4000-8000-0000000000t1';
const APPROVER = '00000000-0000-4000-8000-0000000000a2';
const GRACE_ISO = '2026-10-12T09:00:00.000Z';

function stubTransport(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  const transport: CommitteeOpTransport = async (body) => {
    calls.push(body);
    const r = responses[Math.min(i++, responses.length - 1)];
    return { status: r.status, body: r.body };
  };
  return { transport, calls };
}

function makeClient(responses: Array<{ status: number; body: unknown }>) {
  const { transport, calls } = stubTransport(responses);
  const client = new SupabaseCommitteeClient({ transport }) as ManageClient;
  return { client, calls };
}

beforeEach(() => {
  __resetCapture();
  __setTestSink();
});
afterEach(() => {
  __resetCapture();
  vi.restoreAllMocks();
});

// ===========================================================================
// METHOD SHAPE — the three governance ops exist on the same client instance.
// ===========================================================================

describe('P1-8e [client] governance-op methods exist on SupabaseCommitteeClient', () => {
  it('exposes setRoles + removeMember + reactivateMember (siblings of listRoster)', () => {
    const { client } = makeClient([{ status: 200, body: { ok: true, data: null } }]);
    expect(typeof client.setRoles, 'setRoles must be a method').toBe('function');
    expect(typeof client.removeMember, 'removeMember must be a method').toBe('function');
    expect(typeof client.reactivateMember, 'reactivateMember must be a method').toBe('function');
  });
});

// ===========================================================================
// set_roles — op name + body (1:1 with committee-op EF arm) + the approver.
// ===========================================================================

describe('P1-8e [client] setRoles — POSTs {op:"set_roles", target_user_id, roles, second_approver_id?}', () => {
  it('posts the op + target + roles set and returns ok on a clean void RPC return', async () => {
    const { client, calls } = makeClient([{ status: 200, body: { ok: true, data: null } }]);
    const r = await client.setRoles({ target_user_id: TARGET, roles: ['certified_member', 'worker_member'] });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.op).toBe('set_roles');
    expect(calls[0]!.target_user_id).toBe(TARGET);
    expect(calls[0]!.roles).toEqual(['certified_member', 'worker_member']);
  });

  it('forwards the chosen second_approver_id (the distinct co-chair) on a self-demotion', async () => {
    const { client, calls } = makeClient([{ status: 200, body: { ok: true, data: null } }]);
    await client.setRoles({ target_user_id: TARGET, roles: ['worker_member'], second_approver_id: APPROVER });
    expect(calls[0]!.second_approver_id).toBe(APPROVER);
  });

  it('carries NO real second_approver_id when none is supplied (other-member change → null/absent)', async () => {
    const { client, calls } = makeClient([{ status: 200, body: { ok: true, data: null } }]);
    await client.setRoles({ target_user_id: TARGET, roles: ['worker_member'] });
    // The server reads the approver ONLY inside the self-action branch; for an
    // other-member change it must not fabricate one (null or omitted are both OK).
    expect(calls[0]!.second_approver_id ?? null).toBeNull();
  });
});

// ===========================================================================
// remove — op name + body + the BARE grace_until scalar (mirror the wire).
// ===========================================================================

describe('P1-8e [client] removeMember — POSTs {op:"remove", ...} + returns the BARE grace_until string', () => {
  it('posts the remove op with the target and returns the bare grace ISO string on success', async () => {
    const { client, calls } = makeClient([{ status: 200, body: { ok: true, data: GRACE_ISO } }]);
    const r = await client.removeMember({ target_user_id: TARGET });
    expect(calls[0]!.op).toBe('remove');
    expect(calls[0]!.target_user_id).toBe(TARGET);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // committee_remove_member RETURNS timestamptz — a BARE scalar on `data`,
    // never wrapped as { grace_until }. The card interpolates this into
    // committee.remove.done.body.
    expect(r.data).toBe(GRACE_ISO);
    expect(typeof r.data).toBe('string');
    expect(r.data).not.toMatchObject({ grace_until: expect.anything() });
  });

  it('forwards the chosen second_approver_id on a self-remove', async () => {
    const { client, calls } = makeClient([{ status: 200, body: { ok: true, data: GRACE_ISO } }]);
    await client.removeMember({ target_user_id: TARGET, second_approver_id: APPROVER });
    expect(calls[0]!.second_approver_id).toBe(APPROVER);
  });
});

// ===========================================================================
// reactivate — op name + body (NO second_approver_id param — F-182 contrast).
// ===========================================================================

describe('P1-8e [client] reactivateMember — POSTs {op:"reactivate", target_user_id} (no approver)', () => {
  it('posts only the reactivate op + target (reactivate has NO 4-eyes / approver arg)', async () => {
    const { client, calls } = makeClient([{ status: 200, body: { ok: true, data: null } }]);
    const r = await client.reactivateMember({ target_user_id: TARGET });
    expect(r.ok).toBe(true);
    expect(calls[0]!.op).toBe('reactivate');
    expect(calls[0]!.target_user_id).toBe(TARGET);
    // F-182 carry-forward: reactivation takes no second approver — the client
    // must not invent one (would falsely signal a 4-eyes control the SQL lacks).
    expect(calls[0]!.second_approver_id).toBeUndefined();
  });
});

// ===========================================================================
// REASON DISCRIMINATION at the wire boundary (feeds finding #4 in the card).
// Every CommitteeOpReason maps 1:1 with its HTTP status — never collapsed.
// ===========================================================================

describe('P1-8e [client] reason discrimination — each denial maps 1:1 (never collapsed)', () => {
  const cases: Array<{ reason: CommitteeOpReason; status: number }> = [
    { reason: '4eyes_required', status: 403 },
    { reason: 'last_co_chair', status: 409 },
    { reason: 'invalid_role', status: 422 },
    { reason: 'not_found', status: 404 },
    { reason: 'already_active', status: 409 },
    { reason: 'rls_denied', status: 403 }
  ];

  for (const { reason, status } of cases) {
    it(`setRoles maps a ${status} ${reason} into { ok:false, reason:'${reason}', status:${status} }`, async () => {
      const { client } = makeClient([{ status, body: { ok: false, error: reason } }]);
      const r = await client.setRoles({ target_user_id: TARGET, roles: ['worker_member'] });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe(reason);
      expect(r.status).toBe(status);
    });
  }

  it('removeMember surfaces last_co_chair (409) distinctly — not a generic rls_denied', async () => {
    const { client } = makeClient([{ status: 409, body: { ok: false, error: 'last_co_chair' } }]);
    const r = await client.removeMember({ target_user_id: TARGET });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('last_co_chair');
    expect(r.reason).not.toBe('rls_denied');
    expect(r.status).toBe(409);
  });

  it('reactivateMember surfaces already_active (409) distinctly', async () => {
    const { client } = makeClient([{ status: 409, body: { ok: false, error: 'already_active' } }]);
    const r = await client.reactivateMember({ target_user_id: TARGET });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('already_active');
  });

  it('a network-shaped failure (status 0 / no ok flag) surfaces as reason:unknown', async () => {
    const { client } = makeClient([{ status: 0, body: {} }]);
    const r = await client.removeMember({ target_user_id: TARGET });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unknown');
    expect(r.status).toBe(0);
  });
});
