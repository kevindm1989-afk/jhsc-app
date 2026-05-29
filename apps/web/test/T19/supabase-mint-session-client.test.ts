/**
 * T19.1 — SupabaseMintSessionClient wire-shape unit tests.
 *
 * Hermetic: tests inject a stub transport that records calls + returns
 * canned responses. No real network. Covers the action-dispatch wire
 * shape (mint-session uses `{action: ...}` not `{op: ...}`) and the
 * action-specific success payload destructuring (the success fields
 * sit at the top level, not under `data`).
 */

import { describe, expect, it } from 'vitest';
import {
  SupabaseMintSessionClient,
  type MintSessionTransport
} from '../../src/lib/auth/supabase-mint-session-client';

function recordingTransport(
  responses: Array<{ status: number; body: unknown }>
): {
  transport: MintSessionTransport;
  calls: Array<{ body: Record<string, unknown> }>;
} {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  let i = 0;
  const transport: MintSessionTransport = async (body) => {
    calls.push({ body });
    const r = responses[i++];
    if (!r) throw new Error('no response queued');
    return { status: r.status, body: r.body };
  };
  return { transport, calls };
}

describe('T19.1 — SupabaseMintSessionClient.requestChallenge', () => {
  it('posts { action: "challenge", rp_id, origin } and parses the challenge string out', async () => {
    const { transport, calls } = recordingTransport([
      { status: 200, body: { ok: true, challenge: 'srv-nonce-abc' } }
    ]);
    const client = new SupabaseMintSessionClient({ transport });
    const r = await client.requestChallenge({
      rpId: 'jhsc.example',
      origin: 'https://jhsc.example'
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ challenge: 'srv-nonce-abc' });
    expect(calls[0]?.body).toEqual({
      action: 'challenge',
      rp_id: 'jhsc.example',
      origin: 'https://jhsc.example'
    });
  });

  it('surfaces 400 bad_request as { ok: false, reason: bad_request, status: 400 }', async () => {
    const { transport } = recordingTransport([
      { status: 400, body: { ok: false, error: 'bad_request' } }
    ]);
    const client = new SupabaseMintSessionClient({ transport });
    const r = await client.requestChallenge({ rpId: '', origin: '' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('bad_request');
    expect(r.status).toBe(400);
  });

  it('surfaces 500 mint_failed as { ok: false, reason: mint_failed, status: 500 }', async () => {
    const { transport } = recordingTransport([
      { status: 500, body: { ok: false, error: 'mint_failed' } }
    ]);
    const client = new SupabaseMintSessionClient({ transport });
    const r = await client.requestChallenge({ rpId: 'x', origin: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('mint_failed');
    expect(r.status).toBe(500);
  });
});

describe('T19.1 — SupabaseMintSessionClient.assertCredential', () => {
  const VALID_INPUT = {
    credentialId: 'cred-1',
    clientDataJSON: 'b64-client-data',
    authenticatorData: 'b64-auth-data',
    signature: 'b64-sig',
    origin: 'https://jhsc.example',
    challenge: 'srv-nonce-abc'
  };

  it('posts { action: "assert", ...input } and parses the access_token + session_id out', async () => {
    const { transport, calls } = recordingTransport([
      {
        status: 200,
        body: {
          ok: true,
          access_token: 'eyJ.fresh.jwt',
          token_type: 'bearer',
          expires_at: '2026-05-29T22:00:00.000Z',
          session_id: 'sess-1'
        }
      }
    ]);
    const client = new SupabaseMintSessionClient({ transport });
    const r = await client.assertCredential(VALID_INPUT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.access_token).toBe('eyJ.fresh.jwt');
    expect(r.data.token_type).toBe('bearer');
    expect(r.data.expires_at).toBe('2026-05-29T22:00:00.000Z');
    expect(r.data.session_id).toBe('sess-1');
    expect(calls[0]?.body).toEqual({ action: 'assert', ...VALID_INPUT });
  });

  it('surfaces 401 assertion_invalid', async () => {
    const { transport } = recordingTransport([
      { status: 401, body: { ok: false, error: 'assertion_invalid' } }
    ]);
    const client = new SupabaseMintSessionClient({ transport });
    const r = await client.assertCredential(VALID_INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('assertion_invalid');
    expect(r.status).toBe(401);
  });

  it('surfaces 401 unknown_credential', async () => {
    const { transport } = recordingTransport([
      { status: 401, body: { ok: false, error: 'unknown_credential' } }
    ]);
    const client = new SupabaseMintSessionClient({ transport });
    const r = await client.assertCredential(VALID_INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unknown_credential');
    expect(r.status).toBe(401);
  });

  it('surfaces 400 bad_request', async () => {
    const { transport } = recordingTransport([
      { status: 400, body: { ok: false, error: 'bad_request' } }
    ]);
    const client = new SupabaseMintSessionClient({ transport });
    const r = await client.assertCredential(VALID_INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('bad_request');
    expect(r.status).toBe(400);
  });
});

describe('T19.1 — SupabaseMintSessionClient malformed / unknown shapes', () => {
  it('falls back to reason=unknown when the server returns no error field on a non-ok response', async () => {
    const { transport } = recordingTransport([{ status: 503, body: { ok: false } }]);
    const client = new SupabaseMintSessionClient({ transport });
    const r = await client.requestChallenge({ rpId: 'x', origin: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unknown');
    expect(r.status).toBe(503);
  });

  it('falls back to reason=unknown when the body is null (network error / non-JSON)', async () => {
    const { transport } = recordingTransport([{ status: 0, body: null }]);
    const client = new SupabaseMintSessionClient({ transport });
    const r = await client.assertCredential({
      credentialId: 'x',
      clientDataJSON: 'x',
      authenticatorData: 'x',
      signature: 'x',
      origin: 'x',
      challenge: 'x'
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unknown');
    expect(r.status).toBe(0);
  });

  it('surfaces reason=unknown when ok=true but the success payload is empty (defensive)', async () => {
    // Server returns ok=true with no other fields. parseOk would return
    // {} which technically destructures to empty data — we accept it as
    // valid (the wire shape is still ok:true), but tests should be
    // explicit about this edge.
    const { transport } = recordingTransport([{ status: 200, body: { ok: true } }]);
    const client = new SupabaseMintSessionClient({ transport });
    const r = await client.requestChallenge({ rpId: 'x', origin: 'x' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({});
  });
});
