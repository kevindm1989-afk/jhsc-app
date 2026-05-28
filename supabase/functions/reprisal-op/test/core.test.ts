/**
 * reprisal-op / core tests (Deno-native) — T13.1.
 * Run: `deno test supabase/functions/reprisal-op/test/core.test.ts`.
 *
 * Verifies the RPC error → {ok:false,reason,status} mapping and that each op
 * forwards the right RPC name + args. Dependency-free (runs offline + in CI).
 */

import {
  approveForensic,
  approveStatus,
  mapRpcError,
  proposeForensic,
  proposeStatus,
  readReprisal,
  submitReprisal,
  updateReprisal,
  type RpcError,
  type RpcPort
} from '../core.ts';

function assert(cond: unknown, msg = 'assertion failed'): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `expected ${e}, got ${a}`);
}

function fakeRpc(
  result: { data: unknown; error: RpcError | null },
  calls: Array<{ fn: string; args: Record<string, unknown> }>
): RpcPort {
  return async (fn, args) => {
    calls.push({ fn, args });
    return result;
  };
}

Deno.test('submitReprisal forwards reprisal_submit + args and returns the id', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: 'rep-1', error: null }, calls);
  const res = await submitReprisal(rpc, { title_ct: '\\xA1', body_ct: '\\xBEEF', passphrase: 'p' });
  assert(res.ok);
  assertEquals(res.data, { id: 'rep-1' });
  assertEquals(calls[0].fn, 'reprisal_submit');
  assertEquals(calls[0].args, { p_title_ct: '\\xA1', p_body_ct: '\\xBEEF', p_passphrase: 'p' });
});

Deno.test('readReprisal returns the first row, or null when no rows (denied/missing)', async () => {
  const ok = fakeRpc({ data: [{ title_ct: '\\xA1', body_ct: '\\xBEEF' }], error: null }, []);
  const r1 = await readReprisal(ok, { id: 'rep-1', passphrase: 'p' });
  assert(r1.ok);
  assertEquals(r1.data, { title_ct: '\\xA1', body_ct: '\\xBEEF' });

  const empty = fakeRpc({ data: [], error: null }, []);
  const r2 = await readReprisal(empty, { id: 'rep-1', passphrase: 'wrong' });
  assert(r2.ok);
  assertEquals(r2.data, null);
});

Deno.test('updateReprisal forwards only the provided fields', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: null, error: null }, calls);
  await updateReprisal(rpc, { id: 'rep-1', body_ct: '\\xCAFE' });
  assertEquals(calls[0].fn, 'reprisal_update');
  assertEquals(calls[0].args, { p_id: 'rep-1', p_body_ct: '\\xCAFE' });
});

Deno.test('proposeStatus / approveStatus forward the right RPCs', async () => {
  const c1: Array<{ fn: string; args: Record<string, unknown> }> = [];
  await proposeStatus(fakeRpc({ data: 'pend-1', error: null }, c1), { reprisal_id: 'rep-1', new_status: 'closed' });
  assertEquals(c1[0], { fn: 'reprisal_propose_status', args: { p_reprisal_id: 'rep-1', p_new_status: 'closed' } });

  const c2: Array<{ fn: string; args: Record<string, unknown> }> = [];
  await approveStatus(fakeRpc({ data: null, error: null }, c2), { pending_id: 'pend-1' });
  assertEquals(c2[0], { fn: 'reprisal_approve_status', args: { p_pending_id: 'pend-1' } });
});

Deno.test('forensic propose/approve forward the right RPCs and return the revealed pseudonym', async () => {
  const c1: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const pr = await proposeForensic(fakeRpc({ data: 'pf-1', error: null }, c1), { audit_log_id: '42', reveal_reason: 'tip' });
  assert(pr.ok);
  assertEquals(pr.data, { pending_id: 'pf-1' });
  assertEquals(c1[0], { fn: 'reprisal_propose_forensic', args: { p_audit_log_id: '42', p_reveal_reason: 'tip' } });

  const ar = await approveForensic(fakeRpc({ data: 'abcd1234ef567890', error: null }, []), { pending_id: 'pf-1' });
  assert(ar.ok);
  assertEquals(ar.data, { revealed_actor_pseudonym: 'abcd1234ef567890' });
});

Deno.test('reason-literal messages map to reason + status (incl. 4-eyes literals raised as 42501)', () => {
  const cases: Array<[RpcError, string, number]> = [
    [{ code: '42501', message: 'rls_denied' }, 'rls_denied', 403],
    [{ code: '42501', message: 'self_approve_denied' }, 'self_approve_denied', 403],
    [{ code: '42501', message: 'role_pair_invalid' }, 'role_pair_invalid', 403],
    [{ code: 'P0001', message: 'expired' }, 'expired', 409],
    [{ code: 'P0001', message: 'rate_limited' }, 'rate_limited', 429],
    [{ code: 'P0001', message: 'not_found' }, 'not_found', 404],
    [{ code: '23514', message: 'check constraint' }, 'invalid_status', 422],
    [{ code: '08006', message: 'conn failure' }, 'unknown', 400]
  ];
  for (const [err, reason, status] of cases) {
    assertEquals(mapRpcError(err), { reason, status });
  }
});
