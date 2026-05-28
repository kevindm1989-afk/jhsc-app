/**
 * t14-op / core tests (Deno-native) — T14.1.
 * Run: `deno test supabase/functions/t14-op/test/core.test.ts`.
 *
 * Hermetic: verifies RPC arg forwarding + error-mapping (F-21 42501 → rls_denied,
 * 23514 → invalid_input, message literals).
 */

import {
  mapRpcError,
  readS51,
  readWorkRefusal,
  submitS51,
  submitWorkRefusal,
  updateS51,
  updateWorkRefusal,
  type RpcError,
  type RpcPort
} from '../core.ts';

function assert(c: unknown, m = 'assertion failed'): asserts c { if (!c) throw new Error(m); }
function assertEquals(a: unknown, e: unknown, m?: string): void {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(m ?? `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function fakeRpc(result: { data: unknown; error: RpcError | null }, calls: Array<{ fn: string; args: Record<string, unknown> }>): RpcPort {
  return async (fn, args) => { calls.push({ fn, args }); return result; };
}

Deno.test('submitWorkRefusal forwards work_refusal_submit + returns the id', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const r = await submitWorkRefusal(fakeRpc({ data: 'wr-1', error: null }, c), { title_ct: '\\x71', notes_ct: '\\xBE', passphrase: 'p' });
  assert(r.ok); assertEquals(r.data, { id: 'wr-1' });
  assertEquals(c[0], { fn: 'work_refusal_submit', args: { p_title_ct: '\\x71', p_notes_ct: '\\xBE', p_passphrase: 'p' } });
});

Deno.test('readWorkRefusal returns first row or null (denied/missing)', async () => {
  const ok = await readWorkRefusal(fakeRpc({ data: [{ title_ct: '\\x71', notes_ct: '\\xBE' }], error: null }, []), { id: 'wr-1', passphrase: 'p' });
  assert(ok.ok); assertEquals(ok.data, { title_ct: '\\x71', notes_ct: '\\xBE' });
  const empty = await readWorkRefusal(fakeRpc({ data: [], error: null }, []), { id: 'wr-1', passphrase: 'wrong' });
  assert(empty.ok); assertEquals(empty.data, null);
});

Deno.test('updateWorkRefusal forwards only provided fields', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  await updateWorkRefusal(fakeRpc({ data: null, error: null }, c), { id: 'wr-1', notes_ct: '\\xD00D' });
  assertEquals(c[0], { fn: 'work_refusal_update', args: { p_id: 'wr-1', p_notes_ct: '\\xD00D' } });
});

Deno.test('submitS51 forwards photos_ct array (default [])', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  await submitS51(fakeRpc({ data: 's-1', error: null }, c), { title_ct: '\\x51', notes_ct: '\\xCA', photos_ct: ['\\xAA', '\\xBB'], passphrase: 's' });
  assertEquals(c[0].args, { p_title_ct: '\\x51', p_notes_ct: '\\xCA', p_photos_ct: ['\\xAA', '\\xBB'], p_passphrase: 's' });

  const c2: Array<{ fn: string; args: Record<string, unknown> }> = [];
  await submitS51(fakeRpc({ data: 's-2', error: null }, c2), { title_ct: '\\x01', notes_ct: '\\x02' });
  assertEquals(c2[0].args, { p_title_ct: '\\x01', p_notes_ct: '\\x02', p_photos_ct: [], p_passphrase: null });
});

Deno.test('readS51 returns the first row with photos_ct array', async () => {
  const r = await readS51(fakeRpc({ data: [{ title_ct: '\\x51', notes_ct: '\\xCA', photos_ct: ['\\xAA', '\\xBB'] }], error: null }, []), { id: 's-1', passphrase: 's' });
  assert(r.ok); assertEquals(r.data, { title_ct: '\\x51', notes_ct: '\\xCA', photos_ct: ['\\xAA', '\\xBB'] });
});

Deno.test('updateS51 forwards only provided fields', async () => {
  const c: Array<{ fn: string; args: Record<string, unknown> }> = [];
  await updateS51(fakeRpc({ data: null, error: null }, c), { id: 's-1', title_ct: '\\xFF' });
  assertEquals(c[0], { fn: 's51_evidence_update', args: { p_id: 's-1', p_title_ct: '\\xFF' } });
});

Deno.test('mapRpcError: 42501 → rls_denied/403, P0001 not_found → 404, 23514 → invalid_input/422, unknown → 400', () => {
  const cases: Array<[RpcError, string, number]> = [
    [{ code: '42501', message: 'rls_denied' }, 'rls_denied', 403],
    [{ code: 'P0001', message: 'not_found' }, 'not_found', 404],
    [{ code: '23514', message: 'check constraint' }, 'invalid_input', 422],
    [{ code: '08006', message: 'conn failure' }, 'unknown', 400]
  ];
  for (const [err, reason, status] of cases) assertEquals(mapRpcError(err), { reason, status });
});
