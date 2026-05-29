/**
 * T19.1 — hooks.client.ts wires setDefaultStoreAuditEmitter at boot.
 *
 * Pins the production-wire-up contract added in this PR:
 *
 *   - `hooks.client.ts` imports `setDefaultStoreAuditEmitter` from
 *     `$lib/lock/panic-wipe` AND `createPanicWipeAuditEmitter` +
 *     `createSupabaseT07Client` from `$lib/server-client/t07-client-factory`
 *     AND `getJwt` from `$lib/auth/session-jwt-store`.
 *   - It calls `setDefaultStoreAuditEmitter(createPanicWipeAuditEmitter(...))`
 *     so the default-store path (`panicWipe()` with no `opts.store`) routes
 *     through a real audit transport in production instead of fail-closing
 *     at the audit precondition (G-T19-11).
 *   - It reads the Supabase URL from `env.PUBLIC_SUPABASE_URL` with a
 *     `localhost:54321` fallback (matches the same pattern in
 *     `/settings/+page.svelte`).
 *
 * We do NOT import-and-run `hooks.client.ts` here — its module-load side
 * effects (Sentry init, libsodium boot assertion, etc.) need a SvelteKit
 * environment. The structural assertions are source-grep style, same
 * pattern as `onboarding-route-mount.test.ts` and `settings-route-mount.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOOKS_PATH = resolve(__dirname, '../../src/hooks.client.ts');

describe('T19.1 — hooks.client.ts wires setDefaultStoreAuditEmitter', () => {
  it('hooks.client.ts exists at the expected path', () => {
    expect(existsSync(HOOKS_PATH)).toBe(true);
  });

  it('imports setDefaultStoreAuditEmitter from $lib/lock/panic-wipe', () => {
    const src = readFileSync(HOOKS_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*setDefaultStoreAuditEmitter[^}]*}\s+from\s+['"]\$lib\/lock\/panic-wipe['"]/
    );
  });

  it('imports setPostWipeCleanup from $lib/lock/panic-wipe (G-T19-14 in-memory JWT teardown)', () => {
    const src = readFileSync(HOOKS_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*setPostWipeCleanup[^}]*}\s+from\s+['"]\$lib\/lock\/panic-wipe['"]/
    );
  });

  it('calls setPostWipeCleanup(clearJwt) at top-level so the in-memory JWT is wiped in lockstep', () => {
    const src = readFileSync(HOOKS_PATH, 'utf8');
    expect(src).toMatch(/setPostWipeCleanup\s*\(\s*clearJwt\s*\)/);
  });

  it('imports createSupabaseT07Client + createPanicWipeAuditEmitter from $lib/server-client/t07-client-factory', () => {
    const src = readFileSync(HOOKS_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*createSupabaseT07Client[^}]*}\s+from\s+['"]\$lib\/server-client\/t07-client-factory['"]/
    );
    expect(src).toMatch(
      /import\s*{[^}]*createPanicWipeAuditEmitter[^}]*}\s+from\s+['"]\$lib\/server-client\/t07-client-factory['"]/
    );
  });

  it('imports getJwt from $lib/auth/session-jwt-store (lazy JWT resolution)', () => {
    const src = readFileSync(HOOKS_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*getJwt[^}]*}\s+from\s+['"]\$lib\/auth\/session-jwt-store['"]/
    );
  });

  it('calls setDefaultStoreAuditEmitter(createPanicWipeAuditEmitter(...)) at top-level', () => {
    const src = readFileSync(HOOKS_PATH, 'utf8');
    // The call appears at module top-level (not inside a function/block
    // that wouldn't execute at boot). We assert the literal call
    // composition; defense-in-depth against a refactor that wires the
    // emitter via a closure-captured handle instead.
    expect(src).toMatch(
      /setDefaultStoreAuditEmitter\s*\(\s*createPanicWipeAuditEmitter\s*\(/
    );
  });

  it('reads PUBLIC_SUPABASE_URL with a localhost:54321 fallback (matches /settings)', () => {
    const src = readFileSync(HOOKS_PATH, 'utf8');
    expect(src).toMatch(/env\.PUBLIC_SUPABASE_URL/);
    expect(src).toMatch(/localhost:54321/);
  });

  it('uses the session-jwt-store getJwt directly (no `() => null` placeholder)', () => {
    const src = readFileSync(HOOKS_PATH, 'utf8');
    // The factory takes { getJwt }; we should pass the imported `getJwt`
    // function directly, NOT a hardcoded `() => null`.
    expect(src).toMatch(/getJwt\s*[,}]/);
    expect(src).not.toMatch(/getJwt:\s*\(\s*\)\s*=>\s*null/);
  });

  it('imports clearJwt from $lib/auth/session-jwt-store (revocation-loop closure)', () => {
    const src = readFileSync(HOOKS_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*clearJwt[^}]*}\s+from\s+['"]\$lib\/auth\/session-jwt-store['"]/
    );
  });

  it('passes clearJwt as onSessionRevoked so 401 from t07-op clears the in-memory JWT', () => {
    const src = readFileSync(HOOKS_PATH, 'utf8');
    // The factory takes { onSessionRevoked }; we should pass the imported
    // `clearJwt` directly. Defense-in-depth against a refactor that
    // accidentally swaps it for `() => {}` or drops the option entirely.
    expect(src).toMatch(/onSessionRevoked:\s*clearJwt/);
  });
});

describe('T19.1 — hooks.client.ts boot-argon2id catch routes through Sentry', () => {
  // The assertArgon2idAvailable().catch arrow body has nested braces
  // (the `if (PUBLIC_SENTRY_DSN) { ... }` guard inside), so we walk
  // from after the `.catch(` open-paren to its matching `)` by hand —
  // a single regex would either over-match or stop at the inner `}`.
  function readArgon2idCatchBody(src: string): string {
    const marker = '.catch(';
    const catchAt = src.indexOf('assertArgon2idAvailable().catch(');
    expect(catchAt).toBeGreaterThanOrEqual(0);
    const openParen = catchAt + 'assertArgon2idAvailable()'.length + marker.length - 1;
    let depth = 1;
    let i = openParen + 1;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return src.slice(openParen, i + 1);
      }
      i++;
    }
    throw new Error('unterminated catch arrow');
  }

  it('the assertArgon2idAvailable catch handler calls Sentry.captureException(err)', () => {
    const src = readFileSync(HOOKS_PATH, 'utf8');
    // The catch handler's contract per the header: "route any rejection
    // through the structured logger + Sentry (when wired)". Before this
    // contract pin only `log.error` ran, leaving the documented Sentry
    // hop unimplemented. Defense-in-depth pin against regression.
    const body = readArgon2idCatchBody(src);
    expect(body).toMatch(/Sentry\.captureException\s*\(\s*err\s*\)/);
  });

  it('the Sentry.captureException call is gated on PUBLIC_SENTRY_DSN (no-op in local dev without DSN)', () => {
    const src = readFileSync(HOOKS_PATH, 'utf8');
    // Same posture as handleError: the Sentry call sits inside a
    // PUBLIC_SENTRY_DSN guard so local dev without a DSN doesn't trigger
    // an attempted SaaS round-trip.
    const body = readArgon2idCatchBody(src);
    expect(body).toMatch(
      /if\s*\(\s*PUBLIC_SENTRY_DSN\s*\)\s*\{[\s\S]*?Sentry\.captureException/
    );
  });

  it('log.error still fires (Sentry capture is additive, not a replacement)', () => {
    const src = readFileSync(HOOKS_PATH, 'utf8');
    const body = readArgon2idCatchBody(src);
    // The log.error call is the dev-environment signal (no Sentry DSN
    // wired locally). Both channels run in production.
    expect(body).toMatch(/log\.error\(\{\s*event:\s*['"]boot\.argon2id_unavailable['"]/);
  });
});
