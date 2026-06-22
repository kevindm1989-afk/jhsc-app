/**
 * redeem-invite / per-IP rate-limit tests (F-175) — ADR-0029 P1-2 (KEYSTONE, EF).
 *
 * Run: `deno test --allow-read --allow-env supabase/functions/redeem-invite/test/rate-limit.test.ts`
 *
 * The redeem EF is permanently internet-reachable and UNAUTHENTICATED. The
 * keystone landed without an edge-side throttle; the second-opinion review +
 * the threat-model F-175 required one BEFORE the DB round-trip so a code-less
 * flood is bounded at the edge before reaching `redeem_invite_complete` (and
 * therefore can never weaponise the per-invite 5-attempt-lock). These tests
 * pin the implementation-blocking contract on the closed properties:
 *
 *   1. The throttle port is CONSULTED for both `challenge` and `register`
 *      BEFORE any DB-touching dep (issueChallenge / consumeChallenge / verify /
 *      rpc) is invoked — even for a request that would otherwise succeed.
 *   2. A throttled call short-circuits to a NORMALIZED 429 `rate_limited`
 *      response — the body never echoes the code, the TOTP, the credential
 *      secrets, the IP, or the raw SQL outcome (F-176).
 *   3. The RPC port is NEVER invoked on a throttled call (the central
 *      assertion that the throttle fires BEFORE the DB).
 *   4. The throttle decision is independent of action+RPC outcome: a throttled
 *      register call that would have failed at the DB still returns
 *      `rate_limited`/429, never the SQL-condition normalized error.
 *
 * Findings covered (threat-model §3.18):
 *   F-175 — per-IP throttle BEFORE the DB round-trip (the edge-level DoS
 *           shield; layered with the 5-attempt-lock inside the SQL terminal).
 *   F-176 — no IP / code / TOTP / credential secret leaks into the 429
 *           response body or any structured-log field the throttle emits.
 */

import {
  dispatch,
  type RedeemDeps,
  type RpcError,
  type RpcPort,
  type ThrottleDecision,
  type RegistrationVerifier,
} from '../core.ts';
import { log, type LogLine } from '../../_shared/log.ts';

// ---- tiny assert helpers (mirrors core.test.ts) -----------------------------
function assert(cond: unknown, msg = 'assertion failed'): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `expected ${e}, got ${a}`);
}
function assertStringAbsent(haystack: string, needle: string, where: string): void {
  if (haystack.includes(needle)) {
    throw new Error(`${where}: forbidden value "${needle}" leaked into: ${haystack}`);
  }
}

// ---- ports ----------------------------------------------------------------

function fakeRpc(
  result: { data: unknown; error: RpcError | null },
  calls: Array<{ fn: string; args: Record<string, unknown> }>,
): RpcPort {
  return (fn, args) => {
    calls.push({ fn, args });
    return Promise.resolve(result);
  };
}

function fakeVerifier(verified: boolean): RegistrationVerifier {
  return () =>
    Promise.resolve(
      verified
        ? {
            verified: true,
            credential: {
              id: 'verified-cred-id',
              publicKey: new Uint8Array([1, 2, 3, 4]),
              aaguid: null,
              counter: 0,
            },
          }
        : { verified: false, credential: null },
    );
}

/**
 * Track every port call (RPC + non-RPC) so we can assert what was reached
 * BEFORE the throttle decision. F-175's central claim: when the throttle
 * denies, NOTHING DB-touching is called.
 */
interface CallLog {
  rpc: Array<{ fn: string; args: Record<string, unknown> }>;
  issueChallenge: number;
  consumeChallenge: number;
  verify: number;
  mintToken: number;
  throttle: Array<'challenge' | 'register'>;
}

function makeCalls(): CallLog {
  return { rpc: [], issueChallenge: 0, consumeChallenge: 0, verify: 0, mintToken: 0, throttle: [] };
}

function depsFor(
  throttleDecision: (action: 'challenge' | 'register') => ThrottleDecision,
  calls: CallLog,
  rpcResult: { data: unknown; error: RpcError | null } = { data: { user_id: 'invitee-uid' }, error: null },
): RedeemDeps {
  return {
    rpc: fakeRpc(rpcResult, calls.rpc),
    assertKeyParity: () => Promise.resolve(),
    originAllowed: () => true,
    verifyRegistration: ((_in, _ctx) => {
      calls.verify += 1;
      return fakeVerifier(true)(_in, _ctx);
    }) as RegistrationVerifier,
    mintWriterToken: () => {
      calls.mintToken += 1;
      return Promise.resolve('mint-writer-token');
    },
    issueChallenge: () => {
      calls.issueChallenge += 1;
      return Promise.resolve({ ok: true, challenge: 'chal-1' });
    },
    consumeChallenge: () => {
      calls.consumeChallenge += 1;
      return Promise.resolve({ rp_id: 'example.com', origin: 'https://example.com' });
    },
    throttle: (action) => {
      calls.throttle.push(action);
      return throttleDecision(action);
    },
  };
}

const VALID_REGISTER = {
  action: 'register',
  invite_id: '11111111-1111-1111-1111-111111111111',
  totp_code: '424242',
  challenge: 'chal-1',
  credentialId: 'body-cred-id',
  attestationObject: 'att-obj',
  clientDataJSON: 'client-data',
  transports: ['internal'],
  rpId: 'example.com',
  origin: 'https://example.com',
  deviceLabel: 'my device',
} as const;

// ---------------------------------------------------------------------------
// F-175 (register) — throttled call returns 429 rate_limited, never reaches RPC.
// ---------------------------------------------------------------------------
Deno.test('F-175: a throttled register short-circuits to 429 rate_limited and NEVER calls the RPC', async () => {
  const calls = makeCalls();
  const deps = depsFor(() => ({ allowed: false }), calls);
  const res = await dispatch(deps, { ...VALID_REGISTER });

  assert(!res.ok, 'a throttled register must NOT be ok');
  assertEquals(res.status, 429);
  assertEquals(res.body, { error: 'rate_limited' });

  // The central claim: NOTHING DB-touching ran.
  assertEquals(calls.rpc.length, 0, 'F-175: a throttled register MUST NOT call the RPC');
  assertEquals(calls.consumeChallenge, 0, 'F-175: a throttled register MUST NOT consume the challenge');
  assertEquals(calls.verify, 0, 'F-175: a throttled register MUST NOT verify the attestation');
  // The throttle WAS consulted (exactly once) for the register action.
  assertEquals(calls.throttle, ['register']);
});

// ---------------------------------------------------------------------------
// F-175 (challenge) — throttled call returns 429 rate_limited, never issues.
// ---------------------------------------------------------------------------
Deno.test('F-175: a throttled challenge short-circuits to 429 rate_limited and NEVER issues a challenge', async () => {
  const calls = makeCalls();
  const deps = depsFor(() => ({ allowed: false }), calls);
  const res = await dispatch(deps, {
    action: 'challenge',
    invite_id: VALID_REGISTER.invite_id,
    rpId: 'example.com',
    origin: 'https://example.com',
  });
  assert(!res.ok, 'a throttled challenge must NOT be ok');
  assertEquals(res.status, 429);
  assertEquals(res.body, { error: 'rate_limited' });
  assertEquals(calls.issueChallenge, 0, 'F-175: a throttled challenge MUST NOT issue');
  assertEquals(calls.throttle, ['challenge']);
});

// ---------------------------------------------------------------------------
// F-175 — the throttle decision is INDEPENDENT of the RPC outcome.
//
// A throttled register that would otherwise have hit (for example) an expired
// invite still returns 429 — the throttle fires first, the RPC is never even
// consulted, so the SQL outcome literal can't leak past the throttle.
// ---------------------------------------------------------------------------
Deno.test('F-175: throttling pre-empts the SQL outcome — a throttled register never returns the normalized invalid error', async () => {
  const calls = makeCalls();
  const deps = depsFor(
    () => ({ allowed: false }),
    calls,
    { data: null, error: { code: 'P0001', message: 'invite_invalid' } },
  );
  const res = await dispatch(deps, { ...VALID_REGISTER });

  assertEquals(res.status, 429);
  assertEquals((res.body as { error: string }).error, 'rate_limited');
  // It is NOT the redeem_invalid (the SQL-condition normalized error).
  assert(
    (res.body as { error: string }).error !== 'redeem_invalid',
    'F-175: the throttle outcome must precede the SQL outcome',
  );
  assertEquals(calls.rpc.length, 0);
});

// ---------------------------------------------------------------------------
// F-176 — the 429 response body and the throttle log line carry no PI / code /
// credential secret / IP value. (The IP itself is the keyspace seed only; only
// the closed-literal `rate_limit_key_class` label rides the structured log.)
// ---------------------------------------------------------------------------
Deno.test('F-176: a throttled response leaks no code, TOTP, credential secret, or IP', async () => {
  const captured: LogLine[] = [];
  log.__setTestSink((line) => captured.push(line));
  try {
    const calls = makeCalls();
    const deps = depsFor(() => ({ allowed: false }), calls);
    const res = await dispatch(deps, { ...VALID_REGISTER });
    assertEquals(res.status, 429);

    const bodyBlob = JSON.stringify(res.body);
    assertStringAbsent(bodyBlob, '424242', 'F-176 (code/TOTP in 429 body)');
    assertStringAbsent(bodyBlob, 'att-obj', 'F-176 (attestation in 429 body)');
    assertStringAbsent(bodyBlob, 'client-data', 'F-176 (clientDataJSON in 429 body)');
    assertStringAbsent(bodyBlob, '11111111-1111-1111-1111-111111111111', 'F-176 (invite_id in 429 body)');

    const logBlob = JSON.stringify(captured);
    assertStringAbsent(logBlob, '424242', 'F-176 (code/TOTP in throttle log)');
    assertStringAbsent(logBlob, 'att-obj', 'F-176 (attestation in throttle log)');
    assertStringAbsent(logBlob, 'client-data', 'F-176 (clientDataJSON in throttle log)');
    assertStringAbsent(logBlob, 'verified-cred-id', 'F-176 (credential id in throttle log)');
    assertStringAbsent(logBlob, 'mint-writer-token', 'F-176 (mint token in throttle log)');
  } finally {
    log.__resetTestSink();
  }
});

// ---------------------------------------------------------------------------
// F-175 — the happy path still ALLOWS the call: an `allowed:true` throttle
// proceeds and the RPC IS reached (so the throttle is not a categorical block).
// ---------------------------------------------------------------------------
Deno.test('F-175: an allowed register proceeds to the RPC as normal', async () => {
  const calls = makeCalls();
  const deps = depsFor(() => ({ allowed: true }), calls);
  const res = await dispatch(deps, { ...VALID_REGISTER });
  assert(res.ok, 'an allowed register should succeed');
  assertEquals(res.status, 200);
  assertEquals(calls.rpc.length, 1, 'the RPC must be reached on an allowed call');
  assertEquals(calls.rpc[0].fn, 'redeem_invite_complete');
});
