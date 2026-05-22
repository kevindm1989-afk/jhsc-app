/**
 * Server-side hooks.
 *
 * Per observability/logging.md §6 (correlation):
 *   - Read or generate a request_id (UUIDv4).
 *   - Propagate it to Edge Functions via the X-Request-ID header.
 *   - Return it in the response so the browser can log its tail under
 *     the same id.
 *
 * Sentry SDK is added by T02 implementer; this file leaves a hook for
 * that wiring without importing the SDK at scaffold time.
 */
import type { Handle, HandleServerError } from '@sveltejs/kit';
import { log } from '$lib/log';

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

export const handle: Handle = async ({ event, resolve }) => {
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
  return {
    message: 'SERVER_ERROR',
    code: 'SERVER_ERROR',
    request_id: event.locals.request_id
  };
};
