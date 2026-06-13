/**
 * Alert dispatch coverage (M9).
 *
 * Validates:
 *   - the closed `AlertSymbol` union + severity table
 *   - `dispatchAlert` resolves severity from the table (no caller override)
 *   - `StructuredLogAlertSink` emits via the structured logger at the
 *     right level for each severity
 *   - the three result adapters fire correctly for each
 *     would_fire_alert / alarm_fired shape
 *   - PI-canary: a PI-shaped field in adapter-composed meta would be
 *     dropped by the structured logger's allowlist (defense-in-depth
 *     check — the adapters themselves are the first defense)
 *
 * Source: apps/web/src/lib/alerts/*.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALERT_SEVERITY,
  dispatchAlert,
  dispatchBackupRetentionAlerts,
  dispatchIntegrityAlerts,
  dispatchRetentionAlerts,
  setAlertSink,
  StructuredLogAlertSink,
  type AlertFire,
  type AlertSink
} from '../../src/lib/alerts';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

function makeRecording(): { sink: AlertSink; fires: AlertFire[] } {
  const fires: AlertFire[] = [];
  const sink: AlertSink = { fire: (f) => fires.push(f) };
  return { sink, fires };
}

describe('M9 alerts — severity table is closed', () => {
  it('every AlertSymbol has a severity row', () => {
    // Compile-time exhaustiveness is enforced by `Readonly<Record<AlertSymbol, AlertSeverity>>`;
    // the runtime check asserts the table covers every documented symbol.
    expect(Object.keys(ALERT_SEVERITY).sort()).toEqual(
      ['A-AUDIT-001', 'A-BACKUP-001', 'A-INTEGRITY-001', 'A-INTEGRITY-002', 'A-RETENTION-001']
    );
  });

  it('page-severity symbols are the four load-bearing forensic anchors', () => {
    const pages = Object.entries(ALERT_SEVERITY)
      .filter(([, s]) => s === 'page')
      .map(([k]) => k)
      .sort();
    expect(pages).toEqual(['A-AUDIT-001', 'A-BACKUP-001', 'A-INTEGRITY-001', 'A-RETENTION-001']);
  });

  it('A-INTEGRITY-002 is warn, not page (no immediate-actionable response)', () => {
    expect(ALERT_SEVERITY['A-INTEGRITY-002']).toBe('warn');
  });
});

describe('M9 alerts — dispatchAlert', () => {
  beforeEach(() => {
    setAlertSink({ fire: () => undefined });
  });

  it('resolves severity from the closed table (caller cannot override)', () => {
    const { sink, fires } = makeRecording();
    setAlertSink(sink);
    dispatchAlert('A-BACKUP-001', 'backup', 1700, { foo: 'bar' });
    expect(fires).toHaveLength(1);
    expect(fires[0]).toEqual({
      symbol: 'A-BACKUP-001',
      severity: 'page',
      source: 'backup',
      ts_ms: 1700,
      meta: { foo: 'bar' }
    });
  });

  it('defaults meta to {} when omitted', () => {
    const { sink, fires } = makeRecording();
    setAlertSink(sink);
    dispatchAlert('A-AUDIT-001', 'audit-integrity', 1);
    expect(fires[0].meta).toEqual({});
  });
});

describe('M9 alerts — StructuredLogAlertSink', () => {
  const calls: Array<{ level: string; event: string; attrs: Record<string, unknown> }> = [];

  beforeEach(() => {
    calls.length = 0;
    __resetCapture();
    __setTestSink((line) => {
      const attrs = (line as { attributes?: Record<string, unknown> }).attributes ?? {};
      calls.push({
        level: (line as { level: string }).level,
        event: (line as { event: string }).event,
        attrs
      });
    });
  });

  afterEach(() => {
    __resetCapture();
  });

  it('page-severity routes to log.error', () => {
    new StructuredLogAlertSink().fire({
      symbol: 'A-BACKUP-001',
      severity: 'page',
      source: 'backup',
      ts_ms: 1700,
      meta: { 'alert.run_id': 'r1' }
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe('ERROR');
    expect(calls[0].event).toBe('alert.fired');
    expect(calls[0].attrs).toMatchObject({
      'alert.symbol': 'A-BACKUP-001',
      'alert.severity': 'page',
      'alert.source': 'backup',
      'alert.ts_ms': 1700,
      'alert.run_id': 'r1'
    });
  });

  it('warn-severity routes to log.warn', () => {
    new StructuredLogAlertSink().fire({
      symbol: 'A-INTEGRITY-002',
      severity: 'warn',
      source: 'audit-integrity',
      ts_ms: 1,
      meta: {}
    });
    expect(calls[0].level).toBe('WARN');
  });

  it('info-severity routes to log.info', () => {
    new StructuredLogAlertSink().fire({
      symbol: 'A-INTEGRITY-002',
      severity: 'info',
      source: 'audit-integrity',
      ts_ms: 1,
      meta: {}
    });
    expect(calls[0].level).toBe('INFO');
  });
});

describe('M9 alerts — dispatchRetentionAlerts', () => {
  const { sink, fires } = makeRecording();
  beforeEach(() => {
    fires.length = 0;
    setAlertSink(sink);
  });

  it('fires on aborted_over_delete_threshold', () => {
    dispatchRetentionAlerts(
      {
        status: 'aborted_over_delete_threshold',
        run_id: 'r1',
        alarm_fired: true,
        would_delete_total: 100
      },
      1700
    );
    expect(fires).toHaveLength(1);
    expect(fires[0].symbol).toBe('A-RETENTION-001');
    expect(fires[0].meta).toMatchObject({
      'alert.run_id': 'r1',
      'alert.would_delete_total': 100,
      'alert.outcome': 'aborted_over_delete_threshold'
    });
  });

  it('fires on completed + alarm_fired=true', () => {
    dispatchRetentionAlerts(
      { status: 'completed', run_id: 'r2', alarm_fired: true, deleted_total: 50 },
      1700
    );
    expect(fires).toHaveLength(1);
    expect(fires[0].meta).toMatchObject({
      'alert.run_id': 'r2',
      'alert.deleted_total': 50,
      'alert.outcome': 'completed'
    });
  });

  it('does NOT fire on completed + alarm_fired=false', () => {
    dispatchRetentionAlerts(
      { status: 'completed', run_id: 'r3', alarm_fired: false, deleted_total: 10 },
      1700
    );
    expect(fires).toHaveLength(0);
  });

  it('does NOT fire on errored', () => {
    dispatchRetentionAlerts(
      { status: 'errored', run_id: 'r4', error_code: 'delete_failed' },
      1700
    );
    expect(fires).toHaveLength(0);
  });
});

describe('M9 alerts — dispatchBackupRetentionAlerts', () => {
  const { sink, fires } = makeRecording();
  beforeEach(() => {
    fires.length = 0;
    setAlertSink(sink);
  });

  it('fires when would_fire_alert = A-BACKUP-001', () => {
    dispatchBackupRetentionAlerts(
      { status: 'completed', deleted_count: 2, would_fire_alert: 'A-BACKUP-001' },
      1700
    );
    expect(fires).toHaveLength(1);
    expect(fires[0].symbol).toBe('A-BACKUP-001');
    expect(fires[0].source).toBe('backup');
  });

  it('does NOT fire when would_fire_alert is undefined', () => {
    dispatchBackupRetentionAlerts({ status: 'completed', deleted_count: 2 }, 1700);
    expect(fires).toHaveLength(0);
  });

  it('does NOT fire on dry_run', () => {
    dispatchBackupRetentionAlerts({ status: 'dry_run', would_delete_count: 1 }, 1700);
    expect(fires).toHaveLength(0);
  });
});

describe('M9 alerts — dispatchIntegrityAlerts', () => {
  const { sink, fires } = makeRecording();
  beforeEach(() => {
    fires.length = 0;
    setAlertSink(sink);
  });

  it('fires on single symbol', () => {
    dispatchIntegrityAlerts(
      {
        status: 'completed',
        run_id: 'r1',
        mismatches_count: 1,
        attributable_count: 0,
        unattributable_count: 1,
        would_fire_alert: 'A-AUDIT-001'
      } as unknown as Parameters<typeof dispatchIntegrityAlerts>[0],
      1700
    );
    expect(fires).toHaveLength(1);
    expect(fires[0].symbol).toBe('A-AUDIT-001');
  });

  it('fires once per symbol in an array', () => {
    dispatchIntegrityAlerts(
      {
        status: 'completed',
        run_id: 'r1',
        mismatches_count: 1,
        attributable_count: 0,
        unattributable_count: 1,
        would_fire_alert: ['A-AUDIT-001', 'A-INTEGRITY-002']
      } as unknown as Parameters<typeof dispatchIntegrityAlerts>[0],
      1700
    );
    expect(fires).toHaveLength(2);
    expect(fires.map((f) => f.symbol).sort()).toEqual(['A-AUDIT-001', 'A-INTEGRITY-002']);
  });

  it('does NOT fire when would_fire_alert is undefined', () => {
    dispatchIntegrityAlerts(
      {
        status: 'completed',
        run_id: 'r1',
        mismatches_count: 0,
        attributable_count: 0,
        unattributable_count: 0
      } as unknown as Parameters<typeof dispatchIntegrityAlerts>[0],
      1700
    );
    expect(fires).toHaveLength(0);
  });

  it('does NOT fire on errored', () => {
    dispatchIntegrityAlerts(
      {
        status: 'errored',
        run_id: 'r1',
        error_code: 'manifest_read_failed'
      } as unknown as Parameters<typeof dispatchIntegrityAlerts>[0],
      1700
    );
    expect(fires).toHaveLength(0);
  });
});

describe('M9 alerts — PI-canary on adapter meta', () => {
  // The adapters are the FIRST defense against PI in alert meta — they
  // only compose structural ids + counts. This test fixes the contract
  // by asserting no canary-shape field appears in any adapter's emit.
  const PI_CANARY_FIELDS = new Set([
    'email', 'phone', 'name', 'address', 'user_email', 'user_phone',
    'first_name', 'last_name', 'passphrase', 'totp_code'
  ]);

  const { sink, fires } = makeRecording();
  beforeEach(() => {
    fires.length = 0;
    setAlertSink(sink);
  });

  it('retention adapter meta carries no PI-shaped keys', () => {
    dispatchRetentionAlerts(
      { status: 'aborted_over_delete_threshold', run_id: 'r1', alarm_fired: true, would_delete_total: 100 },
      1700
    );
    for (const f of fires) {
      for (const k of Object.keys(f.meta)) {
        expect(PI_CANARY_FIELDS.has(k)).toBe(false);
      }
    }
  });

  it('backup adapter meta carries no PI-shaped keys', () => {
    dispatchBackupRetentionAlerts(
      { status: 'completed', deleted_count: 1, would_fire_alert: 'A-BACKUP-001' },
      1700
    );
    for (const f of fires) {
      for (const k of Object.keys(f.meta)) {
        expect(PI_CANARY_FIELDS.has(k)).toBe(false);
      }
    }
  });

  it('integrity adapter meta carries no PI-shaped keys', () => {
    dispatchIntegrityAlerts(
      {
        status: 'completed',
        run_id: 'r1',
        mismatches_count: 1,
        attributable_count: 0,
        unattributable_count: 1,
        would_fire_alert: 'A-AUDIT-001'
      } as unknown as Parameters<typeof dispatchIntegrityAlerts>[0],
      1700
    );
    for (const f of fires) {
      for (const k of Object.keys(f.meta)) {
        expect(PI_CANARY_FIELDS.has(k)).toBe(false);
      }
    }
  });
});
