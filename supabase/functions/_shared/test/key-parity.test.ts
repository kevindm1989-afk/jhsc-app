/**
 * Deno tests for _shared/key-parity.ts (ADR-0024 §2 cold-start gate).
 *
 * Run:
 *   deno test --allow-env supabase/functions/_shared/test/key-parity.test.ts
 *
 * The KEY_ENV_NAME is set / unset via Deno.env per scenario; the server
 * SHA is supplied via a test stub fetcher so no network is touched.
 */

import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { __resetForTests, assertKeyParity, KeyParityError } from '../key-parity.ts';

// Helper: SHA-256 hex of a UTF-8 string (mirrors the production helper).
async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
  return hex;
}

const TEST_KEY = 'synthetic-test-key-not-secret-1234567890abcdef';

Deno.test('match: env SHA equals server SHA ⇒ assertKeyParity resolves', async () => {
  __resetForTests();
  Deno.env.set('HMAC_PSEUDONYM_KEY', TEST_KEY);
  const serverSha = await sha256Hex(TEST_KEY);
  let emitterCalls = 0;
  await assertKeyParity(
    () => Promise.resolve(serverSha),
    () => Promise.resolve(void (emitterCalls += 1))
  );
  assertEquals(emitterCalls, 0, 'emitter must not fire on match');
  Deno.env.delete('HMAC_PSEUDONYM_KEY');
});

Deno.test('memoisation: second call short-circuits without re-fetching', async () => {
  __resetForTests();
  Deno.env.set('HMAC_PSEUDONYM_KEY', TEST_KEY);
  const serverSha = await sha256Hex(TEST_KEY);
  let fetchCalls = 0;
  const fetcher = () => {
    fetchCalls += 1;
    return Promise.resolve(serverSha);
  };
  await assertKeyParity(fetcher);
  await assertKeyParity(fetcher);
  await assertKeyParity(fetcher);
  assertEquals(fetchCalls, 1, 'fetcher must be called exactly once after first success');
  Deno.env.delete('HMAC_PSEUDONYM_KEY');
});

Deno.test('mismatch: env SHA != server SHA ⇒ throws + emitter fires', async () => {
  __resetForTests();
  Deno.env.set('HMAC_PSEUDONYM_KEY', TEST_KEY);
  let emitterCalls = 0;
  await assertRejects(
    () =>
      assertKeyParity(
        () => Promise.resolve('deadbeef'.repeat(8)), // wrong SHA
        () => Promise.resolve(void (emitterCalls += 1))
      ),
    KeyParityError
  );
  assertEquals(emitterCalls, 1, 'emitter fires exactly once on mismatch');
  Deno.env.delete('HMAC_PSEUDONYM_KEY');
});

Deno.test('unset env: throws + emitter fires', async () => {
  __resetForTests();
  Deno.env.delete('HMAC_PSEUDONYM_KEY');
  let emitterCalls = 0;
  await assertRejects(
    () => assertKeyParity(
      () => Promise.resolve('does-not-matter'),
      () => Promise.resolve(void (emitterCalls += 1))
    ),
    KeyParityError
  );
  assertEquals(emitterCalls, 1, 'emitter fires when env var is missing');
});

Deno.test('empty env: throws + emitter fires (same path as unset)', async () => {
  __resetForTests();
  Deno.env.set('HMAC_PSEUDONYM_KEY', '');
  let emitterCalls = 0;
  await assertRejects(
    () => assertKeyParity(
      () => Promise.resolve('does-not-matter'),
      () => Promise.resolve(void (emitterCalls += 1))
    ),
    KeyParityError
  );
  assertEquals(emitterCalls, 1, 'emitter fires when env var is empty');
  Deno.env.delete('HMAC_PSEUDONYM_KEY');
});

Deno.test('fetcher throws: throws KeyParityError (not the underlying) + emitter fires', async () => {
  __resetForTests();
  Deno.env.set('HMAC_PSEUDONYM_KEY', TEST_KEY);
  let emitterCalls = 0;
  await assertRejects(
    () => assertKeyParity(
      () => Promise.reject(new Error('db down')),
      () => Promise.resolve(void (emitterCalls += 1))
    ),
    KeyParityError
  );
  assertEquals(emitterCalls, 1, 'emitter fires when fetcher throws');
  Deno.env.delete('HMAC_PSEUDONYM_KEY');
});

Deno.test('key value NEVER appears in thrown error message', async () => {
  __resetForTests();
  const CANARY_KEY = 'CANARY-KEY-VALUE-MUST-NOT-LEAK-1234567890abcdef';
  Deno.env.set('HMAC_PSEUDONYM_KEY', CANARY_KEY);
  try {
    await assertKeyParity(
      () => Promise.resolve('deadbeef'.repeat(8)),
      undefined
    );
    assert(false, 'should have thrown');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(!msg.includes(CANARY_KEY), 'KeyParityError message must not include the raw key value');
  }
  Deno.env.delete('HMAC_PSEUDONYM_KEY');
});

Deno.test('mismatch SHA values NEVER appear in thrown error message', async () => {
  __resetForTests();
  Deno.env.set('HMAC_PSEUDONYM_KEY', TEST_KEY);
  const envSha = await sha256Hex(TEST_KEY);
  const wrongSha = 'deadbeef'.repeat(8);
  try {
    await assertKeyParity(
      () => Promise.resolve(wrongSha),
      undefined
    );
    assert(false, 'should have thrown');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(!msg.includes(envSha), 'KeyParityError must not include env SHA in message');
    assert(!msg.includes(wrongSha), 'KeyParityError must not include server SHA in message');
  }
  Deno.env.delete('HMAC_PSEUDONYM_KEY');
});
