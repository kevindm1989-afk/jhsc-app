# Secret inventory

Tracking every secret (production or production-adjacent) that the project depends on, including:
- Its **classification** (so the privacy-reviewer + security-reviewer can sign off without re-deriving the call).
- Its **provider / storage location** (so an incident-responder can find it under pressure).
- Its **rotation cadence** + **rotation runbook pointer**.
- Its **emission surfaces** (so the no-secrets-in-logs gates have a denylist to enforce).
- The **ADR / runbook** that authorised its introduction.

This file is the source of truth for the secret denylists in `scripts/verify-no-sha-in-logs.sh` and (future) `scripts/verify-no-secrets-in-logs.sh`. Adding a new secret to the project requires adding a row here AND updating those scripts' denylists in the same PR. The dependency-manager pass enforces structural drift between this file and the scripts.

Privacy + security baseline: per `.context/constraints.md` §"Secrets handling — applies to all agents". Every entry inherits the constraint that the raw secret value MUST NEVER appear in source control, structured logs, error trackers (Sentry), audit-log meta, breadcrumb trails, or any user-visible surface.

---

## Entries

### `HMAC_PSEUDONYM_KEY` — HMAC pseudonym key (production)

| Field | Value |
|---|---|
| **Classification** | `deploy-pipeline secret, privacy-adjacent` |
| **Authority** | ADR-0016 (HMAC pseudonymization standard) + ADR-0024 (KEY_PARITY check posture); HG-NEW-1 ratified 2026-06-12 |
| **Provider / storage** | GitHub Actions secret on the production deploy workflow; Supabase Postgres GUC `app.hmac_pseudonym_key` (set via `ALTER SYSTEM` per ADR-0016 §Decision 3); never on developer machines outside the production deploy job |
| **Entropy floor** | ≥256 bits OS-CSPRNG at generation. Enforced by `scripts/verify-key-entropy.sh` against a synthetic fixture in CI's `hardening-gates` job (NEVER against the real secret). |
| **Rotation cadence** | Annual (per ADR-0016). Atomic-swap-window procedure ships in M11 runbook (HG-NEW-3 ratified). Rotation MUST update GitHub Actions secret + Postgres GUC in lockstep; the deploy-time CI parity check is allowed to fail-and-retry-once before failing the deploy. No bypass even during rotation. |
| **Parity check** | Deploy-time: `scripts/verify-key-parity-deploy.sh` calls `key_parity_server_sha()` against production Postgres and compares to `sha256($HMAC_PSEUDONYM_KEY)`. Cold-start: every Edge Function calls `assertKeyParity()` from `_shared/key-parity.ts` on first invocation per process. Both fail-closed (F-126; no bypass). |
| **SHA-of-key** | The SHA-256 of `$HMAC_PSEUDONYM_KEY` is classified **non-secret-but-sensitive** (it narrows offline brute-force confirmation per F-124). It MUST NOT land in structured logs, Sentry breadcrumbs, audit-log meta, error pages, or any other emission surface. Enforced by `scripts/verify-no-sha-in-logs.sh`. The SHA-bearing local variables (`_envKeyShaHex`, `_tsKeyShaHex`, `serverShaHex`, `envSha`, `serverSha`) are the script's denylist. |
| **Audit emission** | `key_parity.deploy_ok` (deploy-time check passed) and `key_parity.mismatch` (deploy-time OR cold-start check failed) — both at retention class `'24mo'` per ADR-0015 Amendment I. |
| **Trust boundary** | B9 — deploy-pipeline ↔ production-DB SHA-read path. Disclosed in `.context/threat-model.md` §1. Credentials in scope: the new `deploy_reader_role` Postgres connection (NOLOGIN, EXECUTE on `key_parity_server_sha()` only, no BYPASSRLS, no SELECT on base tables). |
| **Emission surface denylist** | The string `HMAC_PSEUDONYM_KEY` MUST NOT appear in the production browser bundle (`scripts/verify-no-third-party-js.sh` enforces). The SHA-bearing variable names MUST NOT appear in `apps/web/src/lib/log/` or `supabase/functions/_shared/log.ts` (`scripts/verify-no-sha-in-logs.sh` enforces). |
| **Sentry posture** | The raw key + the SHA-of-key are both in the Sentry breadcrumb scrub list (ADR-0010 extended in M2). |
| **Incident-response** | If the GitHub Actions secret is suspected compromised: (1) generate a new key per the entropy floor; (2) follow the M11 rotation runbook for the atomic-swap window; (3) emit a `key_parity.mismatch` audit row through manual `SELECT key_parity_server_sha()` against the OLD GUC for forensic anchor. PIPEDA s.10.1 breach-notification analysis is required if rotation was driven by exfiltration evidence. |

---

## Entries to add as they are introduced

(none currently; this file is created in the M2 PR for ADR-0024)

---

## Drift CI assertion (future M2.x)

A future `scripts/verify-secret-inventory-drift.sh` will assert that:
- Every secret referenced by name in the codebase (via Deno.env / process.env) is documented here.
- Every entry here is consumed by at least one code surface.
- The denylist arrays in `verify-no-sha-in-logs.sh` match the SHA-bearing variable names from `key-parity.ts` modules.

Until that lands, the gate is human-reviewed.
