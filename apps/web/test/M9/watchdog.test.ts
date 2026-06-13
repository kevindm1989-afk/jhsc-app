/**
 * A-INTEGRITY-001 watchdog probe coverage (M9.B).
 *
 * Validates:
 *   - runWatchdogProbe: closed-set result + window arithmetic edges
 *   - dispatchWatchdogAlerts: fires only on `no_recent_pass`
 *
 * Source: apps/web/src/lib/audit-integrity/watchdog.ts,
 *         apps/web/src/lib/alerts/result-adapters.ts.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  runWatchdogProbe,
  WATCHDOG_DEFAULT_WINDOW_MS,
  type WatchdogStore
} from '../../src/lib/audit-integrity';
import {
  dispatchWatchdogAlerts,
  setAlertSink,
  type AlertFire,
  type AlertSink
} from '../../src/lib/alerts';

const HOUR_MS = 60 * 60 * 1000;

function makeStore(most_recent_ok_ms: number | null): WatchdogStore {
  return {
    async mostRecentOkRunStartedAtMs() {
      return most_recent_ok_ms;
    }
  };
}

function makeRecording(): { sink: AlertSink; fires: AlertFire[] } {
  const fires: AlertFire[] = [];
  return { sink: { fire: (f) => fires.push(f) }, fires };
}

describe('M9.B watchdog — runWatchdogProbe', () => {
  it('returns ok when most recent ok-run is inside the window', async () => {
    const now = 1_700_000_000_000;
    const r = await runWatchdogProbe({
      store: makeStore(now - 5 * HOUR_MS),
      nowMs: () => now,
      window_ms: 9 * HOUR_MS
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.most_recent_ok_ms).toBe(now - 5 * HOUR_MS);
      expect(r.age_ms).toBe(5 * HOUR_MS);
    }
  });

  it('returns no_recent_pass with would_fire_alert when most recent ok-run is exactly outside the window', async () => {
    const now = 1_700_000_000_000;
    const r = await runWatchdogProbe({
      store: makeStore(now - 9 * HOUR_MS - 1),
      nowMs: () => now,
      window_ms: 9 * HOUR_MS
    });
    expect(r.status).toBe('no_recent_pass');
    if (r.status === 'no_recent_pass') {
      expect(r.would_fire_alert).toBe('A-INTEGRITY-001');
      expect(r.window_ms).toBe(9 * HOUR_MS);
      expect(r.age_ms).toBe(9 * HOUR_MS + 1);
      expect(r.most_recent_ok_ms).toBe(now - 9 * HOUR_MS - 1);
    }
  });

  it('exact window boundary (age_ms === window_ms) is inclusive — ok', async () => {
    const now = 1_700_000_000_000;
    const r = await runWatchdogProbe({
      store: makeStore(now - 9 * HOUR_MS),
      nowMs: () => now,
      window_ms: 9 * HOUR_MS
    });
    expect(r.status).toBe('ok');
  });

  it('returns no_recent_pass + null fields when store reports no ok-run ever', async () => {
    const r = await runWatchdogProbe({
      store: makeStore(null),
      nowMs: () => 1_700_000_000_000,
      window_ms: 9 * HOUR_MS
    });
    expect(r.status).toBe('no_recent_pass');
    if (r.status === 'no_recent_pass') {
      expect(r.most_recent_ok_ms).toBeNull();
      expect(r.age_ms).toBeNull();
      expect(r.would_fire_alert).toBe('A-INTEGRITY-001');
    }
  });

  it('window_ms <= 0 throws (misconfigured probe never silently passes)', async () => {
    await expect(
      runWatchdogProbe({
        store: makeStore(0),
        nowMs: () => 1,
        window_ms: 0
      })
    ).rejects.toThrow(/window_ms must be > 0/);
    await expect(
      runWatchdogProbe({
        store: makeStore(0),
        nowMs: () => 1,
        window_ms: -1
      })
    ).rejects.toThrow(/window_ms must be > 0/);
  });

  it('exports WATCHDOG_DEFAULT_WINDOW_MS = 9h', () => {
    expect(WATCHDOG_DEFAULT_WINDOW_MS).toBe(9 * HOUR_MS);
  });
});

describe('M9.B watchdog — dispatchWatchdogAlerts', () => {
  const { sink, fires } = makeRecording();
  beforeEach(() => {
    fires.length = 0;
    setAlertSink(sink);
  });

  it('fires A-INTEGRITY-001 on no_recent_pass', () => {
    dispatchWatchdogAlerts(
      {
        status: 'no_recent_pass',
        most_recent_ok_ms: null,
        age_ms: null,
        window_ms: 9 * HOUR_MS,
        would_fire_alert: 'A-INTEGRITY-001'
      },
      1_700_000_000_000
    );
    expect(fires).toHaveLength(1);
    expect(fires[0].symbol).toBe('A-INTEGRITY-001');
    expect(fires[0].severity).toBe('page');
    expect(fires[0].source).toBe('audit-integrity');
    expect(fires[0].ts_ms).toBe(1_700_000_000_000);
    expect(fires[0].meta).toMatchObject({ 'alert.outcome': 'no_recent_pass' });
  });

  it('does NOT fire on ok status', () => {
    dispatchWatchdogAlerts(
      {
        status: 'ok',
        most_recent_ok_ms: 1_700_000_000_000 - HOUR_MS,
        age_ms: HOUR_MS
      },
      1_700_000_000_000
    );
    expect(fires).toHaveLength(0);
  });
});
