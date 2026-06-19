/**
 * bootstrap-first-co-chair — Edge Function handler (ADR-0025).
 *
 * Runtime: Deno (Supabase Edge Function). The ONE-SHOT cold-instance path that
 * creates the very first committee co-chair. It has no authenticated caller (a
 * fresh instance has zero users and nobody to issue a TOTP), so it is
 * registered with verify_jwt = false — BUT it is NOT open:
 *
 *   - The SQL function `public.bootstrap_first_co_chair` is EXECUTE-granted to
 *     `mint_writer` ONLY; this handler presents a self-minted role=mint_writer
 *     token (same isolated key as mint-session — F-118, no service_role).
 *   - The SQL function aborts (advisory-lock + count=0) if ANY user already
 *     exists, so it can succeed AT MOST ONCE for the lifetime of the project.
 *     The guard is self-disabling: after the first co-chair commits it can
 *     never run again.
 *   - The request origin is checked against MINT_EXPECTED_ORIGINS.
 *   - assertKeyParity() runs first (same cold-start invariant as every op).
 *
 * Operators MUST delete this function after first use (ADR-0025 A4); the count
 * guard already prevents re-creation, this removes the probe surface entirely.
 *
 * POST { credentialId, publicKey (base64url COSE key), aaguid?, transports?,
 *        rpId, deviceLabel?, origin }
 *   → bootstrap_first_co_chair → { ok: true, user_id }
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { log, withFunctionName } from '../_shared/log.ts';
import { assertKeyParity, KeyParityError } from '../_shared/key-parity-fetcher.ts';
import { signMintWriterToken } from '../mint-session/signing.ts';

withFunctionName('bootstrap-first-co-chair');

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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

/** base64url string → `\x<hex>` PostgREST bytea literal. */
function b64urlToByteaHex(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  let hex = '';
  for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return `\\x${hex}`;
}

Deno.serve(async (req) => {
  const requestId = req.headers.get('x-request-id') ?? undefined;

  if (req.method !== 'POST') {
    return json({ ok: false, error: 'bad_request' }, 405);
  }

  // ADR-0025 Finding 2 (security review) — BOOTSTRAP_ENABLED window control.
  // Default-deny: the endpoint is inert unless the operator explicitly opens
  // the bootstrap window. Cheap refusal BEFORE any DB work (also bounds the
  // unauthenticated-request DoS surface). Second independent control alongside
  // the SQL one-shot guard.
  if (Deno.env.get('BOOTSTRAP_ENABLED') !== 'true') {
    return json({ ok: false, error: 'bootstrap_disabled' }, 403);
  }

  // ===========================================================================
  // FAIL-CLOSED — registration ceremony NOT YET IMPLEMENTED (security BLOCKER).
  // ===========================================================================
  // Security review (ADR-0025 Finding 1) BLOCKED the first cut: accepting a
  // `publicKey` + `credentialId` from the unauthenticated request body and
  // storing them as the root-of-trust credential — with NO server-issued
  // registration challenge and NO `verifyRegistrationResponse` — lets whoever
  // reaches the endpoint register a credential THEY control and become
  // worker_co_chair. That is an auth-bypass.
  //
  // The correct implementation (ADR-0025 §A2) requires the full WebAuthn
  // REGISTRATION ceremony, which does not yet exist anywhere in this app
  // (only the assertion/sign-in half does):
  //   1. server: issue a single-use registration challenge;
  //   2. browser: navigator.credentials.create() → attestation;
  //   3. server: verifyRegistrationResponse({ expectedChallenge,
  //      expectedOrigin, expectedRPID, requireUserVerification }) — mirror of
  //      mint-session/assertion.ts's verifyAuthenticationResponse — and pass
  //      ONLY the VERIFIED registrationInfo.credential.publicKey/.id to the RPC;
  //   4. threat-modeler sign-off + human gate (HG-AUTH-BOOTSTRAP).
  //
  // Until that lands, this handler refuses to create a user. The migration +
  // SQL guard + signing prod-lock + this scaffold are the reviewed foundation;
  // the ceremony is the tracked follow-up. DO NOT remove this guard without the
  // verifyRegistrationResponse step + a fresh security review.
  return json({ ok: false, error: 'registration_verification_not_implemented' }, 501);
  // eslint-disable-next-line no-unreachable -- intentional fail-closed; the
  // verified-ceremony code below is retained as the implementation scaffold.

  // Cold-start HMAC pseudonym-key parity (ADR-0024 §2) — same invariant as
  // every other op; a stale key must not silently corrupt the audit trail.
  try {
    await assertKeyParity();
  } catch (e) {
    if (e instanceof KeyParityError) {
      log.error({ event: 'bootstrap.key_parity.fail', attributes: { outcome: 'mismatch' }, request_id: requestId });
      return json({ ok: false, error: 'service_unavailable' }, 503);
    }
    throw e;
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  const credentialId = String(body.credentialId ?? '');
  const publicKey = String(body.publicKey ?? '');
  const rpId = String(body.rpId ?? '');
  const origin = String(body.origin ?? '');
  const deviceLabel = body.deviceLabel != null ? String(body.deviceLabel) : null;
  const aaguid = body.aaguid != null && String(body.aaguid) !== '' ? String(body.aaguid) : null;
  const transports = Array.isArray(body.transports) ? (body.transports as unknown[]).map(String) : [];

  if (!credentialId || !publicKey || !rpId || !origin) {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  // Origin allowlist — same posture as mint-session. If configured, the
  // request origin must be a member; in local/dev (no allowlist) accept as-is.
  const allow = (Deno.env.get('MINT_EXPECTED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length && !allow.includes(origin)) {
    log.warn({ event: 'bootstrap.first_co_chair', attributes: { outcome: 'origin_rejected' }, request_id: requestId });
    return json({ ok: false, error: 'origin_rejected' }, 401);
  }

  // Self-mint the least-privilege mint_writer token (F-118; never service_role).
  const writerToken = await signMintWriterToken(Date.now());
  const supabase = mintWriterClient(writerToken);

  const { data, error } = await supabase.rpc('bootstrap_first_co_chair', {
    p_credential_id: credentialId,
    p_public_key: b64urlToByteaHex(publicKey),
    p_aaguid: aaguid,
    p_transports: transports,
    p_rp_id: rpId,
    p_device_label: deviceLabel
  });

  if (error) {
    // The SQL function raises BOOTSTRAP_ALREADY_DONE (P0001) once a user
    // exists — map to 409 so the browser shows "already initialised" rather
    // than a generic failure. Everything else is 500.
    const already = (error.message ?? '').includes('BOOTSTRAP_ALREADY_DONE');
    log.warn({
      event: 'bootstrap.first_co_chair',
      attributes: { outcome: already ? 'already_done' : 'error' },
      request_id: requestId
    });
    return json({ ok: false, error: already ? 'already_initialised' : 'bootstrap_failed' }, already ? 409 : 500);
  }

  log.info({ event: 'bootstrap.first_co_chair', attributes: { outcome: 'ok' }, request_id: requestId });
  return json({ ok: true, user_id: String(data) }, 200);
});
