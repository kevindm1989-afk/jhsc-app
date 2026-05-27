/**
 * mint-session / webauthn tests (Deno-native, hermetic).
 * Run: `deno test --allow-read --allow-env supabase/functions/mint-session/test/webauthn.test.ts`.
 *
 * Proves the sign-counter clone-detection policy (ADR-0002 passkey integrity).
 */

import { evaluateCounter } from '../webauthn.ts';

function assert(cond: unknown, msg = 'assertion failed'): asserts cond {
  if (!cond) throw new Error(msg);
}

Deno.test('a strictly-increasing counter is accepted', () => {
  assert(evaluateCounter(5, 6));
});

Deno.test('an equal counter is rejected as a clone signal (stored > 0)', () => {
  assert(!evaluateCounter(5, 5));
});

Deno.test('a decreasing counter is rejected as a clone signal', () => {
  assert(!evaluateCounter(5, 3));
});

Deno.test('a stored counter of 0 accepts any value (counter unsupported / first use)', () => {
  assert(evaluateCounter(0, 0));
  assert(evaluateCounter(0, 9));
});
