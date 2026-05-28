/**
 * concern-op / core tests (Deno-native) — T08.1.
 *
 * Run: `deno test supabase/functions/concern-op/test/core.test.ts`.
 *
 * Verifies the RPC error → {ok:false,reason,status} mapping and that each op
 * forwards the right RPC name + args. Dependency-free (no remote import) so it
 * runs offline + in CI.
 */

import {
  mapRpcError,
  revealSource,
  submitConcern,
  updateConcern,
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

Deno.test('submitConcern forwards concern_submit with mapped args and returns the id', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: 'concern-uuid-1', error: null }, calls);
  const res = await submitConcern(rpc, {
    title_ct: '\\xAA',
    body_ct: '\\xBB',
    hazard_class: 'physical',
    severity: 'low',
    location_id: 'loc-1',
    anonymous: true
  });
  assert(res.ok);
  assertEquals(res.data, { id: 'concern-uuid-1' });
  assertEquals(calls[0].fn, 'concern_submit');
  assertEquals(calls[0].args, {
    p_title_ct: '\\xAA',
    p_body_ct: '\\xBB',
    p_hazard_class: 'physical',
    p_severity: 'low',
    p_location_id: 'loc-1',
    p_anonymous: true,
    p_source_name_ct: null,
    p_source_passphrase: null
  });
});

Deno.test('submitConcern (named) forwards the sealed source + passphrase', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: 'id2', error: null }, calls);
  await submitConcern(rpc, {
    title_ct: '\\x01',
    body_ct: '\\x02',
    hazard_class: 'chemical',
    severity: 'high',
    location_id: 'loc-2',
    anonymous: false,
    source_name_ct: '\\xCAFE',
    source_passphrase: 'open-sesame'
  });
  assertEquals(calls[0].args.p_source_name_ct, '\\xCAFE');
  assertEquals(calls[0].args.p_source_passphrase, 'open-sesame');
  assertEquals(calls[0].args.p_anonymous, false);
});

Deno.test('updateConcern forwards only the provided fields (NULL = unchanged)', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: null, error: null }, calls);
  const res = await updateConcern(rpc, { id: 'c1', body_ct: '\\xBEEF' });
  assert(res.ok);
  assertEquals(calls[0].fn, 'concern_update');
  assertEquals(calls[0].args, { p_id: 'c1', p_body_ct: '\\xBEEF' });
});

Deno.test('revealSource forwards id + passphrase and returns the source ciphertext', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = fakeRpc({ data: '\\xCAFEBABE', error: null }, calls);
  const res = await revealSource(rpc, { id: 'c1', passphrase: 'open-sesame' });
  assert(res.ok);
  assertEquals(res.data, { source_name_ct: '\\xCAFEBABE' });
  assertEquals(calls[0].fn, 'reveal_concern_source');
  assertEquals(calls[0].args, { p_id: 'c1', p_passphrase: 'open-sesame' });
});

Deno.test('revealSource on an anonymous concern returns null source', async () => {
  const rpc = fakeRpc({ data: null, error: null }, []);
  const res = await revealSource(rpc, { id: 'c1' });
  assert(res.ok);
  assertEquals(res.data, { source_name_ct: null });
});

Deno.test('a 42501 RAISE maps to rls_denied/403 (F-15)', async () => {
  const rpc = fakeRpc({ data: null, error: { code: '42501', message: 'rls_denied' } }, []);
  const res = await submitConcern(rpc, {
    title_ct: '\\x01', body_ct: '\\x02', hazard_class: 'physical', severity: 'low', location_id: 'l', anonymous: true
  });
  assertEquals(res, { ok: false, reason: 'rls_denied', status: 403 });
});

Deno.test('reason-literal messages map to their reason + status', () => {
  const cases: Array<[RpcError, string, number]> = [
    [{ code: 'P0001', message: 'rate_limited' }, 'rate_limited', 429],
    [{ code: 'P0001', message: 'not_found' }, 'not_found', 404],
    [{ code: '42501', message: 'rls_denied' }, 'rls_denied', 403],
    [{ code: '23514', message: 'new row violates check constraint' }, 'invalid_input', 422],
    [{ code: '08006', message: 'connection failure' }, 'unknown', 400]
  ];
  for (const [err, reason, status] of cases) {
    assertEquals(mapRpcError(err), { reason, status });
  }
});
