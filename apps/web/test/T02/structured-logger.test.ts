/**
 * T02 — Structured logger contract tests.
 *
 * Source obligations:
 *   - observability/logging.md §2 (event schema), §3 (safeFields allowlist),
 *     §4 (Edge Function logging rules), §6 (correlation), §7 (CI enforcement).
 *   - ADR-0010 Amendment F-D Rule 2 (scrubbing at emit, no downstream
 *     pipeline; unknown keys dropped; CI WARN raised in test).
 *   - .context/threat-model.md §3.1 F-09 (Edge Function log scrubbing) /
 *     §8 T02 (semgrep ban on Sentry.captureException extras).
 *   - observability/README.md §11.4 (structured logger drops unknown fields).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { log, type LogLine } from '../../src/lib/log';
import {
  CANARY_PII_X,
  CANARY_EMAIL,
  CANARY_PHONE_E164,
  SYNTHETIC_DISPLAY_NAME,
} from '../_helpers/fixtures';
import { freezeClock, restoreClock } from '../_helpers/clock';

// The logger SHOULD expose a sink override for tests that captures every
// emitted JSON-line in-process (no real network).
import { __setTestSink, __getCapturedLines, __resetCapture } from '../../src/lib/log/test-sink';

describe('T02 / observability-logging.md — structured logger contract', () => {
  beforeEach(() => {
    freezeClock();
    __resetCapture();
    __setTestSink();
  });
  afterEach(() => {
    restoreClock();
  });

  // --- Schema completeness ---------------------------------------------

  it('T02 / logging.md §2 — every emitted line carries required fields {ts, level, service, env, release, event}', () => {
    log.info({ event: 'auth.passkey.assert', auth: { method: 'passkey', result: 'success' } });
    const lines = __getCapturedLines();
    expect(lines.length).toBe(1);
    const line = lines[0];
    expect(line.ts).toBeDefined();
    expect(line.level).toBe('INFO');
    expect(line.service).toBeDefined();
    expect(line.env).toBeDefined();
    expect(line.release).toBeDefined();
    expect(line.event).toBe('auth.passkey.assert');
  });

  // --- safeFields allowlist (load-bearing) -----------------------------

  it('T02 / logging.md §3 / observability-README §11.4 — silently drops unknown attribute keys at emit', () => {
    log.info({
      event: 'auth.passkey.assert',
      attributes: {
        // unknown / forbidden key:
        leaked_secret: 'never-allowed',
        // allowed:
        latency_ms: 42,
      } as any,
    });
    const lines = __getCapturedLines();
    expect(lines.length).toBe(1);
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain('leaked_secret');
    expect(serialized).not.toContain('never-allowed');
    expect(serialized).toContain('latency_ms');
  });

  it('T02 / ADR-0010 Amendment F-D Rule 2 — unknown key drop ALSO raises a CI-visible WARN in test env', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    log.info({
      event: 'auth.passkey.assert',
      attributes: { not_on_allowlist: 'x' } as any,
    });
    // The logger must surface dropped-unknown-key as a WARN in CI/test env
    // so callers fix the call site, not hide the leak.
    expect(warnSpy).toHaveBeenCalled();
    const args = warnSpy.mock.calls.map((c) => JSON.stringify(c)).join('|');
    expect(args).toMatch(/not_on_allowlist|safeFields|unknown/i);
    warnSpy.mockRestore();
  });

  // --- PI key blackhole (denylist) -------------------------------------

  it('T02 / logging.md §2 forbidden fields — never emits keys from the PI denylist (display_name, email, phone)', () => {
    log.info({
      event: 'concern.create',
      attributes: {
        display_name: SYNTHETIC_DISPLAY_NAME,
        email: CANARY_EMAIL,
        phone: CANARY_PHONE_E164,
      } as any,
    });
    const serialized = JSON.stringify(__getCapturedLines()[0]);
    expect(serialized).not.toContain(SYNTHETIC_DISPLAY_NAME);
    expect(serialized).not.toContain(CANARY_EMAIL);
    expect(serialized).not.toContain(CANARY_PHONE_E164);
    expect(serialized).not.toContain('display_name');
    expect(serialized).not.toContain('email');
    expect(serialized).not.toContain('phone');
  });

  it('T02 / logging.md §2 — does NOT emit raw user_id / supabase_uid / sub / auth_uid (only actor_pseudonym permitted server-side)', () => {
    log.info({
      event: 'session.revoked',
      // Caller mistakenly passes raw IDs.
      attributes: {
        user_id: '9f4e9b40-0000-4000-8000-00000000000a',
        supabase_uid: '9f4e9b40-0000-4000-8000-00000000000a',
        sub: '9f4e9b40-0000-4000-8000-00000000000a',
      } as any,
    });
    const serialized = JSON.stringify(__getCapturedLines()[0]);
    expect(serialized).not.toContain('9f4e9b40-0000-4000-8000-00000000000a');
    expect(serialized).not.toContain('"user_id"');
    expect(serialized).not.toContain('"supabase_uid"');
    expect(serialized).not.toContain('"sub"');
  });

  // --- request_id propagation (F-D Rule 3) ------------------------------

  it('T02 / ADR-0010 Amendment F-D Rule 3 — request_id propagates through the line when provided', () => {
    const rid = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';
    log.info({ event: 'auth.passkey.assert', request_id: rid });
    const line = __getCapturedLines()[0];
    expect(line.request_id).toBe(rid);
  });

  // --- DEBUG excluded from prod ----------------------------------------

  it('T02 / logging.md §1 / §7 rule 4 — log.debug() emits in dev but is build-time excluded from prod', () => {
    // In test env, debug emits to capture sink.
    log.debug({ event: 'dev.event' });
    expect(__getCapturedLines().length).toBe(1);

    // In prod env, debug must be a no-op. The implementer wires this via
    // a build-time `if (DEV)` guard; we simulate by setting NODE_ENV.
    __resetCapture();
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    log.debug({ event: 'prod.event' });
    expect(__getCapturedLines().length).toBe(0);
    process.env.NODE_ENV = origEnv;
  });

  // --- error_class vs error_message ------------------------------------

  it('T02 / logging.md §2 — log.error captures error_class only; the .message is dropped (may carry PI)', () => {
    log.error({
      event: 'auth.failed',
      error_class: 'AuthFailedError',
      // implementer must NOT propagate err.message even if caller passes it
      // (PI may live in the message).
      attributes: { message: `invalid email ${CANARY_EMAIL}` } as any,
    });
    const line = __getCapturedLines()[0];
    expect(line.error_class).toBe('AuthFailedError');
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain(CANARY_EMAIL);
  });

  // --- Canary plant in attributes survives nothing ----------------------

  it('T02 / threat-model §8 T02 canary contract — CANARY_PII_X submitted as a free-form value never leaves the logger', () => {
    log.info({
      event: 'concern.create',
      attributes: { hazard_class: CANARY_PII_X } as any,
    });
    const serialized = JSON.stringify(__getCapturedLines()[0] ?? {});
    expect(serialized).not.toContain(CANARY_PII_X);
  });

  // --- Determinism: identical input → identical output ------------------

  it('T02 / determinism — identical input across two emits yields identical lines (modulo ts which is frozen)', () => {
    log.info({ event: 'auth.passkey.assert', request_id: 'rid-1' });
    log.info({ event: 'auth.passkey.assert', request_id: 'rid-1' });
    const [a, b] = __getCapturedLines();
    expect(a).toEqual(b);
  });
});

// ============================================================================
// Edge Function logger — F-09 / ADR-0010 Amendment F-D Rule 1.
// Lives in supabase/functions/_shared/log.ts; tested separately via Deno.
// This Vitest test asserts the shape of the shared safeFields module so
// the browser + edge surfaces stay aligned.
// ============================================================================

describe('T02 / F-09 / logging.md §4 — shared safeFields contract', () => {
  it('T02 / F-09 — every Edge Function MUST import the shared logger (no direct console.log allowed in supabase/functions/)', async () => {
    // The static enforcement is a semgrep rule (logging.md §7 rule 2).
    // The runtime smoke check: importing the shared module from a test
    // that simulates an Edge Function context returns a function with
    // the same exported shape as the browser logger.
    const edgeLog = await import('../../../supabase/functions/_shared/log');
    expect(typeof edgeLog.log.info).toBe('function');
    expect(typeof edgeLog.log.warn).toBe('function');
    expect(typeof edgeLog.log.error).toBe('function');
    // Same allowlist module is imported by browser + edge — proves a
    // single source of truth for safeFields.
    expect(edgeLog.SAFE_FIELDS_ALLOWLIST_ID).toBe(
      (await import('../../src/lib/log/safe-fields')).SAFE_FIELDS_ALLOWLIST_ID
    );
  });
});
