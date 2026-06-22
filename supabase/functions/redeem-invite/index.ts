/**
 * redeem-invite — Edge Function handler (ADR-0029 P1-2, KEYSTONE).
 *
 * Runtime: Deno (Supabase Edge Function). The REPEATABLE, UNAUTHENTICATED
 * invitee-onboarding path: an invited member with NO session opens the redeem
 * link, enters their one-time code + TOTP, and runs the WebAuthn registration
 * ceremony to bind their first passkey + activate their (pre-created) pending
 * membership. It is registered verify_jwt=false (the invitee has no JWT) — but
 * it is NOT open:
 *
 *   - The SQL terminal `public.redeem_invite_complete` is EXECUTE-granted to
 *     `mint_writer` ONLY; this handler presents a self-minted role=mint_writer
 *     token (same isolated key as mint-session — F-118, no service_role).
 *   - It is the REPEATABLE sibling of bootstrap-first-co-chair: the one-shot
 *     EXISTS(users) guard + BOOTSTRAP_ENABLED window are DELIBERATELY NOT reused
 *     (ADR-0029 Decision 2b). Its gate is the single-use invite + 15-min TOTP,
 *     validated atomically inside redeem_invite_complete.
 *   - The full WebAuthn REGISTRATION ceremony runs server-side (the bootstrap
 *     pattern): a server-issued single-use challenge bound to rp_id+origin, then
 *     verifyWebAuthnRegistration. Only the VERIFIED credential.publicKey/.id
 *     reach the RPC — body-supplied keys are never trusted.
 *   - The request origin is checked against MINT_EXPECTED_ORIGINS.
 *   - `assertKeyParity()` runs first (the cold-start invariant every op runs).
 *
 * F-176: the 6-digit code, the raw TOTP, the attestation/clientDataJSON, and the
 * mint token NEVER appear in any log line / structured-log field / error body /
 * URL — the dispatch logs closed-literal outcomes only (see core.ts) and the
 * link builder (buildRedeemLink) carries only invite_id.
 *
 * F-122/F-123 / §3.18 / F-168: redeem-invite is on the session-live
 * PERMANENT_ALLOWLIST (unauthenticated-by-necessity; §3.18 is the threat-model
 * re-pass), so it legitimately skips the per-dispatcher session_is_live()
 * precheck — exactly like mint-session and bootstrap-first-co-chair.
 *
 * Two actions (mirrors bootstrap's challenge → register shape):
 *
 *   POST { action: 'challenge', invite_id, rpId, origin }
 *       → redeem_issue_challenge → { ok, challenge }   (single-use, ≤120s)
 *
 *   POST { action: 'register', invite_id, totp_code, challenge, credentialId,
 *          attestationObject, clientDataJSON, transports?, rpId, origin,
 *          deviceLabel? }
 *       → consume challenge, verifyWebAuthnRegistration, RPC with VERIFIED key
 *       → { ok, user_id }
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { withFunctionName } from '../_shared/log.ts';
import { assertKeyParity } from '../_shared/key-parity-fetcher.ts';
import { serveWithCors } from '../_shared/cors.ts';
import { extractClientIp } from '../_shared/client-ip.ts';
import { FixedWindowRateLimiter } from '../_shared/rate-limit.ts';
import { signMintWriterToken } from '../mint-session/signing.ts';
import { verifyWebAuthnRegistration } from '../bootstrap-first-co-chair/registration.ts';
import {
  dispatch,
  type RedeemAction,
  type RedeemDeps,
  type RpcError,
  type RegistrationVerdict,
  type ThrottleDecision,
} from './core.ts';

withFunctionName('redeem-invite');

type SupabaseClient = ReturnType<typeof createClient>;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mintWriterClient(writerToken: string): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${writerToken}`, apikey: anon } },
    auth: { persistSession: false },
  });
}

function originAllowed(origin: string): boolean {
  const allow = (Deno.env.get('MINT_EXPECTED_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allow.length === 0 ? true : allow.includes(origin);
}

// F-175: per-IP throttle. The caps are intentionally generous for a ~12-person
// committee but bound the unauthenticated flood surface well below what
// `redeem_invite_complete` could service. Two distinct buckets so a `register`
// flood cannot starve the cheap `challenge` action (which a legitimate caller
// uses on every page load) and vice versa. The buckets are PER EF INSTANCE +
// PER MINUTE — a multi-instance flood is bounded by the SQL terminal's own
// gates (single-use invite + 15-min TOTP + 5-attempt lock).
//
// Choice of caps:
//   - challenge: 10 / IP / min. The action does no expensive work and is
//     called on every page load + every retry. 10/min is ~one every 6s — a
//     real user never hits it.
//   - register:   5 / IP / min. The action triggers a DB round-trip + a
//     WebAuthn verify. 5/min is below the per-invite 5-attempt lock, so a
//     flood cannot consume the lock counter faster than the throttle allows.
const CHALLENGE_LIMIT = new FixedWindowRateLimiter({ capacity: 10, windowMs: 60_000 });
const REGISTER_LIMIT = new FixedWindowRateLimiter({ capacity: 5, windowMs: 60_000 });

function makeThrottle(req: Request): (action: RedeemAction) => ThrottleDecision {
  // The IP is extracted ONCE per request and stays in this closure. F-176: the
  // IP is the keyspace seed only — never logged with its value. The structured
  // log emits the bucket-class label via `rate_limit_key_class` (in core.ts).
  const ip = extractClientIp(req);
  return (action) => {
    const limiter = action === 'register' ? REGISTER_LIMIT : CHALLENGE_LIMIT;
    const decision = limiter.consume(ip);
    return { allowed: decision.allowed };
  };
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'bad_request' }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  // The mint_writer client is constructed lazily inside the ports so the token
  // is minted only on the paths that need it. The token NEVER logs (F-176).
  let cachedClient: SupabaseClient | null = null;
  async function client(): Promise<SupabaseClient> {
    if (cachedClient) return cachedClient;
    const writerToken = await signMintWriterToken(Date.now());
    cachedClient = mintWriterClient(writerToken);
    return cachedClient;
  }

  const deps: RedeemDeps = {
    assertKeyParity,
    originAllowed,
    throttle: makeThrottle(req),
    mintWriterToken: () => signMintWriterToken(Date.now()),
    issueChallenge: async (rpId, origin) => {
      const sb = await client();
      // Reuse the bootstrap-isolated challenge surface (mint_writer-granted,
      // isolated from the mint login path). webauthn.create vs webauthn.get +
      // single-use consume keep it safe to share (ADR-0029: reuse the bootstrap
      // challenge primitive).
      const { data, error } = await sb.rpc('bootstrap_issue_challenge', {
        p_rp_id: rpId,
        p_origin: origin,
        p_ttl_seconds: 120,
      });
      if (error || !data) return { ok: false, challenge: null };
      return { ok: true, challenge: String(data) };
    },
    consumeChallenge: async (challenge) => {
      const sb = await client();
      const consumed = await sb.rpc('bootstrap_consume_challenge', { p_challenge: challenge });
      const issued = (Array.isArray(consumed.data) ? consumed.data[0] : null) as
        | { rp_id: string; origin: string }
        | null;
      if (consumed.error || !issued) return null;
      return { rp_id: issued.rp_id, origin: issued.origin };
    },
    verifyRegistration: async (input, ctx): Promise<RegistrationVerdict> => {
      const v = await verifyWebAuthnRegistration(input, {
        rpId: ctx.rpId,
        expectedOrigin: ctx.expectedOrigin,
        expectedChallenge: ctx.expectedChallenge,
      });
      if (!v.verified || !v.credential) return { verified: false, credential: null };
      return {
        verified: true,
        credential: {
          id: v.credential.id,
          publicKey: v.credential.publicKey,
          aaguid: v.credential.aaguid,
          counter: v.credential.counter,
        },
      };
    },
    rpc: async (fn, args): Promise<{ data: unknown; error: RpcError | null }> => {
      const sb = await client();
      const { data, error } = await sb.rpc(fn, args);
      // supabase-js single() not used; redeem_invite_complete RETURNS TABLE, so
      // data arrives as a one-row array — normalize to the row.
      const row = Array.isArray(data) ? (data[0] ?? null) : data;
      return {
        data: row,
        error: error ? { code: error.code ?? null, message: error.message ?? '' } : null,
      };
    },
  };

  const result = await dispatch(deps, body);
  return json(result.body, result.status);
}

// serveWithCors answers the OPTIONS preflight (the browser sends it before the
// cross-origin POST) and appends the MINT_EXPECTED_ORIGINS-reflected CORS
// headers to every real response. The handler still independently validates the
// origin inside dispatch (defense in depth).
serveWithCors(handle);
