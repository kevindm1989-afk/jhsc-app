/**
 * bootstrap-first-co-chair — Edge Function handler (ADR-0025).
 *
 * Runtime: Deno (Supabase Edge Function). The ONE-SHOT cold-instance path that
 * creates the very first committee co-chair. It has no authenticated caller (a
 * fresh instance has zero users and nobody to issue a TOTP), so it is
 * registered with verify_jwt = false — BUT it is NOT open:
 *
 *   - The SQL fn `public.bootstrap_first_co_chair` is EXECUTE-granted to
 *     `mint_writer` ONLY; this handler presents a self-minted role=mint_writer
 *     token (same isolated key as mint-session — F-118, no service_role).
 *   - The SQL fn aborts (advisory-lock + count=0) if ANY user already exists,
 *     so it can succeed AT MOST ONCE for the project's lifetime.
 *   - `BOOTSTRAP_ENABLED` default-deny gates the EF at the handler edge — the
 *     bootstrap window only exists when the operator explicitly opens it.
 *   - The full WebAuthn REGISTRATION ceremony runs server-side: a server-
 *     issued single-use challenge bound to rp_id+origin, then
 *     `verifyRegistrationResponse` checks the round-trip + attestation. Only
 *     the VERIFIED registrationInfo.credential.publicKey/.id reach the RPC —
 *     body-supplied keys are never trusted (ADR-0025 §A2 / Finding 1 fix).
 *   - The request origin is checked against MINT_EXPECTED_ORIGINS.
 *   - `assertKeyParity()` runs first (same cold-start invariant as every op).
 *
 * Operators MUST delete this function (and unset BOOTSTRAP_ENABLED) after first
 * use (ADR-0025 A4). The count=0 guard already prevents re-creation; deletion
 * removes the probe surface.
 *
 * Two actions:
 *
 *   POST { action: 'challenge', rpId, origin }
 *       → mint_issue_challenge → { ok, challenge }   (single-use, ≤120s, F-37)
 *
 *   POST { action: 'register', credentialId, attestationObject,
 *          clientDataJSON, transports?, rpId, origin, deviceLabel? }
 *       → consume challenge, verifyRegistrationResponse, RPC with VERIFIED key
 *       → { ok, user_id }
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { log, withFunctionName } from '../_shared/log.ts';
import { assertKeyParity, KeyParityError } from '../_shared/key-parity-fetcher.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { signMintWriterToken } from '../mint-session/signing.ts';
import { verifyWebAuthnRegistration } from './registration.ts';

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

/** Uint8Array → `\x<hex>` PostgREST bytea literal. */
function bytesToByteaHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return `\\x${hex}`;
}

function originAllowed(origin: string): boolean {
  const allow = (Deno.env.get('MINT_EXPECTED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return allow.length === 0 ? true : allow.includes(origin);
}

async function handleChallenge(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
  requestId: string | undefined
): Promise<Response> {
  const rpId = String(body.rpId ?? '');
  const origin = String(body.origin ?? '');
  if (!rpId || !origin) {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  if (!originAllowed(origin)) {
    log.warn({ event: 'bootstrap.challenge', attributes: { outcome: 'origin_rejected' }, request_id: requestId });
    return json({ ok: false, error: 'origin_rejected' }, 401);
  }
  // C1/C2 — bootstrap-isolated challenge surface (NOT mint_issue_challenge).
  const { data, error } = await supabase.rpc('bootstrap_issue_challenge', {
    p_rp_id: rpId,
    p_origin: origin,
    p_ttl_seconds: 120
  });
  if (error || !data) {
    log.error({ event: 'bootstrap.challenge', attributes: { outcome: 'issue_failed' }, request_id: requestId });
    return json({ ok: false, error: 'service_unavailable' }, 503);
  }
  log.info({ event: 'bootstrap.challenge', attributes: { outcome: 'ok' }, request_id: requestId });
  return json({ ok: true, challenge: String(data) }, 200);
}

/**
 * C11 — durable forensic record of an attempted forgery. The bootstrap EF
 * rejects BEFORE any RPC, so the SQL fn cannot emit it; emit here.
 * `outcome` is one of the closed-set normalized labels (mirrors C12) — the
 * client never sees this granularity. NO raw credential id / clientDataJSON /
 * AAGUID emitted (privacy + no info-disclosure-via-audit).
 */
async function emitEnrollFailedAudit(
  supabase: SupabaseClient,
  outcome: 'challenge_invalid' | 'rp_id_origin_mismatch' | 'attestation_invalid',
  rpId: string,
  origin: string,
  requestId: string | undefined
): Promise<void> {
  // audit_emit is SECURITY DEFINER + closed-enum-validated (six-mirror); the
  // event_type is 'auth.passkey.enroll_failed' (added by migration 36). The
  // actor pseudonym here is a stable but unattributable label since there is
  // no user yet — use a deterministic placeholder so the row is grep-able as
  // bootstrap-class without exposing any real PI.
  try {
    // Purpose-narrow wrapper from migration 36 — mint_writer-callable,
    // hardcodes the event_type so this RPC cannot be used to forge any other
    // audit row, length-bounds the meta fields.
    await supabase.rpc('bootstrap_audit_enroll_failed', {
      p_outcome: outcome,
      p_rp_id: rpId,
      p_origin: origin,
      p_request_id: requestId ?? null
    });
  } catch {
    // Audit emit failure is itself logged but never blocks the client error
    // response (we are already in a failure path).
    log.error({ event: 'bootstrap.register', attributes: { outcome: 'audit_emit_failed' }, request_id: requestId });
  }
}

async function handleRegister(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
  requestId: string | undefined
): Promise<Response> {
  const credentialId = String(body.credentialId ?? '');
  const attestationObject = String(body.attestationObject ?? '');
  const clientDataJSON = String(body.clientDataJSON ?? '');
  const rpId = String(body.rpId ?? '');
  const origin = String(body.origin ?? '');
  const deviceLabel = body.deviceLabel != null ? String(body.deviceLabel) : null;
  const transports = Array.isArray(body.transports) ? (body.transports as unknown[]).map(String) : [];

  if (!credentialId || !attestationObject || !clientDataJSON || !rpId || !origin) {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  if (!originAllowed(origin)) {
    log.warn({ event: 'bootstrap.register', attributes: { outcome: 'origin_rejected' }, request_id: requestId });
    return json({ ok: false, error: 'origin_rejected' }, 401);
  }

  const expectedChallenge = String(body.challenge ?? '');
  if (!expectedChallenge) {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  // C1/C3/C4 — consume the bootstrap challenge (isolated from mint) AND get
  // the issuance (rp_id, origin) back, so we can BIND the body values to them.
  // A consumed/expired/missing challenge returns no row.
  const consumed = await supabase.rpc('bootstrap_consume_challenge', { p_challenge: expectedChallenge });
  const issued = (Array.isArray(consumed.data) ? consumed.data[0] : null) as
    | { rp_id: string; origin: string }
    | null;
  if (consumed.error || !issued) {
    // C12 — normalized oracle: never distinguish challenge-expired vs invalid.
    await emitEnrollFailedAudit(supabase, 'challenge_invalid', rpId, origin, requestId);
    log.warn({ event: 'bootstrap.register', attributes: { outcome: 'challenge_invalid' }, request_id: requestId });
    return json({ ok: false, error: 'registration_invalid' }, 401);
  }
  // C4 — bind: the body's rp_id+origin MUST match what was issued. (Origin
  // allowlisting above is necessary but not sufficient — the challenge must
  // also have been issued for THIS rp/origin.)
  if (issued.rp_id !== rpId || issued.origin !== origin) {
    await emitEnrollFailedAudit(supabase, 'rp_id_origin_mismatch', rpId, origin, requestId);
    log.warn({ event: 'bootstrap.register', attributes: { outcome: 'rp_id_origin_mismatch' }, request_id: requestId });
    return json({ ok: false, error: 'registration_invalid' }, 401);
  }

  // C5/C6/C7/C8/C9 — server-verifies the attestation. Only the verified
  // registrationInfo.credential.publicKey/.id reach the RPC; body-supplied
  // credentialId/publicKey are advisory at most (the library cross-checks).
  const verification = await verifyWebAuthnRegistration(
    { credentialId, attestationObject, clientDataJSON, transports },
    { rpId, expectedOrigin: origin, expectedChallenge }
  );
  if (!verification.verified || !verification.credential) {
    await emitEnrollFailedAudit(supabase, 'attestation_invalid', rpId, origin, requestId);
    log.warn({ event: 'bootstrap.register', attributes: { outcome: 'attestation_invalid' }, request_id: requestId });
    return json({ ok: false, error: 'registration_invalid' }, 401);
  }
  const { publicKey: verifiedPubKey, id: verifiedCredId, aaguid, counter: _counter } = verification.credential;

  const { data, error } = await supabase.rpc('bootstrap_first_co_chair', {
    p_credential_id: verifiedCredId,
    p_public_key: bytesToByteaHex(verifiedPubKey),
    p_aaguid: aaguid, // null is fine — column is nullable
    p_transports: transports,
    p_rp_id: rpId,
    p_device_label: deviceLabel
  });

  if (error) {
    // The SQL fn raises BOOTSTRAP_ALREADY_DONE (P0001) once a user exists.
    const already = (error.message ?? '').includes('BOOTSTRAP_ALREADY_DONE');
    log.warn({
      event: 'bootstrap.register',
      attributes: { outcome: already ? 'already_done' : 'error' },
      request_id: requestId
    });
    return json({ ok: false, error: already ? 'already_initialised' : 'bootstrap_failed' }, already ? 409 : 500);
  }

  // C13 — success body is EXACTLY { ok, user_id }. No credentialId, no AAGUID,
  // no extra fields the caller did not already know.
  log.info({ event: 'bootstrap.register', attributes: { outcome: 'ok' }, request_id: requestId });
  return json({ ok: true, user_id: String(data) }, 200);
}

async function handle(req: Request): Promise<Response> {
  const requestId = req.headers.get('x-request-id') ?? undefined;

  if (req.method !== 'POST') {
    return json({ ok: false, error: 'bad_request' }, 405);
  }

  // ADR-0025 Finding 2 — BOOTSTRAP_ENABLED window control. Default-deny: the
  // endpoint is inert unless the operator explicitly opens the bootstrap window.
  // Cheap refusal BEFORE any DB work (bounds the unauthenticated-request DoS
  // surface). Second independent control alongside the SQL one-shot guard.
  if (Deno.env.get('BOOTSTRAP_ENABLED') !== 'true') {
    return json({ ok: false, error: 'bootstrap_disabled' }, 403);
  }

  // Cold-start HMAC pseudonym-key parity (ADR-0024 §2).
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

  // Self-mint the least-privilege mint_writer token (F-118; never service_role).
  const writerToken = await signMintWriterToken(Date.now());
  const supabase = mintWriterClient(writerToken);

  const action = String(body.action ?? '');
  if (action === 'challenge') return handleChallenge(supabase, body, requestId);
  if (action === 'register') return handleRegister(supabase, body, requestId);
  return json({ ok: false, error: 'bad_request' }, 400);
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  // CORS preflight: the browser sends OPTIONS before the cross-origin POST
  // (custom apikey + content-type headers force a preflight). Answer it
  // directly — no body, no side effects, no DB work.
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  // Add CORS headers to every real response so the browser can read it.
  const res = await handle(req);
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
});
