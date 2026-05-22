/**
 * Client-side hooks.
 *
 * Sentry client init is intentionally NOT wired here at scaffold time —
 * the Sentry SDK is added by T02 implementer. When wired, it MUST:
 *   - Use the bundled npm `@sentry/sveltekit` import (NEVER the CDN per
 *     JHSC-APP-PLAN.md §7).
 *   - Install the `beforeSend` / `beforeBreadcrumb` hooks from
 *     `$lib/observability/sentry-scrub`.
 *   - NEVER call `Sentry.setUser` on the browser (ADR-0010).
 *
 * This file currently only sets up a minimal error handler that routes to
 * the structured logger so failures are visible during development.
 */
import type { HandleClientError } from '@sveltejs/kit';
import { log } from '$lib/log';

export const handleError: HandleClientError = ({ error, event }) => {
  const error_class =
    error && typeof error === 'object' && 'constructor' in error
      ? (error as { constructor: { name: string } }).constructor.name
      : 'Error';
  log.error({
    event: 'client.unhandled',
    error_class,
    route: event.route.id ?? '/'
  });
  return {
    message: 'CLIENT_ERROR',
    code: 'CLIENT_ERROR'
  };
};
