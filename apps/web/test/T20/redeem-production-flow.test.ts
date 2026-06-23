/**
 * ADR-0029 P1-7 — redeem production flow / EF wire contract.
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. Mirrors
 * sign-in-flow.test.ts's hermetic-with-stubs orchestration posture: a
 * recording transport captures every POST body, and the test asserts the
 * two-action ceremony fires in the right order with the right wire shape, and
 * that the secret never leaks through the flow.
 *
 * WHY a `redeemViaProduction` orchestrator: /sign-in factors its ceremony into
 * `signInViaMintSession` (PR #52) over a `SupabaseMintSessionClient`. /bootstrap
 * inlines the same ceremony in the route. ADR-0029 Decision 6 says /redeem
 * "reuses the WebAuthn registration helper pattern" — so the redeem ceremony
 * SHOULD factor the same way the sign-in ceremony did, into a unit-testable
 * orchestrator that the route + RedeemCard call. This file pins that orchestrator.
 * (If the implementer instead inlines the ceremony in RedeemCard, the SAME wire
 * contract is still pinned behaviorally in redeem-card.test.ts; this file pins
 * the extracted-flow contract that ADR-0029 Decision 6 calls for. See the
 * test-writer report's "contract ambiguity" note.)
 *
 * The wire contract is the DURABLE part (supabase/functions/redeem-invite/core.ts):
 *   - POST to ${baseUrl}/functions/v1/redeem-invite
 *   - challenge body: { action:'challenge', rpId, origin }  (no code, no invite_id)
 *   - register body:  { action:'register', invite_id, totp_code, challenge,
 *     credentialId, attestationObject, clientDataJSON, transports, deviceLabel,
 *     rpId, origin }
 *   - register → {ok:true,user_id}/200 | redeem_invalid/422 | rate_limited/429
 *     | redeem_failed/500 | registration_invalid/401 | bad_request/400
 *   - the 6-digit code rides ONLY the register body (F-170/F-176).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

// RED-FIRST import — the implementer creates the redeem production flow.
// The expected shape mirrors signInViaMintSession: an async orchestrator that
// takes a transport (or client), rpId/origin, the invite_id, the member's
// totp_code, a `create`-style ceremony callback, and returns a discriminated
// result union ({status:'ok',user_id} | {status:'redeem_invalid'} |
// {status:'rate_limited'} | {status:'cancelled'} | {status:'system_error'}).
import { redeemViaProduction } from '../../src/lib/redeem/redeem-flow';

const INVITE_ID = '7b1d3f00-0000-4000-8000-0000000000aa';
const SERVER_CHALLENGE = 'srv-redeem-challenge-xyz';
const NEW_USER_ID = '9c2e8a11-1111-4111-8111-111111111111';
const SECRET_CODE = '482913';

interface QueuedResponse {
  status: number;
  body: unknown;
}

function recordingTransport(responses: QueuedResponse[]) {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  let i = 0;
  const transport = async (body: Record<string, unknown>) => {
    calls.push({ body });
    const r = responses[i++];
    if (!r) throw new Error(`no redeem response queued for call #${i}`);
    return { status: r.status, body: r.body };
  };
  return { transport, calls };
}

/** A canned verified-credential the ceremony callback returns (no real authenticator). */
const VERIFIED_CREDENTIAL = {
  credentialId: 'cred-redeem-1',
  attestationObject: 'b64-attestation',
  clientDataJSON: 'b64-clientdata',
  transports: ['internal'] as string[]
};

const CHALLENGE_OK: QueuedResponse = { status: 200, body: { ok: true, challenge: SERVER_CHALLENGE } };

function baseOpts(overrides: Partial<Parameters<typeof redeemViaProduction>[0]> = {}) {
  return {
    rpId: 'jhsc.example',
    origin: 'https://jhsc.example',
    inviteId: INVITE_ID,
    totpCode: SECRET_CODE,
    deviceLabel: 'member-redeem',
    runCeremony: vi.fn(async (challenge: string) => {
      expect(challenge).toBe(SERVER_CHALLENGE);
      return VERIFIED_CREDENTIAL;
    }),
    ...overrides
  };
}

beforeEach(() => {
  freezeClock();
  __resetCapture();
  __setTestSink();
});

afterEach(() => {
  __resetCapture();
  vi.restoreAllMocks();
  restoreClock();
});

describe('P1-7 [happy] redeemViaProduction — challenge → ceremony → register', () => {
  it('orchestrates challenge → runCeremony → register and returns {status:ok,user_id}', async () => {
    const { transport, calls } = recordingTransport([
      CHALLENGE_OK,
      { status: 200, body: { ok: true, user_id: NEW_USER_ID } }
    ]);
    const opts = baseOpts();
    const r = await redeemViaProduction({ ...opts, transport: transport as never });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.user_id).toBe(NEW_USER_ID);

    expect(calls).toHaveLength(2);
    // F-170: the challenge body carries NEITHER the code NOR the invite_id.
    expect(calls[0]!.body).toEqual({
      action: 'challenge',
      rpId: 'jhsc.example',
      origin: 'https://jhsc.example'
    });
    // The register body carries the full verified set + invite_id + the code.
    expect(calls[1]!.body).toEqual({
      action: 'register',
      invite_id: INVITE_ID,
      totp_code: SECRET_CODE,
      challenge: SERVER_CHALLENGE,
      credentialId: 'cred-redeem-1',
      attestationObject: 'b64-attestation',
      clientDataJSON: 'b64-clientdata',
      transports: ['internal'],
      deviceLabel: 'member-redeem',
      rpId: 'jhsc.example',
      origin: 'https://jhsc.example'
    });
    expect(opts.runCeremony).toHaveBeenCalledTimes(1);
  });

  it('the ceremony is NEVER invoked when the challenge call fails (no point prompting the device)', async () => {
    const { transport, calls } = recordingTransport([
      { status: 503, body: { error: 'service_unavailable' } }
    ]);
    const opts = baseOpts();
    const r = await redeemViaProduction({ ...opts, transport: transport as never });
    expect(r.status).toBe('system_error');
    expect(opts.runCeremony).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1); // only the challenge call
  });
});

describe('P1-7 [error] redeemViaProduction — register response mapping', () => {
  it('422 redeem_invalid maps to status=redeem_invalid (the ONE normalized failure)', async () => {
    const { transport } = recordingTransport([
      CHALLENGE_OK,
      { status: 422, body: { error: 'redeem_invalid' } }
    ]);
    const r = await redeemViaProduction({ ...baseOpts(), transport: transport as never });
    expect(r.status).toBe('redeem_invalid');
  });

  it('429 rate_limited maps to status=rate_limited', async () => {
    const { transport } = recordingTransport([
      CHALLENGE_OK,
      { status: 429, body: { error: 'rate_limited' } }
    ]);
    const r = await redeemViaProduction({ ...baseOpts(), transport: transport as never });
    expect(r.status).toBe('rate_limited');
  });

  for (const c of [
    { status: 401, enum: 'registration_invalid' },
    { status: 500, enum: 'redeem_failed' },
    { status: 400, enum: 'bad_request' }
  ]) {
    it(`${c.status} ${c.enum} maps to status=system_error (generic, no raw enum surfaced)`, async () => {
      const { transport } = recordingTransport([CHALLENGE_OK, { status: c.status, body: { error: c.enum } }]);
      const r = await redeemViaProduction({ ...baseOpts(), transport: transport as never });
      expect(r.status).toBe('system_error');
      // The discriminated result must NOT carry the raw EF enum (F-176).
      expect(JSON.stringify(r)).not.toContain(c.enum);
    });
  }

  it('a transport throw (network) maps to status=system_error', async () => {
    const transport = async () => {
      throw new Error('network down');
    };
    const r = await redeemViaProduction({ ...baseOpts(), transport: transport as never });
    expect(r.status).toBe('system_error');
  });
});

describe('P1-7 [edge] redeemViaProduction — cancellation', () => {
  it('runCeremony returning null maps to status=cancelled; register is NOT called', async () => {
    const { transport, calls } = recordingTransport([CHALLENGE_OK]);
    const opts = baseOpts({ runCeremony: vi.fn(async () => null) });
    const r = await redeemViaProduction({ ...opts, transport: transport as never });
    expect(r.status).toBe('cancelled');
    expect(calls).toHaveLength(1); // challenge only; register skipped
  });

  it('runCeremony throwing (NotAllowedError) maps to status=cancelled', async () => {
    const { transport } = recordingTransport([CHALLENGE_OK]);
    const opts = baseOpts({
      runCeremony: vi.fn(async () => {
        const e = new Error('cancel');
        e.name = 'NotAllowedError';
        throw e;
      })
    });
    const r = await redeemViaProduction({ ...opts, transport: transport as never });
    expect(r.status).toBe('cancelled');
  });
});

describe('P1-7 [security/privacy] redeemViaProduction — F-176 leak sweep', () => {
  it('the 6-digit code never lands in console.* / the structured log / the returned result on the happy path', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.map(String).join(' ')));

    const { transport } = recordingTransport([
      CHALLENGE_OK,
      { status: 200, body: { ok: true, user_id: NEW_USER_ID } }
    ]);
    const r = await redeemViaProduction({ ...baseOpts(), transport: transport as never });

    const haystacks = [
      ...logs,
      ...__getCapturedLines().map((l) => JSON.stringify(l)),
      JSON.stringify(r)
    ];
    for (const h of haystacks) {
      expect(h).not.toContain(SECRET_CODE);
    }
  });

  it('the 6-digit code never lands in any log surface on the redeem_invalid branch (F-176)', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.map(String).join(' ')));

    const { transport } = recordingTransport([
      CHALLENGE_OK,
      { status: 422, body: { error: 'redeem_invalid' } }
    ]);
    const r = await redeemViaProduction({ ...baseOpts(), transport: transport as never });
    expect(r.status).toBe('redeem_invalid');

    const haystacks = [
      ...logs,
      ...__getCapturedLines().map((l) => JSON.stringify(l)),
      JSON.stringify(r)
    ];
    for (const h of haystacks) {
      expect(h).not.toContain(SECRET_CODE);
    }
  });

  it('the returned user_id never lands in a log surface (operator-only, F-176)', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.map(String).join(' ')));

    const { transport } = recordingTransport([
      CHALLENGE_OK,
      { status: 200, body: { ok: true, user_id: NEW_USER_ID } }
    ]);
    await redeemViaProduction({ ...baseOpts(), transport: transport as never });

    const haystacks = [...logs, ...__getCapturedLines().map((l) => JSON.stringify(l))];
    for (const h of haystacks) {
      expect(h).not.toContain(NEW_USER_ID);
    }
  });
});
