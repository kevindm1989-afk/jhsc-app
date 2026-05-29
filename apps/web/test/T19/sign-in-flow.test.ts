/**
 * T19.1 — signInViaMintSession orchestration unit tests.
 *
 * Mirrors the t07 production-flows.test.ts hermetic-with-stubs posture.
 * The orchestrator's five-step sequence is observable via the return
 * union; each test asserts:
 *   - the right transport calls fire in the right order, with the right args
 *   - setJwt is called only on the success path
 *   - failed / cancelled paths return the right discriminant
 */

import { describe, expect, it, vi } from 'vitest';
import { signInViaMintSession, type SignedAssertion } from '../../src/lib/auth/sign-in-flow';
import {
  SupabaseMintSessionClient,
  type MintSessionTransport
} from '../../src/lib/auth/supabase-mint-session-client';

interface QueuedResponse {
  status: number;
  body: unknown;
}

function recordingClient(responses: QueuedResponse[]) {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  let i = 0;
  const transport: MintSessionTransport = async (body) => {
    calls.push({ body });
    const r = responses[i++];
    if (!r) throw new Error('no response queued');
    return { status: r.status, body: r.body };
  };
  return { client: new SupabaseMintSessionClient({ transport }), calls };
}

const VALID_ASSERTION: SignedAssertion = {
  credentialId: 'cred-1',
  clientDataJSON: 'b64-client',
  authenticatorData: 'b64-auth',
  signature: 'b64-sig'
};

const HAPPY_PATH_RESPONSES: QueuedResponse[] = [
  { status: 200, body: { ok: true, challenge: 'srv-nonce-xyz' } },
  {
    status: 200,
    body: {
      ok: true,
      access_token: 'eyJ.fresh.jwt',
      token_type: 'bearer',
      expires_at: '2026-05-29T22:30:00.000Z',
      session_id: 'sess-42'
    }
  }
];

describe('T19.1 — signInViaMintSession happy path', () => {
  it('orchestrates challenge → getAssertion → assert → setJwt and returns status=ok', async () => {
    const { client, calls } = recordingClient(HAPPY_PATH_RESPONSES);
    const setJwt = vi.fn();
    const getAssertion = vi.fn(async (challenge: string) => {
      expect(challenge).toBe('srv-nonce-xyz');
      return VALID_ASSERTION;
    });

    const r = await signInViaMintSession({
      client,
      rpId: 'jhsc.example',
      origin: 'https://jhsc.example',
      getAssertion,
      setJwt
    });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.access_token).toBe('eyJ.fresh.jwt');
    expect(r.session_id).toBe('sess-42');
    expect(r.expires_at).toBe('2026-05-29T22:30:00.000Z');

    // Two transport calls in the right order with the right args.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toEqual({
      action: 'challenge',
      rp_id: 'jhsc.example',
      origin: 'https://jhsc.example'
    });
    expect(calls[1]?.body).toEqual({
      action: 'assert',
      credentialId: 'cred-1',
      clientDataJSON: 'b64-client',
      authenticatorData: 'b64-auth',
      signature: 'b64-sig',
      origin: 'https://jhsc.example',
      challenge: 'srv-nonce-xyz'
    });

    // setJwt is called exactly once, with the freshly-minted token.
    expect(setJwt).toHaveBeenCalledTimes(1);
    expect(setJwt).toHaveBeenCalledWith('eyJ.fresh.jwt');

    // getAssertion was called exactly once, with the server-minted challenge.
    expect(getAssertion).toHaveBeenCalledTimes(1);
  });

  it('accepts a synchronous getAssertion (Promise.resolve unwrapping is transparent)', async () => {
    const { client } = recordingClient(HAPPY_PATH_RESPONSES);
    const setJwt = vi.fn();
    const r = await signInViaMintSession({
      client,
      rpId: 'jhsc.example',
      origin: 'https://jhsc.example',
      getAssertion: () => VALID_ASSERTION, // sync return — not a promise
      setJwt
    });
    expect(r.status).toBe('ok');
    expect(setJwt).toHaveBeenCalledTimes(1);
  });
});

describe('T19.1 — signInViaMintSession cancellation path', () => {
  it('returns status=cancelled when getAssertion returns null (user dismissed the platform prompt)', async () => {
    // Only the challenge call should fire — assertCredential is skipped.
    const { client, calls } = recordingClient([
      { status: 200, body: { ok: true, challenge: 'srv-nonce' } }
    ]);
    const setJwt = vi.fn();
    const r = await signInViaMintSession({
      client,
      rpId: 'jhsc.example',
      origin: 'https://jhsc.example',
      getAssertion: async () => null,
      setJwt
    });
    expect(r.status).toBe('cancelled');
    expect(calls).toHaveLength(1); // only the challenge call
    expect(setJwt).not.toHaveBeenCalled();
  });

  it('returns status=cancelled when getAssertion throws (typical WebAuthn NotAllowedError)', async () => {
    const { client, calls } = recordingClient([
      { status: 200, body: { ok: true, challenge: 'srv-nonce' } }
    ]);
    const setJwt = vi.fn();
    const r = await signInViaMintSession({
      client,
      rpId: 'jhsc.example',
      origin: 'https://jhsc.example',
      getAssertion: async () => {
        throw new Error('NotAllowedError');
      },
      setJwt
    });
    expect(r.status).toBe('cancelled');
    expect(calls).toHaveLength(1);
    expect(setJwt).not.toHaveBeenCalled();
  });
});

describe('T19.1 — signInViaMintSession failure paths', () => {
  it('returns status=failed/mint_failed when requestChallenge errors (server side)', async () => {
    const { client, calls } = recordingClient([
      { status: 500, body: { ok: false, error: 'mint_failed' } }
    ]);
    const setJwt = vi.fn();
    const getAssertion = vi.fn();
    const r = await signInViaMintSession({
      client,
      rpId: 'jhsc.example',
      origin: 'https://jhsc.example',
      getAssertion,
      setJwt
    });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('mint_failed');
    expect(r.http).toBe(500);
    // Crucially: the WebAuthn ceremony was NEVER prompted (no point in
    // asking the user to sign if we couldn't even mint a challenge).
    expect(getAssertion).not.toHaveBeenCalled();
    expect(setJwt).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('returns status=failed/assertion_invalid when assertCredential rejects the signature', async () => {
    const { client, calls } = recordingClient([
      { status: 200, body: { ok: true, challenge: 'srv-nonce' } },
      { status: 401, body: { ok: false, error: 'assertion_invalid' } }
    ]);
    const setJwt = vi.fn();
    const r = await signInViaMintSession({
      client,
      rpId: 'jhsc.example',
      origin: 'https://jhsc.example',
      getAssertion: async () => VALID_ASSERTION,
      setJwt
    });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('assertion_invalid');
    expect(r.http).toBe(401);
    expect(calls).toHaveLength(2); // challenge + assert
    // The JWT store is NOT populated — a failed sign-in must never poison it.
    expect(setJwt).not.toHaveBeenCalled();
  });

  it('returns status=failed/unknown_credential when the server cannot resolve the credential to a uid', async () => {
    const { client } = recordingClient([
      { status: 200, body: { ok: true, challenge: 'srv-nonce' } },
      { status: 401, body: { ok: false, error: 'unknown_credential' } }
    ]);
    const setJwt = vi.fn();
    const r = await signInViaMintSession({
      client,
      rpId: 'jhsc.example',
      origin: 'https://jhsc.example',
      getAssertion: async () => VALID_ASSERTION,
      setJwt
    });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('unknown_credential');
    expect(setJwt).not.toHaveBeenCalled();
  });

  it('returns status=failed/bad_request on 400 (client supplied malformed input)', async () => {
    const { client } = recordingClient([
      { status: 200, body: { ok: true, challenge: 'srv-nonce' } },
      { status: 400, body: { ok: false, error: 'bad_request' } }
    ]);
    const setJwt = vi.fn();
    const r = await signInViaMintSession({
      client,
      rpId: 'jhsc.example',
      origin: 'https://jhsc.example',
      getAssertion: async () => VALID_ASSERTION,
      setJwt
    });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('bad_request');
    expect(setJwt).not.toHaveBeenCalled();
  });
});

describe('T19.1 — signInViaMintSession setJwt boundary', () => {
  it('setJwt is called exactly once, ONLY after assertCredential returns ok (no early-population)', async () => {
    const callOrder: string[] = [];
    const transport: MintSessionTransport = async (body) => {
      callOrder.push((body as { action: string }).action);
      if ((body as { action: string }).action === 'challenge') {
        return { status: 200, body: { ok: true, challenge: 'srv-nonce' } };
      }
      return {
        status: 200,
        body: {
          ok: true,
          access_token: 'tok',
          token_type: 'bearer',
          expires_at: 'iso',
          session_id: 'sess'
        }
      };
    };
    const client = new SupabaseMintSessionClient({ transport });
    const setJwt = vi.fn(() => {
      callOrder.push('setJwt');
    });
    const getAssertion = vi.fn(async () => {
      callOrder.push('getAssertion');
      return VALID_ASSERTION;
    });
    await signInViaMintSession({
      client,
      rpId: 'jhsc.example',
      origin: 'https://jhsc.example',
      getAssertion,
      setJwt
    });
    // The call sequence MUST be: challenge → getAssertion → assert → setJwt.
    expect(callOrder).toEqual(['challenge', 'getAssertion', 'assert', 'setJwt']);
    expect(setJwt).toHaveBeenCalledTimes(1);
  });
});
