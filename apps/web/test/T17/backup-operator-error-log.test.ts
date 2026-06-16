/**
 * T17 / G-T17-PRIV-3 — operator-side structured Error logging.
 *
 * The backup pass returns a closed-literal `error_code` to the caller
 * (F-81: no PI in error paths). Before this change every catch swallowed
 * the thrown Error entirely, leaving operators with no signal to diagnose
 * a backup failure. G-T17-PRIV-3 routes each swallowed Error to the
 * server-side structured-log sink as a CLASS-ONLY line — the JS
 * constructor name, never the `.message`.
 *
 * NEW test (existing T17 tests are read-only per test-plan.md §6). Installs
 * the structured-log test sink and asserts the operator-logging contract on
 * the error paths the MemoryBackupStore can drive via its `__force*` hooks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { FROZEN_NOW_MS } from '../_helpers/fixtures';
import { runBackupPass } from '../../src/lib/backup';
import {
  MemoryBackupStore,
  type TestBackupStore
} from '../../src/lib/backup/memory-backup-store';
import { __setTestSink, __resetCapture, __getCapturedLines } from '../../src/lib/log/test-sink';
import type { LogLine } from '../../src/lib/log';

function makeStore(): TestBackupStore {
  return new MemoryBackupStore();
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

describe('T17 / G-T17-PRIV-3 — operator-side structured Error logging', () => {
  it('kid-lookup failure emits one ERROR line with error_class + outcome; result error_code unchanged', async () => {
    const store = makeStore();
    store.__forceKidLookupFailure(true);

    const result = await runBackupPass({ store, config: { dry_run: false } });

    expect(result.status).toBe('errored');
    expect((result as { error_code?: string }).error_code).toBe('kid_lookup_failed');

    const errors = __getCapturedLines().filter(
      (l) => l.level === 'ERROR' && l.event === 'backup.pass.kid_lookup_failed'
    );
    expect(errors.length).toBe(1);
    expect(errors[0]!.outcome).toBe('kid_lookup_failed');
    expect(typeof errors[0]!.error_class).toBe('string');
    expect(errors[0]!.error_class!.length).toBeGreaterThan(0);
    for (const l of __getCapturedLines()) assertNoPII(l);
  });

  it('head-pointer failure emits the matching operator ERROR line', async () => {
    const store = makeStore();
    store.__forceHeadPointerFailure(true);

    const result = await runBackupPass({ store, config: { dry_run: false } });
    expect((result as { error_code?: string }).error_code).toBe('head_pointer_failed');

    const errors = __getCapturedLines().filter(
      (l) => l.level === 'ERROR' && l.event === 'backup.pass.head_pointer_failed'
    );
    expect(errors.length).toBe(1);
    expect(errors[0]!.error_class).toBeTruthy();
    for (const l of __getCapturedLines()) assertNoPII(l);
  });

  it('manifest-write failure emits the matching operator ERROR line', async () => {
    const store = makeStore();
    store.__forceManifestWriteFailure(true);

    const result = await runBackupPass({ store, config: { dry_run: false } });
    expect((result as { error_code?: string }).error_code).toBe('manifest_write_failed');

    const errors = __getCapturedLines().filter(
      (l) => l.level === 'ERROR' && l.event === 'backup.pass.manifest_write_failed'
    );
    expect(errors.length).toBe(1);
    for (const l of __getCapturedLines()) assertNoPII(l);
  });

  it('a clean backup pass emits NO operator ERROR line', async () => {
    const store = makeStore();
    const result = await runBackupPass({ store, config: { dry_run: false } });
    expect(result.status).not.toBe('errored');
    expect(__getCapturedLines().filter((l) => l.level === 'ERROR').length).toBe(0);
  });
});
