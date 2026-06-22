/**
 * redeem-invite / core — the unit-tested heart of the redeem Edge Function
 * (ADR-0029 P1-2, KEYSTONE).
 *
 * Runtime: Deno (Supabase Edge Function). The REPEATABLE, UNAUTHENTICATED
 * sibling of bootstrap-first-co-chair: same verify_jwt=false shape, same
 * key-parity + origin-pin + verifyWebAuthnRegistration ceremony + self-minted
 * mint_writer token, but the one-shot EXISTS(users) guard is REPLACED by the
 * invite + 15-min-TOTP gate, and BOOTSTRAP_ENABLED is NOT consulted (the redeem
 * path is permanently available — ADR-0029 Decision 2b). It is modelled on
 * bootstrap's core, NOT on the JWT-bound feature EFs.
 *
 * We mirror committee-op's split (ADR-0029 references it): this core takes
 * INJECTED PORTS (an RpcPort + a WebAuthn verifier + a token-minter + the
 * challenge issue/consume + an origin check + key-parity + a per-IP throttle),
 * so dispatch / error-mapping / leak invariants are pure-unit. index.ts is the
 * thin Deno.serve wrapper that constructs the real ports.
 *
 * Findings (threat-model §3.18):
 *   F-168 — bad origin rejected BEFORE any DB call; key-parity 503 pre-dispatch;
 *           a forged attestation NEVER reaches the RPC; NOT one-shot, no
 *           BOOTSTRAP_ENABLED / EXISTS(users) guard.
 *   F-169 — the SQL's invite_invalid (consumed/expired/non-existent) surfaces as
 *           ONE byte-identical normalized client error.
 *   F-170 — the TOTP failure literals (expired/locked/wrong/consumed/not-found)
 *           ALL surface as the SAME normalized client error (no condition leak).
 *   F-171 — the register schema has NO user_id/enrolling_uid; a smuggled one is
 *           ignored and never forwarded to redeem_invite_complete.
 *   F-175 — a per-IP fixed-window throttle is consulted BEFORE the RPC (and
 *           before issueChallenge) for BOTH actions, so a flood is bounded at
 *           the edge before reaching the DB. Throttled → rate_limited / 429.
 *   F-176 — the 6-digit code, the raw TOTP, attestation/clientData secrets, and
 *           the mint token NEVER appear in any log line, structured-log field,
 *           error body, or the invite URL (buildRedeemLink carries only invite_id).
 *           The internal-diagnostic log lines (server-side only) carry the
 *           closed-literal SQL outcome class for operator triage; they NEVER
 *           carry the raw code/credential/IP.
 */

import { log } from '../_shared/log.ts';

// ---- Injected-port contracts ------------------------------------------------

export interface RpcError {
  /** Postgres SQLSTATE, e.g. 'P0001'. */
  code: string | null;
  /** The RAISE message — our SQL terminal raises the reason literal directly. */
  message: string;
}

/** Calls a named Postgres RPC; mirrors supabase-js `.rpc(fn, args)`. */
export type RpcPort = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: RpcError | null }>;

/** The VERIFIED registration credential (only fields the SQL terminal needs). */
export interface VerifiedCredential {
  /** Canonical WebAuthn credential id (the verifier's, never the body's). */
  id: string;
  /** COSE-encoded public key bytes, stored byte-for-byte. */
  publicKey: Uint8Array;
  /** Authenticator AAGUID (uuid string) or null. */
  aaguid: string | null;
  /** Initial signature counter. */
  counter: number;
}

export interface RegistrationVerdict {
  verified: boolean;
  credential: VerifiedCredential | null;
}

/** Verifies the WebAuthn attestation round-trip server-side. */
export type RegistrationVerifier = (
  input: {
    credentialId: string;
    attestationObject: string;
    clientDataJSON: string;
    transports: string[];
  },
  ctx: { rpId: string; expectedOrigin: string; expectedChallenge: string },
) => Promise<RegistrationVerdict>;

/** The action label the per-IP throttle is consulted against. */
export type RedeemAction = 'challenge' | 'register';

/** Decision returned by the per-action throttle port (F-175). */
export interface ThrottleDecision {
  /** True = the call may proceed; false = throttled (caller emits 429). */
  allowed: boolean;
}

/** The full injected dependency set the dispatch consumes. */
export interface RedeemDeps {
  /** Calls redeem_invite_complete (the mint_writer-only terminal). */
  rpc: RpcPort;
  /** Cold-start HMAC pseudonym-key parity assertion (ADR-0024). Rejects → 503. */
  assertKeyParity: () => Promise<void>;
  /** Origin allowlist check (MINT_EXPECTED_ORIGINS). False → 401, pre-DB. */
  originAllowed: (origin: string) => boolean;
  /** Server-side WebAuthn registration verifier. */
  verifyRegistration: RegistrationVerifier;
  /** Self-mints the least-privilege mint_writer token (F-118; never service_role). */
  mintWriterToken: () => Promise<string>;
  /** Issues a single-use WebAuthn challenge bound to rp_id + origin. */
  issueChallenge: (
    rpId: string,
    origin: string,
  ) => Promise<{ ok: boolean; challenge: string | null }>;
  /** Consumes a challenge, returning the (rp_id, origin) it was issued for. */
  consumeChallenge: (
    challenge: string,
  ) => Promise<{ rp_id: string; origin: string } | null>;
  /**
   * F-175 per-action throttle, applied BEFORE the DB round-trip on BOTH actions.
   * The implementation hashes / buckets the client IP server-side; the IP itself
   * never leaves the function (F-176). A `denied` decision short-circuits with
   * the normalized `rate_limited` / 429 (mapped via mapRedeemError).
   *
   * Optional ONLY so existing pure-unit tests that pre-date F-175 keep passing
   * without modification — the production wiring in index.ts ALWAYS supplies a
   * real throttle. When the port is absent the dispatch treats the call as
   * un-throttled (the call proceeds). The F-175 Deno test injects it explicitly
   * and asserts (a) the throttle is consulted BEFORE any RPC call, and
   * (b) a throttled call returns 429 `rate_limited` with no body/PI/code.
   */
  throttle?: (action: RedeemAction) => ThrottleDecision;
}

/** The normalized dispatch result the thin index.ts serializes verbatim.
 *  `status` is kept as the broad `number` (not a literal union) so call-site
 *  comparisons like `res.status !== 403` are well-typed across the union. */
export type RedeemResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; body: { error: string } };

// ---- Normalized client errors ----------------------------------------------

/**
 * The SINGLE normalized client error every invite/TOTP failure literal maps to.
 * F-169/F-170: consumed ≡ expired ≡ non-existent invite, and every TOTP
 * condition (expired/locked/wrong/consumed/not-found), all surface as this ONE
 * byte-identical `{ error, status }` — the client can never distinguish which
 * condition failed (enumeration / oracle defeat). It deliberately does NOT echo
 * the raw SQL literal (F-176).
 */
const NORMALIZED_REDEEM_INVALID = { error: 'redeem_invalid', status: 422 as const };

/** The set of SQL RAISE literals that collapse to the normalized invalid error. */
const NORMALIZED_LITERALS: ReadonlySet<string> = new Set([
  'invite_invalid', // consumed / expired / non-existent (F-169)
  'TOTP_BOOTSTRAP_EXPIRED', // F-170 window
  'TOTP_BOOTSTRAP_LOCKED', // F-170 lock
  'TOTP_BOOTSTRAP_WRONG_CODE',
  'TOTP_BOOTSTRAP_CONSUMED',
  'TOTP_BOOTSTRAP_NOT_FOUND',
]);

/**
 * F-175 — the rate-limit literal. The throttle port short-circuits to this
 * synthetic RpcError so the same mapping pathway covers it (the dispatch
 * never reaches the RPC on a throttled call — the RPC dep is NOT invoked).
 */
const RATE_LIMITED_LITERAL = 'rate_limited';

/**
 * Map a Postgres error raised by redeem_invite_complete onto the normalized
 * client error. Every invite/TOTP failure literal yields the SAME
 * `{ error, status }` (F-169/F-170). The F-175 throttle short-circuits to
 * `rate_limited`/429 via the same pathway (so logging + status mapping live in
 * one place). Anything else is a generic redeem failure (never echoing the raw
 * message — F-176).
 */
export function mapRedeemError(error: RpcError): { error: string; status: number } {
  if (error.message === RATE_LIMITED_LITERAL) {
    return { error: 'rate_limited', status: 429 };
  }
  if (NORMALIZED_LITERALS.has(error.message)) {
    return { ...NORMALIZED_REDEEM_INVALID };
  }
  // 42501 (insufficient_privilege) would mean the mint_writer grant regressed —
  // still normalized to avoid disclosing the internal posture to the client.
  return { error: 'redeem_failed', status: 500 };
}

// ---- The redeem link builder (F-170/F-176) ----------------------------------

/**
 * Build the /redeem deep link. F-170/F-176: the link carries ONLY the opaque
 * invite_id — the 6-digit code is member-ENTERED in the form, NEVER appended to
 * a URL/query string (keeps the code off proxy logs / browser history /
 * referrer headers; constraints.md "No PII in URL query strings"). There is no
 * code/totp parameter and the signature accepts none.
 */
export function buildRedeemLink(opts: { invite_id: string; base?: string }): string {
  const base = opts.base ?? '';
  const path = `/redeem?invite_id=${encodeURIComponent(opts.invite_id)}`;
  return base ? `${base.replace(/\/$/, '')}${path}` : path;
}

// ---- Helpers ----------------------------------------------------------------

function fail(status: 400 | 401 | 422 | 429 | 500 | 503, error: string): RedeemResult {
  return { ok: false, status, body: { error } };
}

/** Uint8Array → `\x<hex>` PostgREST bytea literal (mirrors the bootstrap EF). */
function bytesToByteaHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return `\\x${hex}`;
}

function str(v: unknown): string {
  return v != null ? String(v) : '';
}

// ---- Dispatch ---------------------------------------------------------------

/**
 * The two-action dispatch (challenge → register), mirroring bootstrap's shape.
 * Trust ordering is load-bearing:
 *   1. key-parity (503) — the process cannot serve under a mismatched key;
 *   2. origin allowlist (401) — rejected BEFORE any DB/challenge/RPC work (F-168);
 *   3. action routing (each action consults the F-175 throttle BEFORE any DB
 *      round-trip — see handleChallenge / handleRegister).
 * No log line on ANY path carries the code/TOTP/attestation/mint token (F-176):
 * we log closed-literal outcomes only, and never the request body.
 */
export async function dispatch(
  deps: RedeemDeps,
  body: Record<string, unknown>,
): Promise<RedeemResult> {
  // (1) Cold-start key parity. A mismatch → 503 BEFORE any DB call (F-168).
  try {
    await deps.assertKeyParity();
  } catch {
    log.error({ event: 'redeem.key_parity', attributes: { outcome: 'mismatch' } });
    return fail(503, 'service_unavailable');
  }

  const action = str(body.action);
  const origin = str(body.origin);
  const rpId = str(body.rpId);

  // (2) Origin pin — rejected BEFORE any DB/challenge/RPC call (F-168). The
  //     CORS layer is defense-in-depth; this is the authoritative trust gate.
  if (!deps.originAllowed(origin)) {
    log.warn({ event: `redeem.${action || 'unknown'}`, attributes: { outcome: 'origin_rejected' } });
    return fail(401, 'origin_rejected');
  }

  if (action === 'challenge') return handleChallenge(deps, rpId, origin, body);
  if (action === 'register') return handleRegister(deps, rpId, origin, body);

  log.warn({ event: 'redeem.dispatch', attributes: { outcome: 'bad_request' } });
  return { ok: false, status: 400, body: { error: 'bad_request' } };
}

/**
 * F-175 short-circuit — emit a normalized rate-limited response without ever
 * touching the issuer / RPC. The same `mapRedeemError` pathway covers it so the
 * status mapping lives in ONE place. The internal log line carries only the
 * closed-literal bucket class — never the IP, never the body.
 */
function throttled(action: RedeemAction): RedeemResult {
  log.warn({
    event: `redeem.${action}`,
    attributes: { outcome: 'rate_limited', rate_limit_key_class: 'per_ip' },
  });
  const mapped = mapRedeemError({ code: null, message: 'rate_limited' });
  return { ok: false, status: mapped.status, body: { error: mapped.error } };
}

/**
 * challenge action — issue a single-use WebAuthn challenge bound to rp_id +
 * origin. F-175: this cheap path does NO code/TOTP work and NEVER reaches
 * redeem_invite_complete (no lock-state mutation possible code-lessly). The
 * per-IP throttle is consulted BEFORE the issue call so even a code-less flood
 * is bounded at the edge before reaching the DB-backed challenge table.
 *
 * The challenge cap is intentionally generous (the action does no expensive
 * work and is also called legitimately on every page load) but a real
 * ~12-person committee will never come close to the configured per-minute cap.
 */
async function handleChallenge(
  deps: RedeemDeps,
  rpId: string,
  origin: string,
  _body: Record<string, unknown>,
): Promise<RedeemResult> {
  if (!rpId || !origin) {
    return { ok: false, status: 400, body: { error: 'bad_request' } };
  }
  // F-175: per-IP throttle BEFORE the issuer round-trip. A throttled call MUST
  // NOT reach `issueChallenge` (asserted by the Deno test). The port is
  // optional only to keep pre-F-175 unit tests passing without modification;
  // production always supplies it (index.ts).
  if (deps.throttle && !deps.throttle('challenge').allowed) {
    return throttled('challenge');
  }
  const issued = await deps.issueChallenge(rpId, origin);
  if (!issued.ok || !issued.challenge) {
    log.error({ event: 'redeem.challenge', attributes: { outcome: 'issue_failed' } });
    return fail(503, 'service_unavailable');
  }
  log.info({ event: 'redeem.challenge', attributes: { outcome: 'ok' } });
  return { ok: true, status: 200, body: { ok: true, challenge: issued.challenge } };
}

/**
 * register action — consume the challenge, verify the attestation server-side,
 * self-mint the mint_writer token, and call redeem_invite_complete with ONLY
 * the verified credential fields + the invite_id + the member-entered code.
 *
 * F-171: NO caller-supplied uid is read from the body or forwarded to the RPC —
 * the SQL terminal binds committee_invite.target_user_id by construction.
 * F-176: the code/attestation/clientData/mint token never log; the error body
 * is the normalized literal, never the raw SQL condition.
 */
async function handleRegister(
  deps: RedeemDeps,
  rpId: string,
  origin: string,
  body: Record<string, unknown>,
): Promise<RedeemResult> {
  const inviteId = str(body.invite_id);
  const totpCode = str(body.totp_code);
  const challenge = str(body.challenge);
  const credentialId = str(body.credentialId);
  const attestationObject = str(body.attestationObject);
  const clientDataJSON = str(body.clientDataJSON);
  const deviceLabel = body.deviceLabel != null ? String(body.deviceLabel) : null;
  const transports = Array.isArray(body.transports)
    ? (body.transports as unknown[]).map(String)
    : [];

  if (!inviteId || !totpCode || !challenge || !credentialId || !attestationObject || !clientDataJSON || !rpId || !origin) {
    log.warn({ event: 'redeem.register', attributes: { outcome: 'bad_request' } });
    return { ok: false, status: 400, body: { error: 'bad_request' } };
  }

  // F-175: per-IP throttle BEFORE consume/verify/RPC. A throttled call MUST
  // NOT reach `consumeChallenge`, `verifyRegistration`, or the RPC (asserted by
  // the Deno test). This caps the lock-state-mutating path well below the
  // per-invite 5-attempt-lock so a flood cannot weaponise the lock counter.
  if (deps.throttle && !deps.throttle('register').allowed) {
    return throttled('register');
  }

  // Consume the single-use challenge AND bind the body rp_id/origin to the
  // (rp_id, origin) it was issued for (mirrors the bootstrap C4 binding). A
  // consumed/expired/missing challenge → no row → normalized registration error.
  const issued = await deps.consumeChallenge(challenge);
  if (!issued || issued.rp_id !== rpId || issued.origin !== origin) {
    log.warn({ event: 'redeem.register', attributes: { outcome: 'challenge_invalid' } });
    return fail(401, 'registration_invalid');
  }

  // Server-verifies the attestation. F-168: a forged attestation NEVER reaches
  // redeem_invite_complete — only the VERIFIED credential id/publicKey forward.
  const verdict = await deps.verifyRegistration(
    { credentialId, attestationObject, clientDataJSON, transports },
    { rpId, expectedOrigin: origin, expectedChallenge: challenge },
  );
  if (!verdict.verified || !verdict.credential) {
    log.warn({ event: 'redeem.register', attributes: { outcome: 'attestation_invalid' } });
    return fail(401, 'registration_invalid');
  }
  const cred = verdict.credential;

  // F-171: the forwarded arg set carries the invite_id, the code, and the
  // VERIFIED credential fields ONLY — NO p_user_id / p_enrolling_uid /
  // p_target_user_id. The SQL terminal binds committee_invite.target_user_id.
  // NOTE: an earlier draft called deps.mintWriterToken() here as a "self-mint
  // beat" — that was redundant. The supabase client constructed for this
  // dispatch already mints the writer token on the rpc() path (see index.ts);
  // a second mint just doubles the work without any added security property.
  const { data, error } = await deps.rpc('redeem_invite_complete', {
    p_invite_id: inviteId,
    p_totp_code: totpCode,
    p_credential_id: cred.id,
    p_public_key: bytesToByteaHex(cred.publicKey),
    p_aaguid: cred.aaguid,
    p_transports: transports,
    p_rp_id: rpId,
    p_device_label: deviceLabel,
  });

  if (error) {
    // F-169/F-170: every invite/TOTP literal → ONE normalized client error.
    // F-176: log the closed-literal outcome only — never the raw SQL message,
    // the code, or the credential secrets. The structured-log emission below
    // is SERVER-ONLY (operator-diagnostic): it carries the closed-literal SQL
    // outcome class (one of the NORMALIZED_LITERALS set) so an operator can
    // tell a tutor "your TOTP expired" from "your invite was already used"
    // WITHOUT the client response ever distinguishing them (the client body
    // remains the byte-identical normalized error — assertions in core.test).
    const mapped = mapRedeemError(error);
    const internalClass = classifyInternal(error);
    // The closed-literal internal class rides the top-level `error_class` field
    // (not in attributes — it bypasses the safeFields allowlist by design, like
    // every other EF's error_class emission). It is server-only diagnostics:
    // the client response body stays the byte-identical normalized error.
    log.warn({
      event: 'redeem.register',
      outcome: 'redeem_rejected',
      error_class: internalClass,
    });
    return { ok: false, status: mapped.status as 422 | 500, body: { error: mapped.error } };
  }

  const result = (data ?? {}) as { user_id?: string };
  log.info({ event: 'redeem.register', attributes: { outcome: 'ok' } });
  // Success body is EXACTLY { ok, user_id } — no credential id, no code, no
  // extra fields the caller did not already know (F-176).
  return { ok: true, status: 200, body: { ok: true, user_id: str(result.user_id) } };
}

/**
 * Server-only operator-diagnostic classifier. Maps the RAW SQL RAISE literal
 * onto a CLOSED, non-PI bucket label suitable for the structured log. The
 * label discriminates the three invite outcomes and the TOTP outcomes so an
 * operator can triage a member's "my code doesn't work" report — but the
 * CLIENT response remains the byte-identical normalized error (F-169/F-170 are
 * the client-side oracle defense; this is the SERVER-SIDE diagnosability that
 * second-opinion-reviewer asked for).
 *
 * F-176: the label is a closed enum of literals, NEVER the raw code/credential.
 */
function classifyInternal(error: RpcError): string {
  switch (error.message) {
    case 'invite_invalid':
      return 'invite_invalid';
    case 'TOTP_BOOTSTRAP_EXPIRED':
      return 'totp_expired';
    case 'TOTP_BOOTSTRAP_LOCKED':
      return 'totp_locked';
    case 'TOTP_BOOTSTRAP_WRONG_CODE':
      return 'totp_wrong_code';
    case 'TOTP_BOOTSTRAP_CONSUMED':
      return 'totp_consumed';
    case 'TOTP_BOOTSTRAP_NOT_FOUND':
      return 'totp_not_found';
    case 'rate_limited':
      return 'rate_limited';
    default:
      return 'unknown';
  }
}
