/**
 * Alert dispatch barrel.
 *
 * Source: §C M9 roadmap deliverable.
 */
export {
  dispatchAlert,
  getAlertSink,
  setAlertSink,
  ALERT_SEVERITY,
  type AlertFire,
  type AlertMeta,
  type AlertSeverity,
  type AlertSink,
  type AlertSymbol
} from './dispatch';

export { StructuredLogAlertSink } from './structured-log-sink';

export {
  dispatchBackupRetentionAlerts,
  dispatchIntegrityAlerts,
  dispatchRetentionAlerts,
  dispatchWatchdogAlerts
} from './result-adapters';
