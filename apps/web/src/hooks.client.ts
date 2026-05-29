/**
 * Client-side hooks.
 *
 * Sentry SDK is initialised here per ADR-0010 (Sentry SaaS EU + strict
 * SDK-layer scrubbing) and its amendment (no tracing in Phase 0; release
 * + environment + scrubber wired so the SaaS round-trip is verifiable).
 *
 * Hard rules enforced in this file:
 *   - Bundled `@sentry/sveltekit` import only â€” never the CDN
 *     (JHSC-APP-PLAN.md Â§7 / ADR-0010 amendment).
 *   - `beforeSend` / `beforeBreadcrumb` come from
 *     `$lib/observability/sentry-scrub` (the canonical scrubber; tested
 *     under T02 / sentry-scrub.test.ts).
 *   - No `Sentry.setUser({ id: rawUserId })` â€” only the scrub module's
 *     pseudonym hash ever flows; the browser does not call setUser.
 *   - `tracesSampleRate: 0` per ADR-0010 amendment F-H (Phase-0 deferral).
 *   - If `PUBLIC_SENTRY_DSN` is undefined (local dev without DSN),
 *     Sentry.init is NOT called â€” the structured logger remains the
 *     emission surface and Sentry self-test failing is the expected dev
 *     state.
 */
import * as Sentry from '@sentry/sveltekit';
import type { HandleClientError } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { beforeSend, beforeBreadcrumb } from '$lib/observability/sentry-scrub';
import { log } from '$lib/log';
import { assertArgon2idAvailable } from '$lib/crypto/recovery-blob';
import { getJwt } from '$lib/auth/session-jwt-store';
import {
  createPanicWipeAuditEmitter,
  createSupabaseT07Client
} from '$lib/server-client/t07-client-factory';
import { setDefaultStoreAuditEmitter } from '$lib/lock/panic-wipe';

// Read at runtime (not build time) so the build works without a .env present.
const PUBLIC_SENTRY_DSN = env.PUBLIC_SENTRY_DSN;

const RELEASE = (import.meta.env.VITE_RELEASE_SHA as string | undefined) ?? 'unknown';
const ENVIRONMENT = (import.meta.env.MODE as string | undefined) ?? 'development';

// G-T07-12 boot-time fail-fast: if libsodium's Argon2id (`crypto_pwhash`) is
// unavailable the recovery-blob path would silently fall through to an
// inferior KDF — fail at boot instead. The assertion is async; we fire it
// without blocking module load and route any rejection through the
// structured logger + Sentry (when wired) so the deployment-config bug is
// loud at first paint, not at first recovery-blob write.
assertArgon2idAvailable().catch((err) => {
  const error_class =
    err && typeof err === 'object' && 'constructor' in err
      ? (err as { constructor: { name: string } }).constructor.name
      : 'Error';
  log.error({ event: 'boot.argon2id_unavailable', error_class });
});

// G-T19-11 production wire-up: register the `panic_wipe.invoked` audit
// emitter for the default `BrowserWipeStore` singleton in `panic-wipe.ts`
// so any production `panicWipe()` call that uses the default-store path
// (today: /onboarding's D.6 panic-wipe modal, plus any future surface
// that doesn't construct its own `wipeStore`) routes through a real
// transport instead of fail-closing at the audit precondition.
//
// The PUBLIC_SUPABASE_URL env var is read at runtime so a missing var in
// local dev still boots (the transport then consistently surfaces
// status 0 / unknown, which BrowserWipeStore's emitAudit catches as
// `{ok: false}` — preserving the F-53 audit-before-side-effect contract
// in mis-configured deployments).
//
// The JWT provider closure-references the session-jwt-store, so a
// freshly-minted JWT after sign-in is picked up without rebuilding the
// client. Before sign-in completes `getJwt()` returns null, and the
// server's `session_is_live()` gate denies the call (401 rls_denied) —
// which surfaces as audit_failed at the wipe site, again preserving the
// audit-before-side-effect contract.
const __defaultPanicWipeClient = createSupabaseT07Client({
  baseUrl: env.PUBLIC_SUPABASE_URL ?? 'http://localhost:54321',
  getJwt
});
setDefaultStoreAuditEmitter(createPanicWipeAuditEmitter(__defaultPanicWipeClient));

if (PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: PUBLIC_SENTRY_DSN,
    release: RELEASE,
    environment: ENVIRONMENT,
    // ADR-0010 amendment F-H: no distributed tracing in Phase 0.
    tracesSampleRate: 0,
    // ADR-0010: SDK-layer PI scrubbing. The scrub module is the canonical
    // contract â€” these hooks are thin adapters whose signatures match
    // Sentry's runtime types.
    beforeSend: (event) => beforeSend(event as Parameters<typeof beforeSend>[0]) as typeof event,
    beforeBreadcrumb: (breadcrumb) =>
      beforeBreadcrumb(breadcrumb as Parameters<typeof beforeBreadcrumb>[0]) as typeof breadcrumb,
    // No default integrations that would re-add tracing or session replay.
    defaultIntegrations: false
  });
}

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
  if (PUBLIC_SENTRY_DSN) {
    Sentry.captureException(error);
  }
  return {
    message: 'CLIENT_ERROR',
    code: 'CLIENT_ERROR'
  };
};
