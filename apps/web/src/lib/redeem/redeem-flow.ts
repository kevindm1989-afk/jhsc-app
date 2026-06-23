/**
 * Production redeem orchestration — the /redeem two-action ceremony
 * (ADR-0029 P1-7 / Amendment A-7.4).
 *
 * Mirrors the posture of `signInViaMintSession` (`lib/auth/sign-in-flow.ts`):
 * a callback-driven orchestrator that separates the WebAuthn DOM call (the
 * `runCeremony` callback) from the wire-level transport. Amendment A-7.4
 * ratifies this EXTRACTED factory over an inline-in-component ceremony — the
 * `/redeem` route component (RedeemCard) stays a thin caller, and the ceremony
 * is unit-testable in isolation.
 *
 * The wire contract is the DURABLE part (supabase/functions/redeem-invite/core.ts):
 *   - challenge POST body: { action:'challenge', rpId, origin }  (NO code, NO
 *     invite_id — the cheap challenge path does no code/TOTP work, F-170)
 *   - register POST body:  { action:'register', invite_id, totp_code, challenge,
 *     credentialId, attestationObject, clientDataJSON, transports, deviceLabel,
 *     rpId, origin }
 *   - register responses: {ok,user_id}/200 → ok; redeem_invalid/422 →
 *     redeem_invalid (the ONE normalized failure, F-169/F-170); rate_limited/429
 *     → rate_limited; 401/500/503/400/throw → system_error.
 *
 * F-170/F-176 invariants this orchestrator upholds:
 *   - the 6-digit code rides ONLY the register POST body — never a URL, never a
 *     log, never the returned result.
 *   - the 422 `redeem_invalid` collapses to ONE status — never split by
 *     sub-condition.
 *   - `user_id` from the 200 body flows back on the `ok` result ONLY; this
 *     module never logs it (the caller decides whether to render it — RedeemCard
 *     does NOT, per F-176).
 *   - no `console.*` / structured-log emission carries the code or user_id.
 */

/** The transport the orchestrator POSTs through (the redeem-invite EF seam). */
export type RedeemTransport = (
  body: Record<string, unknown>
) => Promise<{ status: number; body: unknown }>;

/** The verified-attestation shape the WebAuthn ceremony callback returns. */
export interface RedeemCeremonyResult {
  credentialId: string;
  attestationObject: string;
  clientDataJSON: string;
  transports: string[];
}

/**
 * The discriminated result union (mirrors signInViaMintSession's shape). The
 * `system_error` arm deliberately carries NO raw EF enum (F-176) — every
 * server/network failure collapses to the one generic status.
 */
export type RedeemProductionResult =
  | { status: 'ok'; user_id: string }
  | { status: 'redeem_invalid' }
  | { status: 'rate_limited' }
  | { status: 'cancelled' }
  | { status: 'system_error' };

export interface RedeemViaProductionOptions {
  transport: RedeemTransport;
  /** RP-ID — the registrable domain (e.g. `jhsc.example`). */
  rpId: string;
  /** Origin — the full origin of the calling page (e.g. `https://jhsc.example`). */
  origin: string;
  /** The opaque invite id from the link (?invite_id=) — NOT secret. */
  inviteId: string;
  /** The 6-digit one-time code the member typed — the ONLY secret (F-170/F-176). */
  totpCode: string;
  /** Device label forwarded to the register call. */
  deviceLabel: string;
  /**
   * WebAuthn registration callback. Receives the server-minted challenge,
   * returns the verified attestation, OR `null` (or throws — typically
   * `NotAllowedError`/`AbortError`) when the member cancels the OS prompt. The
   * orchestrator treats both null and thrown errors as cancellation.
   */
  runCeremony: (
    challenge: string
  ) => Promise<RedeemCeremonyResult | null> | RedeemCeremonyResult | null;
}

/**
 * End-to-end production redeem: challenge → runCeremony → register. See the
 * module header for the wire contract + the F-170/F-176 invariants.
 */
export async function redeemViaProduction(
  opts: RedeemViaProductionOptions
): Promise<RedeemProductionResult> {
  // (1) Challenge — carries NEITHER the code NOR the invite_id (F-170). A
  //     transport throw or a non-OK response collapses to system_error WITHOUT
  //     prompting the device (no point opening the OS dialog).
  let challenge: string;
  try {
    const res = await opts.transport({
      action: 'challenge',
      rpId: opts.rpId,
      origin: opts.origin
    });
    const body = (res.body ?? {}) as { ok?: boolean; challenge?: unknown };
    if (res.status !== 200 || body.ok !== true || typeof body.challenge !== 'string') {
      return { status: 'system_error' };
    }
    challenge = body.challenge;
  } catch {
    return { status: 'system_error' };
  }

  // (2) The WebAuthn registration ceremony. Null OR a thrown error (the browser
  //     surfaces NotAllowedError/AbortError on cancel/timeout) ⇒ cancelled.
  //     register is NOT called.
  let credential: RedeemCeremonyResult | null;
  try {
    credential = await Promise.resolve(opts.runCeremony(challenge));
  } catch {
    return { status: 'cancelled' };
  }
  if (!credential) return { status: 'cancelled' };

  // (3) Register — the ONLY call that carries the code + invite_id + the
  //     verified attestation. F-171: NO caller uid is smuggled in. A transport
  //     throw collapses to system_error.
  let res: { status: number; body: unknown };
  try {
    res = await opts.transport({
      action: 'register',
      invite_id: opts.inviteId,
      totp_code: opts.totpCode,
      challenge,
      credentialId: credential.credentialId,
      attestationObject: credential.attestationObject,
      clientDataJSON: credential.clientDataJSON,
      transports: credential.transports,
      deviceLabel: opts.deviceLabel,
      rpId: opts.rpId,
      origin: opts.origin
    });
  } catch {
    return { status: 'system_error' };
  }

  if (res.status === 200) {
    const body = (res.body ?? {}) as { user_id?: unknown };
    return { status: 'ok', user_id: typeof body.user_id === 'string' ? body.user_id : '' };
  }
  // F-169/F-170: the EF already normalizes every invite/TOTP cause to ONE 422
  // redeem_invalid — we surface a single status, never split by sub-condition.
  if (res.status === 422) return { status: 'redeem_invalid' };
  if (res.status === 429) return { status: 'rate_limited' };
  // 401 (registration_invalid / origin_rejected), 500 (redeem_failed), 400
  // (bad_request), 503 (service_unavailable), or anything else → generic
  // system_error. The raw EF enum is NEVER surfaced on the result (F-176).
  return { status: 'system_error' };
}
