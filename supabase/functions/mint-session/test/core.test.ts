/**
 * mint-session / core tests (Deno-native) — ADR-0023 / threat-model §3.12.
 *
 * Run: `deno test supabase/functions/mint-session/test/core.test.ts`.
 *
 * Asserts the security-critical control flow: server-side uid resolution
 * (F-117), unreachable signer on a bad assertion, unknown-credential rejection
 * (F-119), TTL clamp + jti-written-before-token (F-116).
 */

import { mintSessionFromAssertion, type MintDeps, type AssertionInput } from '../core.ts';

// Inline, dependency-free assertions (no network fetch — runs offline + in CI).
function assert(cond: unknown, msg = 'assertion failed'): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `expected ${e}, got ${a}`);
}

const INPUT: AssertionInput = {
  credentialId: 'cred-abc',
  clientDataJSON: 'eyJ0eXAiOiJ3ZWJhdXRobi5nZXQifQ',
  authenticatorData: 'YXV0aC1kYXRh',
  signature: 'c2ln',
  origin: 'https://app.example.test'
};

const FIXED_NOW = 1_750_000_000_000; // ms

function makeDeps(over: Partial<MintDeps> = {}): MintDeps {
  return {
    verifyAssertion: async (i) => ({ ok: true, credentialId: i.credentialId }),
    lookupUserIdByCredential: async (cid) => (cid === 'cred-abc' ? 'user-real-1' : null),
    createSession: async () => ({ session_id: 'sess-1' }),
    signJwt: async (claims) => `signed.${claims.sub}.${claims.session_id}.${claims.exp}`,
    now: () => FIXED_NOW,
    ...over
  };
}

Deno.test('mints a session whose sub is the credential-resolved uid (happy path)', async () => {
  const res = await mintSessionFromAssertion(makeDeps(), INPUT);
  assert(res.ok);
  assertEquals(res.session_id, 'sess-1');
  // sub == lookupUserIdByCredential result, encoded into the signed token.
  assertEquals(res.access_token, 'signed.user-real-1.sess-1.' + (FIXED_NOW / 1000 + 300));
  assertEquals(res.expires_at_ms, FIXED_NOW + 300_000);
});

Deno.test('F-117 — sub comes from the credential, NOT from anything client-supplied', async () => {
  // The verifier proves a DIFFERENT credential than the one in the input body;
  // the resolved uid must follow the *proven* credential, never the body.
  const deps = makeDeps({
    verifyAssertion: async () => ({ ok: true, credentialId: 'cred-proven' }),
    lookupUserIdByCredential: async (cid) =>
      cid === 'cred-proven' ? 'user-proven' : 'user-ATTACKER'
  });
  const res = await mintSessionFromAssertion(deps, { ...INPUT, credentialId: 'cred-spoofed' });
  assert(res.ok);
  assertEquals(res.access_token, 'signed.user-proven.sess-1.' + (FIXED_NOW / 1000 + 300));
});

Deno.test('F-117 — the signer is unreachable when the assertion fails to verify', async () => {
  let signerCalled = false;
  const deps = makeDeps({
    verifyAssertion: async () => ({ ok: false }),
    signJwt: async (c) => {
      signerCalled = true;
      return 'should-not-happen';
    }
  });
  const res = await mintSessionFromAssertion(deps, INPUT);
  assertEquals(res.ok, false);
  if (!res.ok) assertEquals(res.reason, 'assertion_invalid');
  assert(!signerCalled, 'signJwt must not be called on a failed assertion');
});

Deno.test('F-119 — an unknown credential cannot mint a session', async () => {
  let signerCalled = false;
  const deps = makeDeps({
    lookupUserIdByCredential: async () => null,
    signJwt: async () => {
      signerCalled = true;
      return 'x';
    }
  });
  const res = await mintSessionFromAssertion(deps, INPUT);
  assertEquals(res.ok, false);
  if (!res.ok) assertEquals(res.reason, 'unknown_credential');
  assert(!signerCalled, 'signJwt must not be called for an unknown credential');
});

Deno.test('F-116 — TTL is clamped to ≤300s even if a larger value is requested', async () => {
  let signedExp = 0;
  const deps = makeDeps({
    ttlSeconds: 86_400,
    signJwt: async (c) => {
      signedExp = c.exp;
      return 'x';
    }
  });
  const res = await mintSessionFromAssertion(deps, INPUT);
  assert(res.ok);
  assertEquals(signedExp, Math.floor(FIXED_NOW / 1000) + 300);
  assertEquals(res.expires_at_ms, FIXED_NOW + 300_000);
});

Deno.test('F-116 — the jti row is written before the token is signed', async () => {
  const order: string[] = [];
  const deps = makeDeps({
    createSession: async () => {
      order.push('createSession');
      return { session_id: 'sess-1' };
    },
    signJwt: async () => {
      order.push('signJwt');
      return 'x';
    }
  });
  const res = await mintSessionFromAssertion(deps, INPUT);
  assert(res.ok);
  assertEquals(order, ['createSession', 'signJwt']);
});
