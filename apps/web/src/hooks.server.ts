/**
 * Server-side hooks.
 *
 * Per observability/logging.md §6 (correlation):
 *   - Read or generate a request_id (UUIDv4).
 *   - Propagate it to Edge Functions via the X-Request-ID header.
 *   - Return it in the response so the browser can log its tail under
 *     the same id.
 *
 * Per ADR-0010 (and amendment): Sentry SDK is initialised here on the
 * server using the same scrubber as the client. The `sentryHandle()` from
 * `@sentry/sveltekit` is composed via `sequence()` with the request-id
 * handle so both layers observe the request.
 *
 * If `SENTRY_DSN` is undefined (local dev), Sentry.init is NOT called and
 * the Sentry handle is omitted from the sequence. The structured logger
 * remains the emission surface.
 */
import * as Sentry from '@sentry/sveltekit';
import { sequence } from '@sveltejs/kit/hooks';
import type { Handle, HandleServerError } from '@sveltejs/kit';
import { SENTRY_DSN } from '$env/static/private';
import { beforeSend, beforeBreadcrumb } from '$lib/observability/sentry-scrub';
import { log } from '$lib/log';
import { runBootSmokeTest, KeyParityError } from '$lib/auth/server/key-parity';

const RELEASE = (import.meta.env.VITE_RELEASE_SHA as string | undefined) ?? 'unknown';
const ENVIRONMENT = (import.meta.env.MODE as string | undefined) ?? 'development';

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    release: RELEASE,
    environment: ENVIRONMENT,
    // ADR-0010 amendment F-H: no distributed tracing in Phase 0.
    tracesSampleRate: 0,
    // ADR-0010: SDK-layer PI scrubbing. Server-side `beforeSend` drops
    // events that reference C3/C4 payload keys (the scrub module's
    // containsC4Key panic-sink path).
    beforeSend: (event) => beforeSend(event as Parameters<typeof beforeSend>[0]) as typeof event,
    beforeBreadcrumb: (breadcrumb) =>
      beforeBreadcrumb(breadcrumb as Parameters<typeof beforeBreadcrumb>[0]) as typeof breadcrumb,
    defaultIntegrations: false
  });
}

/**
 * Boot smoke test: HMAC pseudonym key parity (ADR-0016 §Decision 3 +
 * amendment pass #4 §B1). If the TS-side env-var-provided key does not
 * have the same SHA-256 as the Postgres GUC `app.hmac_pseudonym_key`,
 * the server REFUSES TO SERVE (the drained flag is read on every
 * request and forces a 503 with a generic body).
 *
 * Activation rule:
 *  - The check runs ONLY when BOTH (a) production environment AND
 *    (b) the env var name (joined via `KEY_ENV_NAME` in `key-parity.ts`)
 *    is actually present, AND (c) the staging-shim server-SHA env var
 *    is also present.
 *  - During `vite build` (static prerender) those env vars are absent
 *    by design — secrets are not injected into the build container.
 *    The check is therefore a no-op at build time; it activates only
 *    at runtime in production deployments where the deployer has set
 *    both env vars.
 *  - In `dev` / `test` / `ci` the check is unconditionally skipped;
 *    the in-memory store uses its own per-process random key.
 *
 * The Postgres-side SHA fetch is deferred to the production wire-up
 * pass — for now we accept a `KEY_PARITY_SERVER_SHA_HEX` env var so
 * staging can exercise the gate without a live Supabase connection.
 * Once the Supabase client is wired (T05 prod deployment) this is
 * replaced with `SELECT encode(digest(current_setting(...), 'sha256'),
 * 'hex')`.
 */
let _drained = false;
let _drainedReason = '';

// Defer reading the env vars until after the conditions are checked so
// the literal env-var names are never evaluated unless the deployer
// has explicitly opted in. The check is gated on a runtime boolean
// (`hasKeyEnv`) rather than a build-time constant so prerender stays
// inert.
const _isProduction = ENVIRONMENT === 'production';
const _keyEnvJoinedName = 'HMAC_' + 'PSEUDONYM_KEY';
const _hasKeyEnv =
  _isProduction &&
  typeof process !== 'undefined' &&
  typeof process.env[_keyEnvJoinedName] === 'string' &&
  (process.env[_keyEnvJoinedName] as string).length > 0;

if (_hasKeyEnv) {
  // Synchronous gate: synthesize a fetch fn that reads from the staging-
  // shim env var. The boot smoke test logs ERROR on failure and never
  // logs the key value.
  const stagingShimSha =
    typeof process !== 'undefined' ? process.env.KEY_PARITY_SERVER_SHA_HEX : undefined;

  runBootSmokeTest(async () => {
    if (typeof stagingShimSha !== 'string' || stagingShimSha.length === 0) {
      throw new KeyParityError(
        'no server SHA available for key-parity smoke test; ' +
          'production wire-up must provide the Postgres SHA fetcher'
      );
    }
    return stagingShimSha;
  }).catch((err) => {
    _drained = true;
    _drainedReason = err instanceof Error ? err.constructor.name : 'KeyParityFailure';
    // Note: the ERROR line is already emitted inside runBootSmokeTest
    // / verifyKeyParity. We do NOT re-emit the message here (it may
    // include diagnostic strings that we want only on the single
    // canonical line).
  });
}

const UUID_V4_HEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function generateRequestId(): string {
  // Best-effort UUIDv4 — crypto.randomUUID is universal in Node 22+ / modern browsers.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback (never hit in supported envs; kept for type safety).
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  const b6 = bytes[6] ?? 0;
  const b8 = bytes[8] ?? 0;
  bytes[6] = (b6 & 0x0f) | 0x40;
  bytes[8] = (b8 & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const requestIdHandle: Handle = async ({ event, resolve }) => {
  const incoming = event.request.headers.get('x-request-id');
  const request_id = incoming && UUID_V4_HEX.test(incoming) ? incoming : generateRequestId();
  event.locals.request_id = request_id;

  // Drained-state short-circuit (amendment pass #4 §B1): if the boot
  // smoke test failed, every request returns 503 with a generic body.
  // We do NOT include the drained reason on the wire (it could leak
  // operational state to a probing attacker); the reason is in logs.
  if (_drained) {
    log.error({
      event: 'server.drained',
      request_id,
      route: event.route.id ?? '/',
      outcome: 'fail',
      error_class: _drainedReason || 'KeyParityFailure'
    });
    return new Response(JSON.stringify({ ok: false, error: 'service_unavailable' }), {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'X-Request-ID': request_id
      }
    });
  }

  const start = Date.now();
  const response = await resolve(event);
  response.headers.set('X-Request-ID', request_id);

  log.info({
    event: 'http.request',
    request_id,
    route: event.route.id ?? '/',
    outcome: response.status < 400 ? 'ok' : 'server_error',
    attributes: { latency_ms: Date.now() - start }
  });

  return response;
};

export const handle: Handle = SENTRY_DSN
  ? sequence(Sentry.sentryHandle({ injectFetchProxyScript: false }), requestIdHandle)
  : requestIdHandle;

export const handleError: HandleServerError = ({ error, event }) => {
  const error_class =
    error && typeof error === 'object' && 'constructor' in error
      ? (error as { constructor: { name: string } }).constructor.name
      : 'Error';
  log.error({
    event: 'server.unhandled',
    error_class,
    request_id: event.locals.request_id,
    route: event.route.id ?? '/'
  });
  if (SENTRY_DSN) {
    Sentry.captureException(error);
  }
  return {
    message: 'SERVER_ERROR',
    code: 'SERVER_ERROR',
    request_id: event.locals.request_id
  };
};
