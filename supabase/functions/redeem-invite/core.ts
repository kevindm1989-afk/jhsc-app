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
 * challenge issue/consume + an origin check + key-parity), so dispatch /
 * error-mapping / leak invariants are pure-unit. index.ts is the thin
 * Deno.serve wrapper that constructs the real ports.
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
 *   F-176 — the 6-digit code, the raw TOTP, attestation/clientData secrets, and
 *           the mint token NEVER appear in any log line, structured-log field,
 *           error body, or the invite URL (buildRedeemLink carries only invite_id).
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
 * Map a Postgres error raised by redeem_invite_complete onto the normalized
 * client error. Every invite/TOTP failure literal yields the SAME
 * `{ error, status }` (F-169/F-170). Anything else is a generic redeem failure
 * (never echoing the raw message — F-176).
 */
export function mapRedeemError(error: RpcError): { error: string; status: number } {
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

function fail(status: 400 | 401 | 422 | 500 | 503, error: string): RedeemResult {
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
 *   3. action routing.
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
 * challenge action — issue a single-use WebAuthn challenge bound to rp_id +
 * origin. F-175: this cheap path does NO code/TOTP work and NEVER reaches
 * redeem_invite_complete (no lock-state mutation possible code-lessly).
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

  // Self-mint the least-privilege mint_writer token (F-118; never service_role).
  // The token is held only to construct the authorized client; it never logs.
  await deps.mintWriterToken();

  // F-171: the forwarded arg set carries the invite_id, the code, and the
  // VERIFIED credential fields ONLY — NO p_user_id / p_enrolling_uid /
  // p_target_user_id. The SQL terminal binds committee_invite.target_user_id.
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
    // the code, or the credential secrets.
    const mapped = mapRedeemError(error);
    log.warn({ event: 'redeem.register', attributes: { outcome: 'redeem_rejected' } });
    return { ok: false, status: mapped.status as 422 | 500, body: { error: mapped.error } };
  }

  const result = (data ?? {}) as { user_id?: string };
  log.info({ event: 'redeem.register', attributes: { outcome: 'ok' } });
  // Success body is EXACTLY { ok, user_id } — no credential id, no code, no
  // extra fields the caller did not already know (F-176).
  return { ok: true, status: 200, body: { ok: true, user_id: str(result.user_id) } };
}
