/**
 * T16 / G-T16-PRIV-3 — operator-side structured Error logging.
 *
 * The retention sweep returns a closed-literal `error_code` to the caller
 * (F-67: no PI in error paths). Before this change the underlying thrown
 * Error was swallowed entirely, leaving operators with no signal to
 * diagnose WHY a sweep failed. G-T16-PRIV-3 routes the swallowed Error to
 * the server-side structured-log sink as a CLASS-ONLY line — the JS
 * constructor name, never the `.message` (which may carry PI from a failed
 * delete batch).
 *
 * This file is a NEW test (existing T16 tests are read-only per
 * test-plan.md §6). It installs the structured-log test sink and asserts:
 *   1. the emit-failure path emits exactly one operator-log ERROR line;
 *   2. that line carries `error_class` (constructor name) + a closed-literal
 *      `outcome`, and NO PI-shaped fields;
 *   3. the client-facing result is unchanged (still the closed-literal
 *      `error_code`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { FROZEN_NOW_MS } from '../_helpers/fixtures';
import { runRetentionPass } from '../../src/lib/retention';
import {
  MemoryRetentionStore,
  type TestRetentionStore
} from '../../src/lib/retention/memory-retention-store';
import { __setTestSink, __resetCapture, __getCapturedLines } from '../../src/lib/log/test-sink';
import type { LogLine } from '../../src/lib/log';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeStore(): TestRetentionStore {
  return new MemoryRetentionStore();
}

beforeEach(() => {
  freezeClock(FROZEN_NOW_MS);
  __resetCapture();
  __setTestSink();
});
afterEach(() => {
  restoreClock();
  __resetCapture();
});

/** PI-shape probes — none of these may appear in any captured log line. */
const EMAIL_SHAPE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const UUID_SHAPE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

function assertNoPII(line: LogLine): void {
  const json = JSON.stringify(line);
  expect(EMAIL_SHAPE.test(json), `email shape in log line: ${json}`).toBe(false);
  expect(UUID_SHAPE.test(json), `uuid shape in log line: ${json}`).toBe(false);
  // The error message must NOT ride along — only the class.
  expect(json.includes('synthetic-delete-failure'), `raw message leaked: ${json}`).toBe(false);
}

describe('T16 / G-T16-PRIV-3 — operator-side structured Error logging', () => {
  it('emit-failure path emits one ERROR line carrying error_class + outcome, no PI; result error_code unchanged', async () => {
    const store = makeStore();
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    store.__forceAuditEmitFailure(true);

    const result = await runRetentionPass({ store, config: { dry_run: false } });

    // Client-facing contract unchanged.
    expect(result.status).toBe('errored');
    expect((result as { error_code?: string }).error_code).toBe('audit_emit_failed');

    // Exactly one operator ERROR line for the emit-failure.
    const errors = __getCapturedLines().filter(
      (l) => l.level === 'ERROR' && l.event === 'retention.sweep.emit_failed'
    );
    expect(errors.length).toBe(1);
    const line = errors[0]!;
    expect(line.outcome).toBe('audit_emit_failed');
    // error_class is the JS constructor name — present and non-empty.
    expect(typeof line.error_class).toBe('string');
    expect(line.error_class!.length).toBeGreaterThan(0);
    // No PI rode along.
    for (const l of __getCapturedLines()) assertNoPII(l);
  });

  it('successful sweep emits NO operator ERROR line (the log path is error-only)', async () => {
    const store = makeStore();
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });

    const result = await runRetentionPass({ store, config: { dry_run: false } });
    expect(result.status).not.toBe('errored');

    const errors = __getCapturedLines().filter((l) => l.level === 'ERROR');
    expect(errors.length).toBe(0);
  });
});
