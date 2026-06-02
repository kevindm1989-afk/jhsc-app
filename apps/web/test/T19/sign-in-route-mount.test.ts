/**
 * T19.1 — /sign-in production route mount.
 *
 * Closes the mint-session sign-in loop end-to-end. Before this PR the
 * mint-session client (PR #51), signInViaMintSession orchestrator
 * (PR #52), and webauthnGetAssertion DOM wrapper (PR #53) all existed
 * as library functions but no production route called them — meaning
 * the session-jwt-store stayed empty in production and every Edge
 * Function factory's lazy `getJwt()` returned null.
 *
 * This file pins the structural contract:
 *   - The route exists at `apps/web/src/routes/sign-in/+page.svelte`.
 *   - It imports + calls `createSupabaseMintSessionClient` from the
 *     server-client factory module.
 *   - It imports `signInViaMintSession`, `webauthnGetAssertion`, and
 *     the REAL `setJwt` from `$lib/auth/session-jwt-store`.
 *   - The signIn handler passes setJwt directly to signInViaMintSession
 *     (defense-in-depth against a refactor that swaps in a no-op
 *     stub or pre-poisons the store).
 *   - The handler uses webauthnGetAssertion as the getAssertion callback
 *     (no inline `() => null` placeholder).
 *   - prerender=true + ssr=false (matches /onboarding and /settings).
 *   - noindex meta (sign-in pages are not search-indexed).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTE_DIR = resolve(__dirname, '../../src/routes/sign-in');
const PAGE_PATH = resolve(ROUTE_DIR, '+page.svelte');
const PAGE_TS_PATH = resolve(ROUTE_DIR, '+page.ts');

describe('T19.1 — /sign-in production route mount', () => {
  it('the /sign-in route exists at apps/web/src/routes/sign-in/+page.svelte', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('the route imports createSupabaseMintSessionClient from the server-client factory module', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*createSupabaseMintSessionClient[^}]*}\s+from\s+['"][^'"]*server-client\/mint-session-client-factory['"]/
    );
  });

  it('the route imports signInViaMintSession from $lib/auth/sign-in-flow', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*signInViaMintSession[^}]*}\s+from\s+['"][^'"]*lib\/auth\/sign-in-flow['"]/
    );
  });

  it('the route imports webauthnGetAssertion from $lib/auth/webauthn-assertion', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*webauthnGetAssertion[^}]*}\s+from\s+['"][^'"]*lib\/auth\/webauthn-assertion['"]/
    );
  });

  it('the route imports the REAL setJwt from lib/auth/session-jwt-store (not a no-op stub)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*setJwt[^}]*}\s+from\s+['"][^'"]*lib\/auth\/session-jwt-store['"]/
    );
    // Defense-in-depth: no inline `setJwt: () => {}` shim hiding the wiring.
    expect(src).not.toMatch(/setJwt:\s*\(\s*\)\s*=>\s*\{?\s*\}?/);
  });

  it('the signIn handler passes setJwt directly to signInViaMintSession', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // The handler should pass the imported `setJwt` as the option, NOT
    // a hardcoded shim. Defense-in-depth against a refactor that breaks
    // the wiring between the orchestrator and the session-jwt-store.
    expect(src).toMatch(/signInViaMintSession\s*\(\s*\{[\s\S]*?setJwt[\s\S]*?\}\s*\)/);
  });

  it('the signIn handler uses webauthnGetAssertion as the getAssertion callback', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Match the literal call composition so a refactor that swaps in a
    // `() => null` placeholder (or a different wrapper) breaks the test.
    expect(src).toMatch(/getAssertion:\s*\([^)]*\)\s*=>\s*webauthnGetAssertion\(/);
  });

  it('the route reads PUBLIC_SUPABASE_URL with a localhost:54321 fallback', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/env\.PUBLIC_SUPABASE_URL/);
    expect(src).toMatch(/localhost:54321/);
  });

  it('the route sets prerender=true + ssr=false (adapter-static + no SSR for PI safety)', () => {
    expect(existsSync(PAGE_TS_PATH)).toBe(true);
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*true/);
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });

  it('the route carries a noindex meta tag', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('the route does NOT forward any `__test_*` prop (ADR-0020 Decision 8: production strip)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Defense-in-depth: test-only seams must not surface in production routes.
    const testProbe = '__test_';
    expect(src.includes(testProbe)).toBe(false);
  });

  it('the route consumes visible text via t() — no raw English prose in the template (ADR-0009 / verify-i18n.sh)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Import is present.
    expect(src).toMatch(/import\s*{[^}]*\bt\b[^}]*}\s+from\s+['"]\$lib\/i18n['"]/);
    // Every state-machine label resolves via t(). Defense-in-depth against
    // a refactor that re-inlines an English string (which would re-trip
    // verify-i18n.sh in CI).
    expect(src).toMatch(/t\(['"]signIn\.title['"]\)/);
    expect(src).toMatch(/t\(['"]signIn\.intro['"]\)/);
    expect(src).toMatch(/t\(['"]signIn\.button\.idle['"]\)/);
    expect(src).toMatch(/t\(['"]signIn\.button\.signing_in['"]\)/);
    expect(src).toMatch(/t\(['"]signIn\.cancelled['"]\)/);
    // The failed-state surface uses a friendly mapped string from
    // `signIn.reason.*` (not the raw `signIn.failed` interpolation
    // that rendered server enum values to end users).
    expect(src).toMatch(/signIn\.reason\.unknown/);
    expect(src).toMatch(/t\(['"]signIn\.success['"]/);
    expect(src).toMatch(/t\(['"]signIn\.already_signed_in['"]\)/);
  });

  it('maps raw server reason codes through `signIn.reason.*` catalog keys (no raw enum surfaced)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // The route defines a closed allowlist of known reason codes and
    // resolves them via t() to a friendly sentence. Defense-in-depth
    // pin against a refactor that re-introduces raw-enum rendering.
    expect(src).toMatch(/KNOWN_REASONS/);
    expect(src).toMatch(/['"]bad_request['"]/);
    expect(src).toMatch(/['"]assertion_invalid['"]/);
    expect(src).toMatch(/['"]unknown_credential['"]/);
    expect(src).toMatch(/['"]mint_failed['"]/);
    // The friendly mapping is reactive on the state machine + the
    // lastError code.
    expect(src).toMatch(/\$:\s*friendlyError\s*=/);
    // The template renders {friendlyError} (not the raw lastError /
    // signIn.failed interpolation).
    expect(src).toMatch(/data-testid=["']sign-in-failed["'][\s\S]*?\{friendlyError\}/);
    expect(src).not.toMatch(/t\(['"]signIn\.failed['"]\s*,/);
  });

  it('every signIn.* key the route references is present in the root catalog (i18n/en-CA.json)', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.signIn).toBeDefined();
    expect(typeof catalog.signIn.title).toBe('string');
    expect(typeof catalog.signIn.intro).toBe('string');
    expect(typeof catalog.signIn.button.idle).toBe('string');
    expect(typeof catalog.signIn.button.signing_in).toBe('string');
    expect(typeof catalog.signIn.cancelled).toBe('string');
    expect(typeof catalog.signIn.success).toBe('string');
    expect(typeof catalog.signIn.already_signed_in).toBe('string');
    expect(typeof catalog.signIn.go_to_settings_cta).toBe('string');
    // The success string still uses {sessionId} interpolation.
    expect(catalog.signIn.success).toMatch(/\{sessionId\}/);
    // Each of the five friendly-reason strings is present.
    expect(catalog.signIn.reason).toBeDefined();
    expect(typeof catalog.signIn.reason.bad_request).toBe('string');
    expect(typeof catalog.signIn.reason.assertion_invalid).toBe('string');
    expect(typeof catalog.signIn.reason.unknown_credential).toBe('string');
    expect(typeof catalog.signIn.reason.mint_failed).toBe('string');
    expect(typeof catalog.signIn.reason.unknown).toBe('string');
  });

  it('the sign-in success message is a polite live region (role="status") so SR users hear "Session established"', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // The success paragraph announces when the WebAuthn ceremony
    // resolves OK. role="status" is the polite live-region pattern;
    // assertive (role="alert") is reserved for the `failed` state
    // where the server rejects the user's assertion. Defense against
    // a refactor that drops the live region (which would leave SR
    // users without audio confirmation of sign-in completion).
    expect(src).toMatch(
      /<p\s+role=["']status["']\s+data-testid=["']sign-in-success["']/
    );
  });

  it('the sign-in cancelled message is a polite live region (role="status"), not assertive (alert)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Cancellation is user-initiated (the user dismissed the WebAuthn
    // prompt). The user already knows what they did; per ARIA
    // conventions, polite is correct. assertive (role="alert") would
    // interrupt other speech for a non-error outcome. Defense pin
    // against a refactor that flips this back to role="alert".
    expect(src).toMatch(
      /<p\s+role=["']status["']\s+data-testid=["']sign-in-cancelled["']/
    );
    // The failed message (genuine server-side rejection) stays
    // role="alert" — that's an interruption-worthy outcome.
    expect(src).toMatch(
      /<p\s+role=["']alert["']\s+data-testid=["']sign-in-failed["']/
    );
  });

  it('the signed-in state surfaces a /settings link so the user has somewhere to go after sign-in', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // The CTA link is rendered ONLY in the signed-in state — it lives
    // inside the same {#if isSignedIn} block as the success / already-
    // signed-in messages. Defense-in-depth against a refactor that
    // surfaces the link in the idle / failed states (which would let an
    // unauthed user click through to /settings without any session).
    expect(src).toMatch(/<a\s+href=["']\/settings["']/);
    expect(src).toMatch(/data-testid=["']sign-in-go-to-settings["']/);
    expect(src).toMatch(/t\(['"]signIn\.go_to_settings_cta['"]\)/);
  });

  it('the route reactively tracks JWT state via the $isSignedIn store wrapper (PR #63 migration)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // PR #63 introduced `$lib/auth/session-jwt-svelte` as a Svelte
    // readable wrapper. /sign-in consumes `$isSignedIn` from it —
    // a user with an existing session sees the "already signed in"
    // affordance instead of a re-ceremony button. A side-channel
    // clear (panic-wipe, 401, cross-tab broadcast) flips back to
    // the idle sign-in state through the same store.
    expect(src).toMatch(
      /import\s*{[^}]*isSignedIn[^}]*}\s+from\s+['"][^'"]*lib\/auth\/session-jwt-svelte['"]/
    );
    // The template branches on the auto-subscribed `$isSignedIn`.
    expect(src).toMatch(/\{#if\s+\$isSignedIn\}/);
  });

  it('the route no longer hand-rolls subscribeToJwt + onDestroy (wrapper owns the lifecycle now)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Regression guard against re-adding the manual subscriber pattern,
    // which would double-subscribe (the wrapper already subscribes) and
    // leak listeners.
    expect(src).not.toMatch(
      /import\s*{[^}]*subscribeToJwt[^}]*}\s+from\s+['"][^'"]*session-jwt-store['"]/
    );
    expect(src).not.toMatch(/subscribeToJwt\s*\(/);
  });

  it('the signIn handler short-circuits when already signed in (defense against double-ceremony)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // The handler must check $isSignedIn before kicking off a fresh
    // ceremony — otherwise a stale button + a race could replace a
    // valid session with a new one. The UI also hides the button when
    // $isSignedIn, but the handler-level guard is defense-in-depth.
    expect(src).toMatch(/if\s*\([^)]*\$isSignedIn[^)]*\)\s*return/);
  });

  it('clearing the JWT also clears the stale sessionId so a successful sign-in message cannot survive sign-out', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Defense-in-depth: when an external channel clears the JWT, a
    // reactive `$:` declaration resets sessionId so the success
    // message doesn't linger past the sign-out.
    expect(src).toMatch(/\$:\s*if\s*\(\s*!\$isSignedIn\s*\)\s*sessionId\s*=\s*['"]['"]/);
  });

  it('renders an "already signed in" notice when isSignedIn is true at mount but sessionId is empty', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']sign-in-already-signed-in["']/);
    expect(src).toMatch(/t\(['"]signIn\.already_signed_in['"]\)/);
  });

  it('the <section> carries aria-busy that tracks the signing-in state (form-level a11y pattern)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Mirrors the form-level pattern used by ConcernIntakeForm +
    // ReprisalIntakeForm: while the WebAuthn ceremony is in flight,
    // AT users get an aria-busy announcement on the wrapping
    // container. The /sign-in route has no <form> element so the
    // <section> is the nearest analog.
    expect(src).toMatch(
      /<section\s+aria-busy=\{\s*state\s*===\s*['"]signing-in['"]\s*\?\s*['"]true['"]\s*:\s*['"]false['"]\s*\}/
    );
  });
});
