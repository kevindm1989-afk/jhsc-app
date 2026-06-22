/**
 * redeem-invite / core tests (Deno-native) — ADR-0029 P1-2 (KEYSTONE, EF).
 *
 * Run: `deno test --allow-read supabase/functions/redeem-invite/test/core.test.ts`
 *
 * The redeem EF is the REPEATABLE, UNAUTHENTICATED sibling of
 * bootstrap-first-co-chair (verify_jwt=false): same key-parity + origin-pin +
 * verifyWebAuthnRegistration ceremony + self-minted mint_writer token, but the
 * one-shot EXISTS(users) guard is REPLACED by an invite+TOTP gate, and
 * BOOTSTRAP_ENABLED is NOT reused. It is modelled on bootstrap's core, NOT on
 * the JWT-bound feature EFs.
 *
 * RED-FIRST: `supabase/functions/redeem-invite/core.ts` does NOT exist on `main`
 * yet (the P1-2 implementer builds it against this test). The imports below fail
 * to resolve until it lands — that is the intended red. We mirror committee-op's
 * `core.ts`-is-unit-tested / `index.ts`-is-thin split (ADR-0029 references it):
 * the testable heart takes injected ports (an RpcPort + a WebAuthn verifier port
 * + a token-minter), so the dispatch/error-mapping/leak invariants are pure-unit.
 *
 * Findings covered (threat-model §3.18):
 *   F-168 — bad origin rejected BEFORE any DB call; key-parity 503 pre-dispatch;
 *           a forged attestation NEVER reaches the RPC.
 *   F-169 — the SQL's invite_invalid (consumed/expired/non-existent) surfaces as
 *           ONE byte-identical normalized client error (never distinguishes).
 *   F-170 — the TOTP failure literals (expired/locked/wrong) surface as the SAME
 *           normalized client error (no condition leak).
 *   F-171 — the register schema has NO user_id/enrolling_uid; a smuggled one is
 *           ignored and never forwarded to redeem_invite_complete.
 *   F-176 — the 6-digit code, the raw TOTP, and credential secrets NEVER appear
 *           in any log line / structured-log field / error message the EF emits.
 *   F-168 (repeatability) — the EF does NOT consult BOOTSTRAP_ENABLED and does
 *           NOT abort on an EXISTS(users)-style one-shot guard.
 */

import {
  dispatch,
  mapRedeemError,
  type RedeemDeps,
  type RedeemResult,
  type RpcPort,
  type RpcError,
  type RegistrationVerifier,
} from '../core.ts';
import { log, type LogLine } from '../../_shared/log.ts';

// ---- tiny assert helpers (mirrors committee-op/test/core.test.ts) -----------
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
    throw new Error(`${where}: forbidden secret "${needle}" leaked into: ${haystack}`);
  }
}

// ---- deterministic fakes for the injected ports -----------------------------

/** An RpcPort that returns a fixed result and records every call (fn + args). */
function fakeRpc(
  result: { data: unknown; error: RpcError | null },
  calls: Array<{ fn: string; args: Record<string, unknown> }>,
): RpcPort {
  return (fn, args) => {
    calls.push({ fn, args });
    return Promise.resolve(result);
  };
}

/** A verifier port that returns a fixed verdict + verified credential. */
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

/** Baseline deps: parity ok, origin allowed, challenge issues + consumes,
 *  attestation verifies, RPC succeeds. Individual tests override one seam. */
function baseDeps(
  overrides: Partial<RedeemDeps> = {},
  calls: Array<{ fn: string; args: Record<string, unknown> }> = [],
): RedeemDeps {
  const rpc = fakeRpc({ data: { user_id: 'invitee-uid' }, error: null }, calls);
  return {
    rpc,
    assertKeyParity: () => Promise.resolve(),
    originAllowed: () => true,
    verifyRegistration: fakeVerifier(true),
    mintWriterToken: () => Promise.resolve('mint-writer-token'),
    issueChallenge: () => Promise.resolve({ ok: true, challenge: 'chal-1' }),
    consumeChallenge: () => Promise.resolve({ rp_id: 'example.com', origin: 'https://example.com' }),
    ...overrides,
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

// ===========================================================================
// Dispatch + the standard contract.
// ===========================================================================

Deno.test('challenge action issues a challenge and never touches the redeem RPC (F-175)', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const res = await dispatch(baseDeps({}, calls), {
    action: 'challenge',
    invite_id: VALID_REGISTER.invite_id,
    rpId: 'example.com',
    origin: 'https://example.com',
  });
  assert(res.ok, 'challenge should succeed');
  assertEquals(res.status, 200);
  // F-175: the cheap challenge path does NO code/TOTP work and never reaches
  // redeem_invite_complete (no lock-state mutation possible code-lessly).
  assert(
    !calls.some((c) => c.fn === 'redeem_invite_complete'),
    'challenge must NOT call redeem_invite_complete',
  );
});

Deno.test('register happy path forwards verified fields to redeem_invite_complete and returns {user_id}', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const res = await dispatch(baseDeps({}, calls), { ...VALID_REGISTER });
  assert(res.ok, 'register should succeed');
  assertEquals(res.status, 200);
  assertEquals(res.body, { ok: true, user_id: 'invitee-uid' });
  const rpcCall = calls.find((c) => c.fn === 'redeem_invite_complete');
  assert(rpcCall, 'register must call redeem_invite_complete');
  // Only the VERIFIED credential id reaches the RPC, never the body-supplied one.
  assertEquals(rpcCall!.args.p_credential_id, 'verified-cred-id');
  assertEquals(rpcCall!.args.p_invite_id, VALID_REGISTER.invite_id);
});

Deno.test('an unknown action is a bad_request', async () => {
  const res = await dispatch(baseDeps(), { action: 'frobnicate', invite_id: 'x' });
  assert(!res.ok);
  assertEquals(res.status, 400);
  assertEquals((res.body as { error: string }).error, 'bad_request');
});

Deno.test('a missing required register field is a bad_request', async () => {
  const { totp_code: _omit, ...noCode } = VALID_REGISTER;
  const res = await dispatch(baseDeps(), { ...noCode });
  assert(!res.ok);
  assertEquals(res.status, 400);
  assertEquals((res.body as { error: string }).error, 'bad_request');
});

// ===========================================================================
// F-168 — origin pin + key parity + verified-attestation gate.
// ===========================================================================

Deno.test('F-168: a bad origin is rejected BEFORE any DB call', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const res = await dispatch(
    baseDeps({ originAllowed: () => false }, calls),
    { ...VALID_REGISTER, origin: 'https://evil.example' },
  );
  assert(!res.ok);
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0, 'no RPC/challenge call may run on a rejected origin');
});

Deno.test('F-168: a key-parity failure 503s before dispatch (no RPC call)', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const res = await dispatch(
    baseDeps(
      { assertKeyParity: () => Promise.reject(new Error('KEY_PARITY_MISMATCH')) },
      calls,
    ),
    { ...VALID_REGISTER },
  );
  assert(!res.ok);
  assertEquals(res.status, 503);
  assertEquals(calls.length, 0, 'no DB call after a parity failure');
});

Deno.test('F-168: a forged attestation is rejected and NEVER reaches redeem_invite_complete', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const res = await dispatch(
    baseDeps({ verifyRegistration: fakeVerifier(false) }, calls),
    { ...VALID_REGISTER },
  );
  assert(!res.ok);
  assertEquals(res.status, 401);
  assert(
    !calls.some((c) => c.fn === 'redeem_invite_complete'),
    'a forged attestation must NOT call redeem_invite_complete',
  );
});

// ===========================================================================
// F-169 / F-170 — NORMALIZED error oracle. Every invite/TOTP failure literal
// the SQL raises must surface as ONE byte-identical client {error}. The client
// must NOT be able to distinguish consumed vs expired vs invalid vs wrong-code.
// ===========================================================================

Deno.test('F-169/F-170: all invite + TOTP failure literals map to ONE normalized client error', () => {
  const sqlLiterals = [
    'invite_invalid',          // consumed / expired / non-existent (F-169)
    'TOTP_BOOTSTRAP_EXPIRED',  // F-170 window
    'TOTP_BOOTSTRAP_LOCKED',   // F-170 lock
    'TOTP_BOOTSTRAP_WRONG_CODE',
    'TOTP_BOOTSTRAP_CONSUMED',
    'TOTP_BOOTSTRAP_NOT_FOUND',
  ];
  const mapped = sqlLiterals.map((m) => mapRedeemError({ code: 'P0001', message: m }));
  // All must be byte-identical {error,status}.
  const first = JSON.stringify(mapped[0]);
  for (let i = 1; i < mapped.length; i++) {
    assertEquals(
      JSON.stringify(mapped[i]),
      first,
      `F-169/F-170: "${sqlLiterals[i]}" must map identically to "${sqlLiterals[0]}"`,
    );
  }
  // And the normalized literal must NOT echo the underlying condition.
  for (const m of sqlLiterals) {
    const out = mapRedeemError({ code: 'P0001', message: m });
    assert(
      out.error !== 'TOTP_BOOTSTRAP_EXPIRED' &&
        out.error !== 'TOTP_BOOTSTRAP_LOCKED' &&
        out.error !== 'TOTP_BOOTSTRAP_WRONG_CODE',
      `F-170: the normalized error must not echo the raw TOTP condition (got ${out.error})`,
    );
  }
});

Deno.test('F-169: consumed, expired, and non-existent invite produce byte-identical register responses', async () => {
  const bodies: string[] = [];
  for (const literal of ['invite_invalid', 'invite_invalid', 'invite_invalid']) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const res = await dispatch(
      baseDeps(
        { rpc: fakeRpc({ data: null, error: { code: 'P0001', message: literal } }, calls) },
        calls,
      ),
      { ...VALID_REGISTER },
    );
    bodies.push(JSON.stringify({ status: res.status, body: res.body }));
  }
  assertEquals(bodies[0], bodies[1], 'F-169: response bodies must be byte-identical');
  assertEquals(bodies[1], bodies[2], 'F-169: response bodies must be byte-identical');
});

// ===========================================================================
// F-171 — retargeting closed at the EF schema: NO caller-controlled uid.
// ===========================================================================

Deno.test('F-171: a smuggled user_id/enrolling_uid is ignored and never forwarded to the RPC', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const res = await dispatch(baseDeps({}, calls), {
    ...VALID_REGISTER,
    // attacker smuggles a target uid through the body:
    user_id: '00000000-0000-0000-0000-0000000000f1',
    enrolling_uid: '00000000-0000-0000-0000-0000000000f1',
  });
  assert(res.ok, 'the redeem still proceeds (the smuggled field is simply ignored)');
  const rpcCall = calls.find((c) => c.fn === 'redeem_invite_complete')!;
  // The RPC arg set must NOT carry any caller-supplied target uid.
  assert(
    !('p_user_id' in rpcCall.args) &&
      !('p_enrolling_uid' in rpcCall.args) &&
      !('p_target_user_id' in rpcCall.args),
    'F-171: no caller-supplied uid may be forwarded to redeem_invite_complete',
  );
  // And the smuggled value must appear nowhere in the forwarded args.
  assertStringAbsent(
    JSON.stringify(rpcCall.args),
    '00000000-0000-0000-0000-0000000000f1',
    'F-171: smuggled uid in forwarded RPC args',
  );
});

// ===========================================================================
// F-168 (repeatability) — NOT one-shot. The EF must not consult BOOTSTRAP_ENABLED
// nor abort on an EXISTS(users)-style guard: a second, distinct redeem succeeds.
// ===========================================================================

Deno.test('F-168: the EF is repeatable — two distinct redeems both succeed (not one-shot)', async () => {
  // First redeem (invitee A).
  const callsA: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const resA = await dispatch(
    baseDeps({ rpc: fakeRpc({ data: { user_id: 'A' }, error: null }, callsA) }, callsA),
    { ...VALID_REGISTER, invite_id: '11111111-1111-1111-1111-111111111111' },
  );
  // Second redeem (invitee B) — a DIFFERENT invite. Must not be categorically
  // blocked the way bootstrap's EXISTS(users) one-shot guard blocks the 2nd.
  const callsB: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const resB = await dispatch(
    baseDeps({ rpc: fakeRpc({ data: { user_id: 'B' }, error: null }, callsB) }, callsB),
    { ...VALID_REGISTER, invite_id: '22222222-2222-2222-2222-222222222222' },
  );
  assert(resA.ok && resB.ok, 'both distinct redeems must succeed (repeatable, not one-shot)');
  assertEquals((resA.body as { user_id: string }).user_id, 'A');
  assertEquals((resB.body as { user_id: string }).user_id, 'B');
});

Deno.test('F-168: the redeem core never reads a BOOTSTRAP_ENABLED-style one-shot gate', async () => {
  // If the core consulted a BOOTSTRAP_ENABLED env flag (default-deny), this
  // dispatch with no such flag set would 403 like bootstrap does. It must NOT.
  const res = await dispatch(baseDeps(), { ...VALID_REGISTER });
  assert(res.ok, 'redeem must not be gated by a BOOTSTRAP_ENABLED-style flag');
  assert(res.status !== 403, 'a 403 here would mean a bootstrap-style one-shot gate leaked in');
});

// ===========================================================================
// F-176 — the code, the raw TOTP, and credential secrets NEVER reach any log
// line the EF emits. Capture the shared log sink and sweep every line.
// ===========================================================================

Deno.test('F-176: no log line emitted by the redeem core contains the code, the TOTP, or credential secrets', async () => {
  const captured: LogLine[] = [];
  log.__setTestSink((line) => captured.push(line));
  try {
    // Run the happy path AND each failure branch so every log site fires.
    await dispatch(baseDeps(), { ...VALID_REGISTER });
    await dispatch(
      baseDeps({ rpc: fakeRpc({ data: null, error: { code: 'P0001', message: 'invite_invalid' } }, []) }),
      { ...VALID_REGISTER },
    );
    await dispatch(
      baseDeps({ rpc: fakeRpc({ data: null, error: { code: 'P0001', message: 'TOTP_BOOTSTRAP_WRONG_CODE' } }, []) }),
      { ...VALID_REGISTER },
    );
    await dispatch(baseDeps({ verifyRegistration: fakeVerifier(false) }), { ...VALID_REGISTER });
    await dispatch(baseDeps({ originAllowed: () => false }), { ...VALID_REGISTER });

    const blob = JSON.stringify(captured);
    // The 6-digit code / raw TOTP (same value here) must be absent.
    assertStringAbsent(blob, '424242', 'F-176 (code/TOTP in log)');
    // The attestation + clientDataJSON secrets must be absent.
    assertStringAbsent(blob, 'att-obj', 'F-176 (attestationObject in log)');
    assertStringAbsent(blob, 'client-data', 'F-176 (clientDataJSON in log)');
    // The mint_writer token must be absent.
    assertStringAbsent(blob, 'mint-writer-token', 'F-176 (mint_writer token in log)');
    // At least one line WAS emitted (we are actually exercising the log path).
    assert(captured.length > 0, 'expected the redeem core to emit at least one log line');
  } finally {
    log.__resetTestSink();
  }
});

Deno.test('F-176: a normalized client error body never echoes the raw code or TOTP', async () => {
  const res = await dispatch(
    baseDeps({ rpc: fakeRpc({ data: null, error: { code: 'P0001', message: 'TOTP_BOOTSTRAP_WRONG_CODE' } }, []) }),
    { ...VALID_REGISTER },
  );
  const blob = JSON.stringify(res.body);
  assertStringAbsent(blob, '424242', 'F-176 (code/TOTP in error body)');
  assertStringAbsent(blob, 'TOTP_BOOTSTRAP_WRONG_CODE', 'F-176 (raw TOTP condition in error body)');
});
