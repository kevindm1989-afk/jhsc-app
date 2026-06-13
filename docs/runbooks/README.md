# Runbooks

One runbook per `A-*` alert symbol. The on-call surface links each fired alert to its runbook by `alert.symbol`.

## Alert runbook index

| Symbol | Severity | Source | Runbook |
|---|---|---|---|
| `A-RETENTION-001` | page | retention library (`alarm_fired` / over-delete threshold) | [A-RETENTION-001.md](./A-RETENTION-001.md) |
| `A-BACKUP-001` | page | backup retention pass (object still locked past 42d) | [A-BACKUP-001.md](./A-BACKUP-001.md) |
| `A-AUDIT-001` | page | audit-integrity pass (any mismatch — load-bearing forensic) | [A-AUDIT-001.md](./A-AUDIT-001.md) |
| `A-INTEGRITY-001` | page | integrity-check watchdog (no successful pass in window) | [A-INTEGRITY-001.md](./A-INTEGRITY-001.md) |
| `A-INTEGRITY-002` | warn | audit-integrity pass (unattributable reconcile) | [A-INTEGRITY-002.md](./A-INTEGRITY-002.md) |

The closed alert-symbol union + severity table are in `apps/web/src/lib/alerts/dispatch.ts`.

## Other runbooks

- [HMAC pseudonym key rotation](./hmac-key-rotation.md) — `$HMAC_PSEUDONYM_KEY` annual rotation procedure (HG-NEW-3 / F-125 / F-126).

## Adding a new alert

When adding a new `A-*` symbol to the closed union:

1. Add the symbol + severity to `apps/web/src/lib/alerts/dispatch.ts`.
2. Add a runbook stub here, mirroring the existing six-section shape: §1 What it means / §2 Diagnose / §3 Respond / §4 Escalate / §5 Post-mortem trigger / §6 Known false positives.
3. Add the row to the index table above.
4. The on-call surface's runbook-link logic picks it up automatically by `alert.symbol`.
