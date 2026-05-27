/**
 * mint-session — Edge Function handler (ADR-0023 / threat-model §3.12).
 *
 * Runtime: Deno (Supabase Edge Function). The passkey-login mint path: it has
 * NO authenticated caller (the user has no session yet), so it is registered
 * with verify_jwt = false. Two actions:
 *
 *   POST { action: 'challenge', rp_id, origin }
 *       → mint_issue_challenge → { challenge }   (single-use, ≤120s, F-37)
 *
 *   POST { action: 'assert', credentialId, clientDataJSON, authenticatorData,
 *          signature, origin, challenge }
 *       → consume the challenge, verify the WebAuthn assertion, resolve the uid
 *         server-side, write the jti, sign a short-lived ES256 session token.
 *
 * The mint_* RPCs are EXECUTE-granted to mint_writer ONLY, so the handler
 * presents a self-minted role=mint_writer token (signed with the same isolated
 * key as the session token — F-118, no service_role). The security-critical
 * orchestration (verify → resolve uid → jti-before-token → sign) is the tested
 * core.ts; the real WebAuthn crypto + ES256 signing are wired here.
 *
 * Verified end-to-end by the live stack once the project JWKS / asymmetric
 * PostgREST trust is configured (the tracked prod key-custody follow-up); the
 * signing + counter logic is unit-tested in test/signing.test.ts +
 * test/webauthn.test.ts.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyWebAuthnAssertion } from './assertion.ts';
import { log, withFunctionName } from '../_shared/log.ts';
import { mintSessionFromAssertion, type AssertionInput, type MintDeps } from './core.ts';
import { signMintWriterToken, signSessionJwt } from './signing.ts';
import { evaluateCounter } from './webauthn.ts';

withFunctionName('mint-session');

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Decode a PostgREST bytea (`\xDEADBEEF` hex, or bare hex) to bytes. */
function decodeBytea(value: string): Uint8Array {
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

type SupabaseClient = ReturnType<typeof createClient>;

function mintWriterClient(writerToken: string): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${writerToken}`, apikey: anon } },
    auth: { persistSession: false }
  });
}

async function handleAssert(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
  requestId: string | undefined
): Promise<Response> {
  const credentialId = String(body.credentialId ?? '');
  const challenge = String(body.challenge ?? '');
  const origin = String(body.origin ?? '');
  if (
    !credentialId || !challenge || !origin ||
    !body.clientDataJSON || !body.authenticatorData || !body.signature
  ) {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  // F-37 / replay: single-use the server-issued challenge BEFORE any verification
  // work. A replayed, expired, or forged challenge returns false.
  const consumed = await supabase.rpc('mint_consume_challenge', { p_challenge: challenge });
  if (consumed.error || consumed.data !== true) {
    log.warn({ event: 'mint.assert', attributes: { route: 'assert', outcome: 'challenge_invalid' }, request_id: requestId });
    return json({ ok: false, error: 'assertion_invalid' }, 401);
  }

  // F-117 / F-119: resolve the credential (uid + key material) server-side.
  const lookup = await supabase.rpc('mint_lookup_credential', { p_credential_id: credentialId });
  const row = (Array.isArray(lookup.data) ? lookup.data[0] : lookup.data) as
    | { user_id: string; public_key: string; counter: number | string; rp_id: string }
    | undefined;
  if (lookup.error || !row) {
    log.warn({ event: 'mint.assert', attributes: { route: 'assert', outcome: 'unknown_credential' }, request_id: requestId });
    return json({ ok: false, error: 'unknown_credential' }, 401);
  }
  const storedCounter = Number(row.counter ?? 0);
  const rpId = String(row.rp_id);
  const userId = String(row.user_id);
  const publicKey = decodeBytea(String(row.public_key));

  // F-37: never trust the body's origin as the expected value. If an allowlist
  // is configured, the request origin must be a member; otherwise (local/dev)
  // the request origin is accepted as-is.
  const allow = (Deno.env.get('MINT_EXPECTED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length && !allow.includes(origin)) {
    log.warn({ event: 'mint.assert', attributes: { route: 'assert', outcome: 'origin_rejected' }, request_id: requestId });
    return json({ ok: false, error: 'assertion_invalid' }, 401);
  }

  let newCounter = storedCounter;

  const deps: MintDeps = {
    // Prove the credential here (real WebAuthn verification). The tested core
    // guarantees the signer is unreachable unless this resolves ok first.
    verifyAssertion: async (input: AssertionInput) => {
      const { verified, newCounter: reported } = await verifyWebAuthnAssertion(input, {
        publicKey,
        storedCounter,
        rpId,
        expectedOrigin: origin,
        expectedChallenge: challenge
      });
      if (!verified) return { ok: false };
      newCounter = reported;
      // Clone detection (ADR-0002): reject a non-increasing counter.
      if (!evaluateCounter(storedCounter, newCounter)) return { ok: false };
      return { ok: true, credentialId: input.credentialId };
    },
    lookupUserIdByCredential: () => Promise.resolve(userId),
    createSession: async ({ user_id, expires_at_ms }) => {
      const { data, error } = await supabase.rpc('mint_create_session', {
        p_user_id: user_id,
        p_expires_at: new Date(expires_at_ms).toISOString()
      });
      if (error || !data) throw new Error('create_session_failed');
      return { session_id: String(data) };
    },
    signJwt: (claims) => signSessionJwt(claims),
    now: () => Date.now()
  };

  const input: AssertionInput = {
    credentialId,
    clientDataJSON: String(body.clientDataJSON),
    authenticatorData: String(body.authenticatorData),
    signature: String(body.signature),
    origin
  };

  const result = await mintSessionFromAssertion(deps, input);
  if (!result.ok) {
    log.warn({ event: 'mint.assert', attributes: { route: 'assert', outcome: result.reason }, request_id: requestId });
    return json({ ok: false, error: result.reason }, result.status);
  }

  // Persist the monotonic counter post-auth (clone-detection bookkeeping).
  if (newCounter > storedCounter) {
    const bump = await supabase.rpc('mint_bump_counter', { p_credential_id: credentialId, p_counter: newCounter });
    if (bump.error) {
      log.error({ event: 'mint.assert', attributes: { route: 'assert', outcome: 'counter_bump_failed' }, request_id: requestId });
    }
  }

  log.info({ event: 'mint.assert', attributes: { route: 'assert', outcome: 'ok' }, request_id: requestId });
  return json(
    {
      ok: true,
      access_token: result.access_token,
      token_type: 'bearer',
      expires_at: new Date(result.expires_at_ms).toISOString(),
      session_id: result.session_id
    },
    200
  );
}

Deno.serve(async (req) => {
  const requestId = req.headers.get('X-Request-ID') ?? undefined;
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  const supabase = mintWriterClient(await signMintWriterToken(Date.now()));

  if (body.action === 'challenge') {
    const rpId = String(body.rp_id ?? '');
    const origin = String(body.origin ?? '');
    if (!rpId || !origin) return json({ ok: false, error: 'bad_request' }, 400);
    const { data, error } = await supabase.rpc('mint_issue_challenge', { p_rp_id: rpId, p_origin: origin });
    if (error || !data) {
      log.error({ event: 'mint.challenge', attributes: { route: 'challenge', outcome: 'error' }, request_id: requestId });
      return json({ ok: false, error: 'mint_failed' }, 500);
    }
    log.info({ event: 'mint.challenge', attributes: { route: 'challenge', outcome: 'ok' }, request_id: requestId });
    return json({ ok: true, challenge: data }, 200);
  }

  if (body.action === 'assert') {
    return handleAssert(supabase, body, requestId);
  }

  return json({ ok: false, error: 'bad_request' }, 400);
});
