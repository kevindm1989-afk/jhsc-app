/**
 * mint-session / signing tests (Deno-native, hermetic — no network beyond the
 * libsodium npm fetch). Run:
 *   deno test --allow-read --allow-env supabase/functions/mint-session/test/signing.test.ts
 *
 * Proves the EdDSA/Ed25519 token surface (F-118, ADR-0003): both tokens are
 * asymmetric EdDSA, carry the expected claims, verify under the locally-held
 * public key, the exported JWKS key never leaks the private seed, and a fixed
 * key yields a stable, honored kid.
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

// A FIXED, NON-SECRET Ed25519 OKP JWK (d = 32-byte seed) for the key-custody
// test. Generated solely for this assertion; signs nothing outside this file.
const FIXED_JWK =
  '{"kty":"OKP","crv":"Ed25519","x":"UlNzJJIo_luiE9sGNAof8TSME62g81uaGQONrW4e9Tc","d":"e1J4O1YpCCfpyUUdeZJ4WUVqpVxMUM0m3AKWVkpX8cA","kid":"jhsc-test-fixed","alg":"EdDSA","use":"sig"}';

Deno.test('session JWT is EdDSA, carries the core claims, and verifies under the local key', async () => {
  __resetKeyForTest();
  const iat = 1_750_000_000;
  const token = await signSessionJwt({ sub: 'user-1', role: 'authenticated', session_id: 'sess-1', iat, exp: iat + 300 });

  const header = decodeSegment(token, 0);
  assertEquals(header.alg, 'EdDSA');
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

Deno.test('publicJwk is JWKS-ready (OKP/Ed25519) and never exposes the private seed', async () => {
  __resetKeyForTest();
  const jwk = await publicJwk();
  assertEquals(jwk.kty, 'OKP');
  assertEquals(jwk.crv, 'Ed25519');
  assertEquals(jwk.use, 'sig');
  assertEquals(jwk.alg, 'EdDSA');
  assert(typeof jwk.kid === 'string' && jwk.kid.length > 0, 'kid present');
  assert(!('d' in jwk), 'public JWK must not contain the private seed d');
});

Deno.test('a fixed MINT_SIGNING_JWK yields its declared kid and verifiable tokens', async () => {
  Deno.env.set('MINT_SIGNING_JWK', FIXED_JWK);
  try {
    __resetKeyForTest();
    assertEquals((await publicJwk()).kid, 'jhsc-test-fixed');
    __resetKeyForTest();
    const token = await signMintWriterToken(Date.now());
    assertEquals(decodeSegment(token, 0).kid, 'jhsc-test-fixed');
    assert(await verifyWithLocalKey(token), 'tokens from the imported key must verify');
  } finally {
    Deno.env.delete('MINT_SIGNING_JWK');
    __resetKeyForTest();
  }
});
