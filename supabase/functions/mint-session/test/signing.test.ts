/**
 * mint-session / signing tests (Deno-native, hermetic — no network).
 * Run: `deno test --allow-read --allow-env supabase/functions/mint-session/test/signing.test.ts`.
 *
 * Proves the ES256 token surface (F-118): both tokens are asymmetric ES256,
 * carry the expected claims, verify under the locally-held public key, and the
 * exported JWKS key never leaks the private scalar.
 */

import {
  __resetKeyForTest,
  publicJwk,
  signMintWriterToken,
  signSessionJwt,
  verifyWithLocalKey
} from '../signing.ts';

function assert(cond: unknown, msg = 'assertion failed'): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `expected ${e}, got ${a}`);
}

function decodeSegment(token: string, index: 0 | 1): Record<string, unknown> {
  const seg = token.split('.')[index].replace(/-/g, '+').replace(/_/g, '/');
  const padded = seg + '='.repeat((4 - (seg.length % 4)) % 4);
  return JSON.parse(atob(padded));
}

Deno.test('session JWT is ES256, carries the core claims, and verifies under the local key', async () => {
  __resetKeyForTest();
  const iat = 1_750_000_000;
  const token = await signSessionJwt({ sub: 'user-1', role: 'authenticated', session_id: 'sess-1', iat, exp: iat + 300 });

  const header = decodeSegment(token, 0);
  assertEquals(header.alg, 'ES256');
  assertEquals(header.typ, 'JWT');
  assert(typeof header.kid === 'string' && (header.kid as string).length > 0, 'kid present');

  const payload = decodeSegment(token, 1);
  assertEquals(payload.sub, 'user-1');
  assertEquals(payload.role, 'authenticated');
  assertEquals(payload.session_id, 'sess-1');
  assertEquals(payload.exp, iat + 300);
  assertEquals(payload.aud, 'authenticated');

  assert(await verifyWithLocalKey(token), 'signature must verify under the public key');
});

Deno.test('a tampered payload fails verification', async () => {
  __resetKeyForTest();
  const token = await signSessionJwt({ sub: 'u', role: 'authenticated', session_id: 's', iat: 1, exp: 2 });
  const [h, , s] = token.split('.');
  const forgedPayload = btoa('{"sub":"attacker"}').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assertEquals(await verifyWithLocalKey(`${h}.${forgedPayload}.${s}`), false);
});

Deno.test('mint_writer token carries role=mint_writer and a short TTL', async () => {
  __resetKeyForTest();
  const nowMs = 1_750_000_000_000;
  const token = await signMintWriterToken(nowMs, 30);
  const payload = decodeSegment(token, 1);
  assertEquals(payload.role, 'mint_writer');
  assertEquals((payload.exp as number) - (payload.iat as number), 30);
  assert(await verifyWithLocalKey(token), 'mint_writer token must verify');
});

Deno.test('publicJwk is JWKS-ready and never exposes the private scalar', async () => {
  __resetKeyForTest();
  const jwk = await publicJwk();
  assertEquals(jwk.kty, 'EC');
  assertEquals(jwk.crv, 'P-256');
  assertEquals(jwk.use, 'sig');
  assertEquals(jwk.alg, 'ES256');
  assert(typeof jwk.kid === 'string' && jwk.kid.length > 0, 'kid present');
  assert(!('d' in jwk), 'public JWK must not contain the private scalar d');
});

Deno.test('a fixed MINT_SIGNING_JWK yields a stable kid and verifiable tokens', async () => {
  // Generated in-test (not committed); proves the env key-custody path imports
  // deterministically — same key in ⇒ same kid out across resets.
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

  Deno.env.set('MINT_SIGNING_JWK', JSON.stringify(jwk));
  try {
    __resetKeyForTest();
    const kidA = (await publicJwk()).kid;
    __resetKeyForTest();
    const kidB = (await publicJwk()).kid;
    assertEquals(kidA, kidB);

    __resetKeyForTest();
    const token = await signMintWriterToken(Date.now());
    assert(await verifyWithLocalKey(token), 'tokens from the imported key must verify');
  } finally {
    Deno.env.delete('MINT_SIGNING_JWK');
    __resetKeyForTest();
  }
});
