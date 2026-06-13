/**
 * Alert dispatch — wires the `would_fire_alert` / `alarm_fired` symbols
 * surfaced by M6 (retention) / M8.A (backup) / M8.B (audit-integrity)
 * libraries into a routable dispatch path.
 *
 * Source: §C M9 roadmap deliverable ("every `would_fire_alert: 'A-*'`
 * symbol returned by libraries has a real sink with on-call routing").
 *
 * Two pieces:
 *   1. `AlertSymbol` — closed union of every alert symbol the libraries
 *      can fire today.
 *   2. `AlertSink` — interface a transport (structured-log echo / Sentry /
 *      PagerDuty bridge) implements. The default is the
 *      `StructuredLogAlertSink` defined in ./structured-log-sink.ts; it
 *      emits a single canonical log line per fire so the alert pipeline
 *      can pick it up by `event` name.
 *
 * Each alert's runbook lives at `playbooks/runbooks/<symbol>.md` (a
 * follow-on docs PR fills these in). The dispatch layer never enriches
 * the meta with PI — only structural fields. The structured logger's
 * SAFE_FIELDS_ALLOWLIST is the second-layer defense.
 */

/**
 * Closed union of alert symbols. Adding a new symbol:
 *   - add to this union
 *   - add the severity row to `ALERT_SEVERITY` below
 *   - add a runbook stub in `playbooks/runbooks/`
 *
 * `A-RETENTION-001` is the M6 over-delete alarm (F-57). The library
 * surfaces it via `alarm_fired: true` on a `RetentionPassResult` — the
 * adapter below translates.
 *
 * `A-BACKUP-001` is the F-75 still-locked-past-window failure (M8.A).
 *
 * `A-AUDIT-001` / `A-INTEGRITY-002` come from the audit-integrity
 * library (M8.B). `A-INTEGRITY-001` is reserved for "no successful
 * pass in the watchdog window" — the watchdog itself lives outside the
 * library (it's a pg_cron / Edge Function probe; not in this PR).
 */
export type AlertSymbol =
  | 'A-RETENTION-001'
  | 'A-BACKUP-001'
  | 'A-AUDIT-001'
  | 'A-INTEGRITY-001'
  | 'A-INTEGRITY-002';

export type AlertSeverity = 'page' | 'warn' | 'info';

/**
 * Severity table — closed mapping. The on-call surface routes by this.
 * `page` = wake someone up; `warn` = work-day signal; `info` = log only.
 */
export const ALERT_SEVERITY: Readonly<Record<AlertSymbol, AlertSeverity>> = Object.freeze({
  // Over-delete alarm — block the pass + fire AND require operator confirm.
  'A-RETENTION-001': 'page',
  // Backup object still locked past the 42d window — cooperative-caller
  // defense (F-75); needs operator intervention to investigate.
  'A-BACKUP-001': 'page',
  // Any audit-log integrity mismatch — load-bearing forensic invariant.
  'A-AUDIT-001': 'page',
  // No successful integrity pass in the watchdog window.
  'A-INTEGRITY-001': 'page',
  // Unattributable reconciliation count — divergence the library could
  // not blame on a retention sweep. Warns rather than pages because
  // there's no immediate-actionable response without operator triage.
  'A-INTEGRITY-002': 'warn'
});

/**
 * Structured meta carried alongside a fire. Type-only; the runtime
 * defense lives in the structured logger's SAFE_FIELDS_ALLOWLIST plus
 * the per-adapter composition (adapters are forbidden from putting PI
 * here — see `result-adapters.ts`).
 */
export type AlertMeta = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Structured fire input — composed by adapters from library results.
 * Every field is either typed (no `unknown`) or on the structured-log
 * allowlist.
 */
export interface AlertFire {
  readonly symbol: AlertSymbol;
  readonly severity: AlertSeverity;
  readonly ts_ms: number;
  /** Library that surfaced the symbol; one of 'retention' | 'backup' | 'audit-integrity'. */
  readonly source: 'retention' | 'backup' | 'audit-integrity';
  /** Structural meta — adapters control composition. No PI. */
  readonly meta: AlertMeta;
}

/**
 * Sink interface — pluggable transport. The production wiring is the
 * structured-log echo + a Sentry breadcrumb (Sentry's beforeSend
 * scrubber redacts PI). PagerDuty / on-call surface bridges read off
 * the structured log topic `alert.fired`.
 */
export interface AlertSink {
  fire(fire: AlertFire): void;
}

/** Installed sink — defaults to noop so library callers never crash. */
let _sink: AlertSink = { fire: () => undefined };

/**
 * Install the alert sink. Production wires `StructuredLogAlertSink`
 * here (see ./structured-log-sink.ts); tests install a recording sink.
 */
export function setAlertSink(sink: AlertSink): void {
  _sink = sink;
}

/** Read the installed sink (test-only / introspection). */
export function getAlertSink(): AlertSink {
  return _sink;
}

/**
 * Dispatch one alert. Severity is resolved from the closed-set
 * `ALERT_SEVERITY` table; the caller may NOT override it (no
 * caller-supplied severity field; F-19 closed-allowlist lineage).
 */
export function dispatchAlert(
  symbol: AlertSymbol,
  source: AlertFire['source'],
  ts_ms: number,
  meta: AlertMeta = {}
): void {
  const fire: AlertFire = {
    symbol,
    severity: ALERT_SEVERITY[symbol],
    ts_ms,
    source,
    meta
  };
  _sink.fire(fire);
}
