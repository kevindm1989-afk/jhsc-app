/**
 * committee-op / core tests (Deno-native) — ADR-0023 Decision 3.
 *
 * Run: `deno test supabase/functions/committee-op/test/core.test.ts`.
 *
 * Verifies the RPC error → {ok:false,reason,status} mapping matches the T06
 * library contract, and that each op forwards the right RPC name + args.
 * Dependency-free (no remote import) so it runs offline + in CI.
 */

import {
  inviteMember,
  setRoles,
  removeMember,
  mapRpcError,
  type RpcPort,
  type RpcError
} from '../core.ts';

function assert(cond: unknown, msg = 'assertion failed'): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `expected ${e}, got ${a}`);
}

/** An RpcPort that returns a fixed result and records the call. */
function fakeRpc(
  result: { data: unknown; error: RpcError | null },
  calls: Array<{ fn: string; args: Record<string, unknown> }>
): RpcPort {
  return async (fn, args) => {
    calls.push({ fn, args });
    return result;
  };
}

Deno.test('inviteMember forwards the RPC name + mapped args and returns the invite_id', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: 'invite-uuid-1', error: null }, calls);
  const res = await inviteMember(rpc, { target_user_id: 'u1', roles: ['worker_member'] });
  assert(res.ok);
  assertEquals(res.data, { invite_id: 'invite-uuid-1' });
  assertEquals(calls[0].fn, 'committee_invite_member');
  assertEquals(calls[0].args, {
    p_target_user_id: 'u1',
    p_roles: ['worker_member'],
    p_display_name: null,
    p_off_employer_contact: null
  });
});

Deno.test('removeMember forwards the second_approver and returns grace_until', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: '2026-08-24T00:00:00Z', error: null }, calls);
  const res = await removeMember(rpc, { target_user_id: 'u1', second_approver_id: 'cc2' });
  assert(res.ok);
  assertEquals(calls[0].fn, 'committee_remove_member');
  assertEquals(calls[0].args, { p_target_user_id: 'u1', p_second_approver_id: 'cc2' });
});

Deno.test('a 42501 RAISE maps to rls_denied/403', async () => {
  const rpc = fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []);
  const res = await setRoles(rpc, { target_user_id: 'u1', roles: ['worker_member'] });
  assertEquals(res, { ok: false, reason: 'rls_denied', status: 403 });
});

Deno.test('reason-literal messages map to their reason + status', () => {
  const cases: Array<[RpcError, string, number]> = [
    [{ code: 'P0001', message: 'last_co_chair' }, 'last_co_chair', 409],
    [{ code: 'P0001', message: 'already_active' }, 'already_active', 409],
    [{ code: 'P0001', message: 'membership_exists' }, 'membership_exists', 409],
    [{ code: 'P0001', message: 'not_found' }, 'not_found', 404],
    [{ code: 'P0001', message: 'invite_invalid' }, 'invite_invalid', 422],
    [{ code: 'P0001', message: 'invalid_role' }, 'invalid_role', 422],
    [{ code: '42501', message: '4eyes_required' }, '4eyes_required', 403]
  ];
  for (const [err, reason, status] of cases) {
    assertEquals(mapRpcError(err), { reason, status });
  }
});

Deno.test('a CHECK violation (23514) falls back to invalid_role; unknown → unknown/400', () => {
  assertEquals(mapRpcError({ code: '23514', message: 'new row violates check constraint' }), {
    reason: 'invalid_role',
    status: 422
  });
  assertEquals(mapRpcError({ code: '08006', message: 'connection failure' }), {
    reason: 'unknown',
    status: 400
  });
});
