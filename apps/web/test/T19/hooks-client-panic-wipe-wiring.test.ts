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
