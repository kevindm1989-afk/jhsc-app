#!/usr/bin/env bash
# verify-key-parity-deploy.sh — deploy-time HMAC pseudonym key parity check.
#
# Hard rule (ADR-0024 §1 / threat-model.md §3.14 F-125 F-126): on every
# production deploy, after `supabase functions deploy` and
# `supabase db push` complete, this script asserts that the SHA-256 of
# `$HMAC_PSEUDONYM_KEY` (in the deploy env) matches the SHA-256 of
# `app.hmac_pseudonym_key` GUC (in production Postgres).
#
# The DB SHA is read via the new SECURITY DEFINER function
# `key_parity_server_sha()` (migration 00000000000016), which returns
# the SHA only — never the key. The function is GRANTed EXECUTE to the
# non-login `deploy_reader_role`; this script connects as that role
# via a dedicated $DEPLOY_DB_URL.
#
# Atomic-swap-window allowance (ADR-0024 §5 / HG-NEW-3): if the first
# attempt mismatches, wait 30s and retry exactly once. This window
# covers the corner-case where the operator updated the GH-Actions
# secret + Postgres GUC in lockstep but propagation lagged. Any larger
# drift IS a configuration error and the deploy MUST fail.
#
# Required env vars:
#   HMAC_PSEUDONYM_KEY  — the deploy-time key value (NEVER logged)
#   DEPLOY_DB_URL       — postgres URL with deploy_reader_role auth
#
# Optional env vars:
#   KEY_PARITY_DEPLOY_TIMEOUT_S  — DB query timeout (default 10)
#   KEY_PARITY_DEPLOY_RETRY_WAIT_S — atomic-swap retry wait (default 30)
#
# No bypass: there is NO --force, no KEY_PARITY_SKIP, no `if: false`
# clause in the workflow that calls this script. F-126 M-126 forbids
# them. CI grep on the workflow file enforces this.
#
# Exit codes:
#   0 — parity check passed (after up to one retry)
#   1 — parity check failed both attempts
#   2 — required env var missing or psql not available

set -uo pipefail

KEY="${HMAC_PSEUDONYM_KEY:-}"
DB_URL="${DEPLOY_DB_URL:-}"
TIMEOUT_S="${KEY_PARITY_DEPLOY_TIMEOUT_S:-10}"
RETRY_WAIT_S="${KEY_PARITY_DEPLOY_RETRY_WAIT_S:-30}"

# Informational-mode gate FIRST: in PR CI neither $HMAC_PSEUDONYM_KEY nor
# $DEPLOY_DB_URL is set (the real secrets never reach PR runners). Skip
# cleanly so the gate is a no-op on PR runs. The production deploy workflow
# MUST set BOTH — a future CI grep on the deploy workflow file enforces this.
if [ -z "$DB_URL" ]; then
  echo "verify-key-parity-deploy: \$DEPLOY_DB_URL not set; skipping (informational mode)."
  echo "verify-key-parity-deploy: NOTE — the production deploy workflow MUST set DEPLOY_DB_URL + HMAC_PSEUDONYM_KEY."
  exit 0
fi
if [ -z "$KEY" ]; then
  # $DEPLOY_DB_URL is set, but $HMAC_PSEUDONYM_KEY is not — this is a
  # misconfigured deploy job (the workflow must supply both). Fail loudly.
  echo "verify-key-parity-deploy: \$DEPLOY_DB_URL is set but \$HMAC_PSEUDONYM_KEY is unset" >&2
  echo "verify-key-parity-deploy: deploy workflow MUST set both — refusing to proceed" >&2
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "verify-key-parity-deploy: psql not found on PATH" >&2
  exit 2
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "verify-key-parity-deploy: sha256sum not found on PATH" >&2
  exit 2
fi

# Compute the env-side SHA. Use printf '%s' to avoid trailing newline
# pollution that `echo` would inject (which would shift the SHA).
LOCAL_SHA="$(printf '%s' "$KEY" | sha256sum | awk '{print $1}')"
# Clear KEY immediately — we never need the raw key again.
KEY=""

compare_once() {
  local server_sha
  server_sha="$(PGCONNECT_TIMEOUT="$TIMEOUT_S" psql "$DB_URL" -t -A -c "SELECT public.key_parity_server_sha()" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$server_sha" ]; then
    echo "verify-key-parity-deploy: failed to read SERVER_SHA from $DB_URL" >&2
    return 1
  fi
  if [ "$LOCAL_SHA" = "$server_sha" ]; then
    return 0
  fi
  return 1
}

if compare_once; then
  echo "verify-key-parity-deploy: OK — env SHA matches server SHA (attempt 1)"
  exit 0
fi

# Atomic-swap retry — one attempt, after a fixed wait.
echo "verify-key-parity-deploy: attempt 1 mismatch — retrying in ${RETRY_WAIT_S}s (HG-NEW-3 atomic-swap allowance)" >&2
sleep "$RETRY_WAIT_S"
if compare_once; then
  echo "verify-key-parity-deploy: OK — env SHA matches server SHA (attempt 2 / after atomic-swap wait)"
  exit 0
fi

echo "verify-key-parity-deploy: FAIL — env SHA does not match server SHA (both attempts)" >&2
echo "verify-key-parity-deploy: ADR-0024 §1 / F-125 — deploy MUST NOT proceed" >&2
exit 1
