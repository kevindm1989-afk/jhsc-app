/**
 * SupabaseMintSessionClient — production-shaped client for the mint-session
 * Edge Function (ADR-0023 / F-117 / F-118 / F-119).
 *
 * Wire shape DIFFERS from t07-op / concern-op / reprisal-op / t14-op:
 * those route through op-dispatch (`{ op: <name>, ...args }` → `{ ok, data }
 * | { ok, error }`). mint-session uses ACTION-dispatch
 * (`{ action: 'challenge' | 'assert', ...args }`) with action-specific
 * success payloads:
 *
 *   POST { action: 'challenge', rp_id, origin }
 *     → 200 { ok: true, challenge: string }
 *
 *   POST { action: 'assert', credentialId, clientDataJSON, authenticatorData,
 *          signature, origin, challenge }
 *     → 200 { ok: true, access_token, token_type, expires_at, session_id }
 *
 * Error shape is uniform across both actions:
 *   { ok: false, error: 'bad_request' | 'assertion_invalid' |
 *                       'unknown_credential' | 'mint_failed' }
 *
 * Auth: the mint-session Edge Function is registered with `verify_jwt = false`
 * (the caller has NO session yet — that's the whole point of mint-session).
 * The transport's `Authorization: Bearer` header is OMITTED for this client;
 * the F-39 `onSessionRevoked` callback is NOT wired (a 401 from mint-session
 * means assertion_invalid / unknown_credential, NOT session revoked — firing
 * clearJwt would be a category error since there's no session to clear).
 *
 * Transport injection: the constructor takes an `invoke` function so this
 * module has zero runtime dependency on `@supabase/supabase-js`. Production
 * callers wire `invoke` via `createMintSessionFetchTransport` (see
 * `lib/server-client/mint-session-client-factory.ts`); tests inject a stub.
 */

export type MintSessionReason =
  | 'bad_request'
  | 'assertion_invalid'
  | 'unknown_credential'
  | 'mint_failed'
  | 'unknown';

export type MintSessionResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: MintSessionReason; status: number };

/**
 * Transport returns the parsed JSON body + the response status. Matches
 * the shared `EdgeFnFetchTransport` shape exactly so the production
 * factory can reuse it.
 */
export type MintSessionTransport = (
  body: Record<string, unknown>
) => Promise<{ status: number; body: unknown }>;

export interface MintSessionChallengeResult {
  challenge: string;
}

export interface MintSessionAssertResult {
  access_token: string;
  token_type: 'bearer';
  /** ISO 8601 timestamp. */
  expires_at: string;
  session_id: string;
}

export interface SupabaseMintSessionClientOptions {
  transport: MintSessionTransport;
}

interface MintSessionWireOk {
  ok: true;
}
interface MintSessionWireErr {
  ok: false;
  error: MintSessionReason;
}

/**
 * Parse the action-specific success payload. mint-session's `{ ok: true,
 * ...payload }` shape means the SUCCESS fields sit at the top level, not
 * under a `data` key. We strip `ok` and treat the rest as the payload.
 */
function parseOk<T>(payload: unknown): T | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown> & MintSessionWireOk;
  if (p.ok !== true) return null;
  const { ok: _ok, ...rest } = p;
  void _ok;
  return rest as unknown as T;
}

async function invoke<T>(
  transport: MintSessionTransport,
  body: Record<string, unknown>
): Promise<MintSessionResult<T>> {
  const r = await transport(body);
  const payload = r.body as Partial<MintSessionWireOk> & Partial<MintSessionWireErr>;
  if (payload && payload.ok === true) {
    const data = parseOk<T>(payload);
    if (data === null) return { ok: false, reason: 'unknown', status: r.status };
    return { ok: true, data };
  }
  const reason: MintSessionReason = (payload?.error as MintSessionReason | undefined) ?? 'unknown';
  return { ok: false, reason, status: r.status };
}

export class SupabaseMintSessionClient {
  constructor(private opts: SupabaseMintSessionClientOptions) {}

  /**
   * Request a fresh sign-in challenge. The returned `challenge` is a
   * single-use, ≤120s server-minted nonce (F-37) that the caller signs
   * via WebAuthn `navigator.credentials.get` and posts back via
   * `assertCredential`.
   */
  requestChallenge(input: {
    rpId: string;
    origin: string;
  }): Promise<MintSessionResult<MintSessionChallengeResult>> {
    return invoke<MintSessionChallengeResult>(this.opts.transport, {
      action: 'challenge',
      rp_id: input.rpId,
      origin: input.origin
    });
  }

  /**
   * Submit the signed WebAuthn assertion + the challenge it covers. On
   * success the response carries the freshly-minted GoTrue access_token
   * (ES256, ≤300s TTL per F-116), the GoTrue token_type, the ISO
   * `expires_at`, and the server-side `session_id` (= the auth_sessions
   * jti written BEFORE the token was signed, per F-116 ordering).
   *
   * The caller (the sign-in route) is responsible for `setJwt(access_token)`
   * after this resolves `{ ok: true }`.
   */
  assertCredential(input: {
    credentialId: string;
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    origin: string;
    challenge: string;
  }): Promise<MintSessionResult<MintSessionAssertResult>> {
    return invoke<MintSessionAssertResult>(this.opts.transport, {
      action: 'assert',
      credentialId: input.credentialId,
      clientDataJSON: input.clientDataJSON,
      authenticatorData: input.authenticatorData,
      signature: input.signature,
      origin: input.origin,
      challenge: input.challenge
    });
  }
}
