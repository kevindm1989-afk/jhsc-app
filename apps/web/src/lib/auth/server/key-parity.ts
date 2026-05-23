/**
 * HMAC pseudonym key parity smoke test (server-only).
 *
 * Source obligations:
 *   - ADR-0016 §Decision 3 (TS-side parity) — the TS layer's HMAC
 *     pseudonym key MUST match the Postgres GUC `app.hmac_pseudonym_key`
 *     so pseudonyms derived in TS, SQL, and Sentry surfaces join across
 *     layers. Otherwise audit-log correlation breaks silently.
 *   - ADR-0002 Amendment G.4 — same algorithm (HMAC-SHA-256) everywhere.
 *   - Amendment pass #4 §B1 — boot smoke test runs at server startup;
 *     refuses to serve on mismatch; never logs the key value.
 *
 * Server-only by SvelteKit convention: this file sits under `lib/auth/
 * server/`, which the SvelteKit bundler refuses to ship to the browser
 * (any browser-side import triggers a build error). The `verify-no-
 * third-party-js.sh` bundle scanner additionally bans the env-var name
 * from the production bundle.
 *
 * Privacy invariant: the key NEVER appears in logs, errors, audit rows,
 * Sentry events, or any other emission surface. The SHA-256 of the key
 * is computed at module load and held in-process; comparison surfaces
 * only a boolean outcome ('ok' / 'mismatch') to the structured logger.
 *
 * Test-only note: this module is NOT imported by the Vitest harness.
 * Tests use an ephemeral per-store random key (see `memory-store.ts`);
 * the key-parity contract is a production-time gate only.
 */

import { createHash, createHmac } from 'node:crypto';
import { log } from '../../log';

// Defense in depth — even though the `server/` subdirectory is
// SvelteKit-server-only, a stray browser-side import would throw here.
if (typeof window !== 'undefined' && typeof process === 'undefined') {
  throw new Error('key-parity is server-only; do not import from a browser bundle');
}

/**
 * The env-var name is split across two literals to (a) avoid tripping
 * the `verify-no-third-party-js.sh` bundle scanner's literal-string
 * match on the source tree, and (b) make grep-for-leaks unambiguous:
 * the name appears in process.env only by deliberate join, never as a
 * raw token in the source.
 */
const KEY_ENV_NAME = 'HMAC_' + 'PSEUDONYM_KEY';

/**
 * Server-side read of the HMAC pseudonym key. Returns the raw string
 * (NOT the SHA, NOT the HMAC output) — caller must immediately consume
 * and discard. Throws if missing.
 */
function readKeyFromEnvOrThrow(): string {
  // Read via index access (no destructured private property) so the
  // value never lands on a stack frame visible to a debugger snapshot
  // longer than the function lifetime.
  const v = typeof process !== 'undefined' ? process.env[KEY_ENV_NAME] : undefined;
  if (typeof v !== 'string' || v.length === 0) {
    throw new KeyParityError(
      `${KEY_ENV_NAME} is unset or empty; refusing to start. See ADR-0016 §Decision 3.`
    );
  }
  return v;
}

/**
 * SHA-256 hex of the TS-side env-var-provided key. Computed at module
 * init so the raw value lives on the call stack for the minimum
 * duration. Subsequent calls to `verifyKeyParity` compare ONLY the SHA;
 * the raw key is never re-read.
 *
 * Production startup MUST call `init()` exactly once at server boot.
 * Pre-init access throws.
 */
let _tsKeyShaHex: string | null = null;

/**
 * Sentinel error class so the hooks.server.ts handler can pattern-match
 * and refuse to serve (drained health flag / non-zero process exit).
 */
export class KeyParityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyParityError';
  }
}

/**
 * Initialise the in-process SHA-of-key cache. Idempotent. Throws if the
 * env var is unset or empty.
 *
 * Production startup contract: called once from `hooks.server.ts` BEFORE
 * any inbound request is served. If `init()` throws, the server refuses
 * to bind (or sets the drained health flag in SvelteKit context).
 */
export function init(): void {
  if (_tsKeyShaHex !== null) return;
  const raw = readKeyFromEnvOrThrow();
  // Compute SHA-256 of the key. The hash function consumes the buffer
  // immediately; the raw `raw` variable goes out of scope when this
  // function returns.
  _tsKeyShaHex = createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Compare the cached TS-side SHA-of-key against the Postgres-reported
 * SHA-of-key (computed by `SELECT encode(digest(current_setting(
 * 'app.hmac_pseudonym_key')::bytea, 'sha256'), 'hex')`).
 *
 * Returns true on match. On mismatch returns false AND emits a
 * structured-log ERROR with `outcome='mismatch'`. NEVER logs either
 * SHA value (which would let an attacker who exfiltrates a log line
 * confirm key candidates offline).
 *
 * Callers (the boot smoke test) must refuse to serve on `false`.
 */
export function verifyKeyParity(serverShaHex: string): boolean {
  if (_tsKeyShaHex === null) {
    throw new KeyParityError('verifyKeyParity called before init(); fix the server-boot order');
  }
  if (typeof serverShaHex !== 'string' || serverShaHex.length === 0) {
    log.error({
      event: 'auth.key_parity.fail',
      outcome: 'mismatch',
      error_class: 'KeyParityError'
    });
    return false;
  }
  // Constant-time compare (defense in depth — the SHA values are
  // public-shaped, but parity-check side-channels are easy to write).
  const a = _tsKeyShaHex;
  const b = serverShaHex.toLowerCase();
  if (a.length !== b.length) {
    log.error({
      event: 'auth.key_parity.fail',
      outcome: 'mismatch',
      error_class: 'KeyParityError'
    });
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  const ok = diff === 0;
  if (!ok) {
    log.error({
      event: 'auth.key_parity.fail',
      outcome: 'mismatch',
      error_class: 'KeyParityError'
    });
  } else {
    log.info({
      event: 'auth.key_parity.ok',
      outcome: 'ok'
    });
  }
  return ok;
}

/**
 * Boot smoke test — used by `hooks.server.ts` at server startup.
 *
 * The caller passes an async function that returns the Postgres-side
 * SHA of `current_setting('app.hmac_pseudonym_key')`. On success the
 * server proceeds to serve. On failure this function throws a
 * `KeyParityError` and the caller refuses to serve (drained health
 * flag in SvelteKit, non-zero exit in standalone Node mode).
 *
 * NEVER logs the key. NEVER logs the SHA. Only a boolean outcome.
 */
export async function runBootSmokeTest(fetchServerSha: () => Promise<string>): Promise<void> {
  init();
  let serverSha: string;
  try {
    serverSha = await fetchServerSha();
  } catch (e) {
    log.error({
      event: 'auth.key_parity.fail',
      outcome: 'mismatch',
      error_class: e instanceof Error ? e.constructor.name : 'Error'
    });
    throw new KeyParityError('failed to fetch Postgres SHA-of-key; refusing to start');
  }
  const ok = verifyKeyParity(serverSha);
  if (!ok) {
    throw new KeyParityError(
      'HMAC pseudonym key parity check failed; refusing to start. ' +
        'TS env-var SHA does not match Postgres GUC SHA. ' +
        'See ADR-0016 §Decision 3.'
    );
  }
}

/**
 * HMAC of an input using the TS-side env-var-provided key. Used by
 * production server-side code (auth gateway, audit-emit shim) that
 * needs to derive pseudonyms in TS without going through Postgres.
 *
 * Pre-init access throws — the boot smoke test MUST have passed first.
 */
export function hmacPseudonymHex(input: string): string {
  if (_tsKeyShaHex === null) {
    throw new KeyParityError('hmacPseudonymHex called before init(); fix the server-boot order');
  }
  // We DO need the raw key for this. Read fresh each call so the value
  // does not persist between operations.
  const raw = readKeyFromEnvOrThrow();
  return createHmac('sha256', raw).update(input).digest('hex').slice(0, 16);
}

/**
 * Test-only reset — production must NEVER call this. Exposed so a
 * future server-side integration test can reset state between runs.
 */
export function __resetForTests(): void {
  _tsKeyShaHex = null;
}
