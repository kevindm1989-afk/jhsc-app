/**
 * StructuredLogAlertSink — default production wiring for AlertSink.
 *
 * Emits one canonical structured log line per fire under the event
 * name `alert.fired`. The on-call surface (PagerDuty bridge / Sentry
 * issue alert / pg_cron probe) picks up by this `event` name.
 *
 * The structured logger's SAFE_FIELDS_ALLOWLIST is the runtime defense
 * against accidental PI leakage in `meta` — anything not on the list
 * gets dropped before the line ships.
 *
 * Source: §C M9 roadmap deliverable.
 */

import { log } from '../log/index';
import type { AlertFire, AlertSink } from './dispatch';

/**
 * Flatten the alert meta to a structured-log `attributes` map.
 * Values are coerced to strings to stay within the structured logger's
 * primitive-only field contract.
 */
function metaToAttributes(meta: AlertFire['meta']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = v;
  }
  return out;
}

export class StructuredLogAlertSink implements AlertSink {
  fire(f: AlertFire): void {
    // The `severity: page` path uses log.error so on-call surfaces
    // that pivot by log-level still catch it. `warn` and `info` map
    // to log.warn / log.info.
    const call = {
      event: 'alert.fired',
      attributes: {
        'alert.symbol': f.symbol,
        'alert.severity': f.severity,
        'alert.source': f.source,
        'alert.ts_ms': f.ts_ms,
        ...metaToAttributes(f.meta)
      }
    };
    if (f.severity === 'page') {
      log.error(call);
    } else if (f.severity === 'warn') {
      log.warn(call);
    } else {
      log.info(call);
    }
  }
}
