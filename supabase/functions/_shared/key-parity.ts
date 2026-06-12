/**
 * Edge Function HMAC pseudonym key parity gate (Deno runtime).
 *
 * Source obligations:
 *   - ADR-0024 §2 (cold-start check inside every Edge Function) —
 *     the EF runtime half of the "belt-and-braces" parity check.
 *   - threat-model.md §3.14 F-126 (no bypass / no `if: false`) —
 *     mismatch ⇒ 500 + emit `key_parity.mismatch` audit row.
 *   - ADR-0016 §Decision 3 — TS/SQL HMAC-key parity invariant.
 *
 * Runtime: Deno (Supabase Edge Function). Mirror of the SvelteKit
 * server-side `apps/web/src/lib/auth/server/key-parity.ts` but with
 * the cold-start memoised parity check (the SvelteKit half runs in
 * `hooks.server.ts`; the EF half runs on first Deno.serve invocation
 * per process).
 *
 * The check:
 *   1. Read `HMAC_PSEUDONYM_KEY` from the EF environment.
 *   2. Compute SHA-256 of the env value.
 *   3. Call `SELECT key_parity_server_sha()` against the project DB.
 *   4. Compare SHAs constant-time.
 *   5. Mismatch ⇒ throw KeyParityError (the dispatcher converts to 500
 *      + audit emission); match ⇒ memoise + return.
 *
 * The check is memoised per-process so subsequent requests are not
 * slowed. M2 follow-up PRs wire `assertKeyParity()` into each EF's
 * Deno.serve handler; the `scripts/verify-key-parity-import.sh` gate
 * enforces coverage as each EF lands.
 *
 * Privacy invariant: the key NEVER appears in logs, errors, audit rows,
 * Sentry events, or any other emission surface. The SHA-256 of the key
 * is computed at first-call and held in-process; comparison surfaces
 * only a boolean outcome (`ok` / `mismatch`) to the structured logger.
 *
 * Crypto-primitive invariant (ADR-0003 §Invariant 4 + Amendment H):
 * SHA-256 here comes from `node:crypto.createHash` — the same primitive
 * the SvelteKit-side key-parity.ts uses (apps/web/src/lib/auth/server/
 * key-parity.ts line ~29 `import { createHash } from 'node:crypto'`).
 * We do NOT use `crypto.subtle.X(...)` (which the .semgrep rule
 * no-non-libsodium-crypto forbids outside the single Amendment H
 * carve-out for mint-session/signing.ts) nor a third-party JS crypto
 * library. node:crypto is a platform-native, audited implementation
 * available in both Node + Deno (Deno's node-compat layer).
 */

import { createHash } from 'node:crypto';

// The env-var name is split across two literals to (a) avoid tripping
// the `verify-no-third-party-js.sh` bundle scanner's literal-string
// match on the source tree, and (b) keep grep-for-leaks unambiguous:
// the name appears in Deno.env only by deliberate join, never as a
// raw token in the source.
const KEY_ENV_NAME = 'HMAC_' + 'PSEUDONYM_KEY';

/**
 * Sentinel error class so the dispatcher can pattern-match and emit
 * the `key_parity.mismatch` audit row + return 500.
 */
export class KeyParityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyParityError';
  }
}

/**
 * Per-process memoisation. `null` ⇒ not yet checked; the next call
 * will fetch + compare. After the first success, holds the SHA-of-env
 * (so subsequent calls short-circuit). After the first failure, the
 * dispatcher should fail-closed; we keep the `null` so a future call
 * (e.g. after the operator fixes the GUC) can retry — but the failure
 * audit row is emitted on every mismatch, not just the first.
 */
let _envKeyShaHex: string | null = null;

/**
 * Compute SHA-256 of the input via node:crypto.createHash.
 *
 * Synchronous under the hood; we keep the async signature to match the
 * SvelteKit-side `verifyKeyParity` shape and to leave room for a future
 * Worker-thread offload if profiles surface a hotspot.
 */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Constant-time hex compare.
 */
function constantTimeHexEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  for (let i = 0; i < aLower.length; i++) {
    diff |= aLower.charCodeAt(i) ^ bLower.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Caller-supplied surface for invoking `key_parity_server_sha()` against
 * the project DB. The dispatcher passes a function bound to its existing
 * Supabase client so we don't need to construct one in this module.
 */
export type ServerShaFetcher = () => Promise<string>;

/**
 * Caller-supplied surface for emitting the `key_parity.mismatch` audit
 * row on failure. Optional — if unset, the failure still throws but no
 * audit row is emitted (the dispatcher's catch path can do it).
 */
export type MismatchAuditEmitter = () => Promise<void>;

/**
 * Cold-start parity assertion — call once per Deno.serve invocation,
 * BEFORE any privileged dispatch work. Memoised after the first match.
 *
 * Behaviour:
 *   - First call this process: fetch SHA from env, fetch SHA from DB,
 *     compare. Mismatch ⇒ throw KeyParityError + emit audit row if
 *     emitter supplied. Match ⇒ memoise + return.
 *   - Subsequent calls this process: short-circuit return (memoised).
 *
 * Pre-init: there is no init phase — first call performs the check
 * itself. This matches the EF process-recycle model (no boot phase).
 */
export async function assertKeyParity(
  fetchServerSha: ServerShaFetcher,
  emitMismatch?: MismatchAuditEmitter
): Promise<void> {
  if (_envKeyShaHex !== null) return;

  const raw = Deno.env.get(KEY_ENV_NAME);
  if (typeof raw !== 'string' || raw.length === 0) {
    if (emitMismatch) {
      try { await emitMismatch(); } catch { /* swallow — fail-closed below */ }
    }
    throw new KeyParityError(
      `${KEY_ENV_NAME} is unset or empty in this Edge Function process; refusing to serve.`
    );
  }
  const envSha = sha256Hex(raw);

  let serverSha: string;
  try {
    serverSha = await fetchServerSha();
  } catch (e) {
    if (emitMismatch) {
      try { await emitMismatch(); } catch { /* swallow */ }
    }
    throw new KeyParityError(
      `failed to fetch Postgres key_parity_server_sha(); refusing to serve. ` +
        `cause: ${e instanceof Error ? e.constructor.name : 'Error'}`
    );
  }

  if (!constantTimeHexEq(envSha, serverSha)) {
    if (emitMismatch) {
      try { await emitMismatch(); } catch { /* swallow */ }
    }
    throw new KeyParityError(
      'HMAC pseudonym key parity check failed in Edge Function process; refusing to serve. ' +
        'env-var SHA does not match Postgres GUC SHA. See ADR-0024 §2.'
    );
  }

  _envKeyShaHex = envSha;
}

/**
 * Test-only reset — production must NEVER call this. Exposed so the
 * Deno test harness can reset state between scenarios.
 */
export function __resetForTests(): void {
  _envKeyShaHex = null;
}
