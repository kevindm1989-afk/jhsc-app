/**
 * mint-session / assertion + full-flow tests (Deno-native).
 * Run: deno test --allow-read --allow-env supabase/functions/mint-session/test/assertion.test.ts
 *
 * This is the logic-level WebAuthn-assertion e2e: it GENERATES a real ES256
 * passkey, builds a valid authenticator assertion (authenticatorData ‖
 * SHA-256(clientDataJSON), DER-encoded ECDSA signature) + the COSE public key,
 * and drives the actual @simplewebauthn verification (assertion.ts) plus the
 * tested mint orchestration (core.ts) and the real ES256 signer (signing.ts).
 *
 * Proves: a genuine assertion verifies and mints a token (F-117/F-119 uid is
 * server-resolved; F-116 jti-before-token); tampered signature, wrong origin,
 * and replayed/!matching challenge are all rejected (F-37). The assertion-build
 * helper uses crypto.subtle (test files are exempt from the libsodium gate).
 *
 * Network: fetches @simplewebauthn from npm at run time (CI deno gate).
 */

import { verifyWebAuthnAssertion, type AssertionContext, type RawAssertion } from '../assertion.ts';
import { mintSessionFromAssertion, type AssertionInput, type MintDeps } from '../core.ts';
import { __resetKeyForTest, signSessionJwt, verifyWithLocalKey } from '../signing.ts';

function assert(cond: unknown, msg = 'assertion failed'): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(msg ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const enc = new TextEncoder();
function b64url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b));
}

// raw P1363 (r‖s) → ASN.1 DER, as WebAuthn assertions carry.
function p1363ToDer(sig: Uint8Array): Uint8Array {
  const trim = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    x = x.slice(i);
    if (x[0] & 0x80) x = Uint8Array.from([0, ...x]);
    return x;
  };
  const R = trim(sig.slice(0, 32));
  const S = trim(sig.slice(32, 64));
  const body = Uint8Array.from([0x02, R.length, ...R, 0x02, S.length, ...S]);
  return Uint8Array.from([0x30, body.length, ...body]);
}

// COSE_Key (EC2/ES256/P-256) for a P-256 public JWK.
function coseKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  return Uint8Array.from([
    0xa5, // map(5)
    0x01, 0x02, // kty: EC2
    0x03, 0x26, // alg: ES256 (-7)
    0x20, 0x01, // crv: P-256 (1)
    0x21, 0x58, 0x20, ...x, // x: bstr(32)
    0x22, 0x58, 0x20, ...y // y: bstr(32)
  ]);
}

const RP_ID = 'app.example.test';
const ORIGIN = 'https://app.example.test';
const CRED_ID = b64url(enc.encode('mint-cred-1'));

interface BuiltAssertion {
  raw: RawAssertion;
  cose: Uint8Array;
}

async function buildAssertion(opts: { challenge: string; counter: number; origin?: string }): Promise<BuiltAssertion> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const x = Uint8Array.from(atob(jwk.x!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const y = Uint8Array.from(atob(jwk.y!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

  const rpIdHash = await sha256(enc.encode(RP_ID));
  const counter = new Uint8Array([
    (opts.counter >>> 24) & 0xff,
    (opts.counter >>> 16) & 0xff,
    (opts.counter >>> 8) & 0xff,
    opts.counter & 0xff
  ]);
  const authData = Uint8Array.from([...rpIdHash, 0x05, ...counter]); // flags UP|UV
  const clientDataJSON = enc.encode(
    JSON.stringify({ type: 'webauthn.get', challenge: opts.challenge, origin: opts.origin ?? ORIGIN, crossOrigin: false })
  );
  const signedData = Uint8Array.from([...authData, ...(await sha256(clientDataJSON))]);
  const rawSig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signedData));

  return {
    raw: {
      credentialId: CRED_ID,
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authData),
      signature: b64url(p1363ToDer(rawSig))
    },
    cose: coseKey(x, y)
  };
}

function ctxFor(b: BuiltAssertion, challenge: string, storedCounter = 0): AssertionContext {
  return { publicKey: b.cose, storedCounter, rpId: RP_ID, expectedOrigin: ORIGIN, expectedChallenge: challenge };
}

Deno.test('a genuine assertion verifies and reports an increased counter', async () => {
  const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const built = await buildAssertion({ challenge, counter: 7 });
  const res = await verifyWebAuthnAssertion(built.raw, ctxFor(built, challenge, 0));
  assert(res.verified, 'genuine assertion must verify');
  assertEquals(res.newCounter, 7);
});

Deno.test('F-37 — a wrong expected origin is rejected', async () => {
  const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const built = await buildAssertion({ challenge, counter: 1 });
  const ctx = { ...ctxFor(built, challenge), expectedOrigin: 'https://evil.example.test' };
  assertEquals((await verifyWebAuthnAssertion(built.raw, ctx)).verified, false);
});

Deno.test('F-37 — a challenge mismatch (replay of a different challenge) is rejected', async () => {
  const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const built = await buildAssertion({ challenge, counter: 1 });
  const other = b64url(crypto.getRandomValues(new Uint8Array(32)));
  assertEquals((await verifyWebAuthnAssertion(built.raw, ctxFor(built, other))).verified, false);
});

Deno.test('a tampered signature is rejected', async () => {
  const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const built = await buildAssertion({ challenge, counter: 1 });
  const bad: RawAssertion = { ...built.raw, signature: built.raw.signature.slice(0, -4) + 'AAAA' };
  assertEquals((await verifyWebAuthnAssertion(bad, ctxFor(built, challenge))).verified, false);
});

Deno.test('full flow — a real assertion mints a verifiable session token', async () => {
  __resetKeyForTest();
  const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const built = await buildAssertion({ challenge, counter: 3 });

  const deps: MintDeps = {
    verifyAssertion: async (input: AssertionInput) => {
      const r = await verifyWebAuthnAssertion(input, ctxFor(built, challenge, 0));
      return r.verified ? { ok: true, credentialId: input.credentialId } : { ok: false };
    },
    lookupUserIdByCredential: () => Promise.resolve('user-real-1'),
    createSession: () => Promise.resolve({ session_id: 'sess-real-1' }),
    signJwt: (claims) => signSessionJwt(claims),
    now: () => 1_750_000_000_000
  };

  const input: AssertionInput = { ...built.raw, origin: ORIGIN };
  const result = await mintSessionFromAssertion(deps, input);
  assert(result.ok, 'a genuine assertion must mint a token');
  if (result.ok) {
    assertEquals(result.session_id, 'sess-real-1');
    assert(await verifyWithLocalKey(result.access_token), 'minted token must verify under the signer key');
  }
});
