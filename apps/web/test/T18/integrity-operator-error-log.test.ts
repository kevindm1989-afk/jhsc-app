/**
 * T18 / G-T18-3 — operator-side structured Error logging.
 *
 * The integrity check + weekly-anchor paths return a closed-literal
 * `error_code` to the caller (F-100: no PI in error paths). Before this
 * change every catch swallowed the thrown Error, leaving operators blind
 * to WHY a check failed. G-T18-3 routes each swallowed Error to the
 * server-side structured-log sink as a CLASS-ONLY line.
 *
 * NEW test (existing T18 tests are read-only per test-plan.md §6). Installs
 * the structured-log test sink and drives the error paths the
 * MemoryIntegrityStore can force.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { FROZEN_NOW_MS } from '../_helpers/fixtures';
import { runIntegrityCheck, runWeeklyChainAnchor } from '../../src/lib/audit-integrity';
import {
  MemoryIntegrityStore,
  type TestIntegrityStore
} from '../../src/lib/audit-integrity/memory-integrity-store';
import { __setTestSink, __resetCapture, __getCapturedLines } from '../../src/lib/log/test-sink';
import type { LogLine } from '../../src/lib/log';

const HOUR_MS = 60 * 60 * 1000;

function makeStore(): TestIntegrityStore {
  return new MemoryIntegrityStore();
}

function seedChain(store: TestIntegrityStore, count: number): void {
  for (let i = 1; i <= count; i++) {
    const id = String(i);
    const ts_ms = FROZEN_NOW_MS - (count - i + 1) * HOUR_MS;
    const hash = createHmac('sha256', 'seedChain-fixed-key').update(id).digest('hex');
    store.__debugInsertChainRow({
      id,
      ts_ms,
      hash,
      event_type: 'concern.created',
      prev_hash:
        i === 1
          ? '0'.repeat(64)
          : createHmac('sha256', 'seedChain-fixed-key').update(String(i - 1)).digest('hex'),
      actor_pseudonym: '0'.repeat(32),
      target_id: null,
      target_class: 'C1',
      severity: 'info',
      request_id: null,
      rotation_id: null,
      meta: {}
    });
  }
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

const EMAIL_SHAPE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const HEX_OVER_64 = /\b[0-9a-f]{65,}\b/i;

function assertNoPII(line: LogLine): void {
  const json = JSON.stringify(line);
  expect(EMAIL_SHAPE.test(json), `email shape in log line: ${json}`).toBe(false);
  expect(HEX_OVER_64.test(json), `over-64-hex in log line: ${json}`).toBe(false);
}

describe('T18 / G-T18-3 — operator-side structured Error logging', () => {
  it('runIntegrityCheck terminal-emit failure emits one ERROR line; result error_code unchanged', async () => {
    const store = makeStore();
    seedChain(store, 3);
    store.__debugCorruptRowHash('2', 'dada'.repeat(16));
    store.__forceSummaryEmitFailure(true);

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });

    expect(result.status).toBe('errored');
    expect((result as { error_code?: string }).error_code).toBe('audit_emit_failed');

    const errors = __getCapturedLines().filter(
      (l) => l.level === 'ERROR' && l.event === 'integrity.check.audit_emit_failed'
    );
    expect(errors.length).toBe(1);
    expect(errors[0]!.outcome).toBe('audit_emit_failed');
    expect(errors[0]!.error_class).toBeTruthy();
    for (const l of __getCapturedLines()) assertNoPII(l);
  });

  it('runWeeklyChainAnchor head-read failure emits the anchor operator ERROR line', async () => {
    const store = makeStore();
    seedChain(store, 3);
    store.__forceHeadReadException(true);

    const result = await runWeeklyChainAnchor({ store });

    expect(result.status).toBe('errored');
    expect((result as { error_code?: string }).error_code).toBe('head_read_failed');

    const errors = __getCapturedLines().filter(
      (l) => l.level === 'ERROR' && l.event === 'integrity.anchor.head_read_failed'
    );
    expect(errors.length).toBe(1);
    expect(errors[0]!.error_class).toBeTruthy();
    for (const l of __getCapturedLines()) assertNoPII(l);
  });

  it('a clean integrity check emits NO operator ERROR line', async () => {
    const store = makeStore();
    seedChain(store, 5);
    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).not.toBe('errored');
    expect(__getCapturedLines().filter((l) => l.level === 'ERROR').length).toBe(0);
  });
});
