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
  ? sequence(Sentry.sentryHandle(), requestIdHandle)
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
