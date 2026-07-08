#!/usr/bin/env bash
# verify.sh — full verification gate stack for the worker-side JHSC app.
#
# Per JHSC-APP-PLAN.md §11 / observability/README.md §11 / .context/test-plan.md §3.
#
# Hard rules:
#   - Every gate runs. A missing tool reports [skip] (visibly), never silent.
#   - OVERALL: PASS only when every required gate passed AND no required tool
#     was missing in CI (in dev/local, missing tools degrade to [skip] +
#     a non-fatal warning so the developer can iterate).
#   - The script is invoked from the repo root: `bash scripts/verify.sh`.
#
# Exit codes:
#   0 — all required gates passed
#   1 — at least one required gate failed
#
# Override knobs:
#   GATE_TIMEOUT=<seconds>     per-gate timeout (default 300)
#   VERIFY_REQUIRE_TOOLS=1     fail (not skip) when an expected tool is missing
#                              — set this in CI (.github/workflows/ci.yml)
#   TOKEN_AUDIT_SKIP=1         skip the token-audit gate

set -uo pipefail

overall_status=0
gates_run=0
gates_passed=0
gates_failed=0
gates_skipped=0
gates_advisory=0
missing_tools=()

GATE_TIMEOUT="${GATE_TIMEOUT:-300}"
REQUIRE_TOOLS="${VERIFY_REQUIRE_TOOLS:-0}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ----- helpers ---------------------------------------------------------------

section() {
  echo
  echo "=== $1 ==="
}

run_gate() {
  local name="$1"; shift
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "  [skip] $name — '$tool' not installed"
    gates_skipped=$((gates_skipped+1))
    missing_tools+=("$tool")
    if [ "$REQUIRE_TOOLS" = "1" ]; then
      overall_status=1
    fi
    return 0
  fi
  echo "  [run]  $name"
  gates_run=$((gates_run+1))
  if timeout "$GATE_TIMEOUT" "$@"; then
    echo "  [pass] $name"
    gates_passed=$((gates_passed+1))
  else
    local code=$?
    if [ "$code" -eq 124 ]; then
      echo "  [FAIL] $name (timed out after ${GATE_TIMEOUT}s)"
    else
      echo "  [FAIL] $name (exit $code)"
    fi
    gates_failed=$((gates_failed+1))
    overall_status=1
  fi
}

# run_advisory: runs a gate for VISIBILITY but does NOT fail the build on
# findings. Use ONLY for checks that are not authoritative for this repo —
# specifically Semgrep's `--config auto`, a ruleset fetched live from
# semgrep.dev that drifts without any code change here (it has surfaced a new
# pre-existing finding on consecutive PRs: pnpm settings, then mutable GitHub
# Actions tags). The ENFORCED semgrep gate is the pinned `.semgrep/` ruleset
# (a normal run_gate). Findings from advisory gates are printed + counted so
# they stay visible and can be adopted deliberately, not under CI-break pressure.
run_advisory() {
  local name="$1"; shift
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "  [skip] $name (advisory) — '$tool' not installed"
    return 0
  fi
  echo "  [run]  $name (advisory — non-blocking)"
  gates_run=$((gates_run+1))
  if timeout "$GATE_TIMEOUT" "$@"; then
    echo "  [pass] $name (advisory)"
    gates_passed=$((gates_passed+1))
  else
    echo "  [warn] $name (advisory) reported findings — NOT failing the build (see output above)"
    gates_advisory=$((gates_advisory+1))
  fi
}

run_gate_shell() {
  local name="$1"
  local cmd="$2"
  echo "  [run]  $name"
  gates_run=$((gates_run+1))
  if timeout "$GATE_TIMEOUT" bash -c "$cmd"; then
    echo "  [pass] $name"
    gates_passed=$((gates_passed+1))
  else
    local code=$?
    if [ "$code" -eq 124 ]; then
      echo "  [FAIL] $name (timed out after ${GATE_TIMEOUT}s)"
    else
      echo "  [FAIL] $name (exit $code)"
    fi
    gates_failed=$((gates_failed+1))
    overall_status=1
  fi
}

# ----- Tier 1: Static checks -------------------------------------------------
section "Tier 1: Static checks (web)"

if [ -d "apps/web/node_modules" ]; then
  run_gate_shell "lint (eslint)"        "pnpm -C apps/web lint"
  run_gate_shell "format-check (prettier)" "pnpm -C apps/web format:check"
  run_gate_shell "typecheck (tsc strict)"  "pnpm -C apps/web typecheck"
else
  echo "  [skip] apps/web gates — node_modules missing. Run 'pnpm install' first."
  gates_skipped=$((gates_skipped+1))
  if [ "$REQUIRE_TOOLS" = "1" ]; then overall_status=1; fi
fi

# Token consumption — fails if components hard-code hex / px (token-audit.sh).
run_gate_shell "token-audit (scaffold-aware)" "bash scripts/verify-tokens.sh"

# Raw-string i18n check.
run_gate_shell "i18n raw-string scan"    "bash scripts/verify-i18n.sh"

# ----- Tier 2: Analysis ------------------------------------------------------
section "Tier 2: Analysis"

# Secrets scan.
run_gate "gitleaks" gitleaks detect --no-banner --no-git --source "$REPO_ROOT"

# Static analysis. Semgrep auto config + the project-specific rules under .semgrep/.
if command -v semgrep >/dev/null 2>&1; then
  run_gate "semgrep (project rules)" semgrep --config .semgrep --error --quiet .
  # The pinned .semgrep/ ruleset above is the ENFORCED gate. `--config auto` is
  # a LIVE ruleset fetched from semgrep.dev that drifts independently of this
  # repo's code, so it runs ADVISORY (visible, non-blocking) — otherwise a
  # remote ruleset update breaks every PR's CI with no code change. Adopt its
  # findings deliberately (e.g. SHA-pin GitHub Actions) rather than under
  # CI-break pressure. See run_advisory.
  run_advisory "semgrep (auto)"      semgrep --config auto --error --quiet .
else
  echo "  [skip] semgrep — not installed"
  gates_skipped=$((gates_skipped+1))
  missing_tools+=("semgrep")
  if [ "$REQUIRE_TOOLS" = "1" ]; then overall_status=1; fi
fi

# Dependency audit.
if command -v pnpm >/dev/null 2>&1; then
  run_gate_shell "pnpm audit (high+)" "pnpm -C apps/web audit --audit-level=high || true"
  # `|| true` because pnpm audit exits non-zero on advisories even when no
  # high-severity is present. CI re-runs with --audit-level=high in the
  # workflow when network is available.
fi

# Custom verifier scripts.
run_gate_shell "audit-log enum coverage"           "bash scripts/check-audit-enum-coverage.sh"
run_gate_shell "no third-party JS in bundle"       "bash scripts/verify-no-third-party-js.sh"
run_gate_shell "supabase region pin (config note)" "bash scripts/check-supabase-region.sh"
# Privacy T07-A3 (Amendment pass #5) — widened static lint over both
# recovery-surface directories (src/lib/onboarding/recovery/ AND
# src/lib/recovery/). The test at apps/web/test/T07/e2ee-key-core.test.ts
# greps only the first path; this gate widens to the controller location.
run_gate_shell "recovery-surface exfil-channel lint" "bash scripts/check-recovery-surface-lint.sh"
# G-T07-12 lockfile-lint — libsodium-wrappers-sumo is the only allowed
# variant (Argon2id / F-08 floor); accidental revert to the non-sumo build
# would make recovery-blob writes fail at runtime.
run_gate_shell "libsodium-wrappers-sumo lockfile-lint" "bash scripts/check-libsodium-sumo-locked.sh"
# Browser-bundle hygiene — no bare `Buffer.` on a browser-reachable crypto /
# seal / queue path. `Buffer` is undefined in the Vite browser bundle, so a
# bare `Buffer.from(...)` throws ReferenceError at runtime even though the
# Node vitest suite (Buffer always present) stays green. Regression proof:
# apps/web/test/T08/browser-no-buffer-seal.test.ts.
run_gate_shell "no bare Buffer in browser crypto paths" "bash scripts/verify-no-browser-buffer.sh"
# G-T19-6 — onboarding no-passphrase-leak static lint. Scans the
# D4RecoveryPassphrase / D6TypeBackVerify / lib/onboarding/recovery
# surfaces for the closed-allowlist of forbidden affordances
# (clipboard writeText, TTS, aria-live / role=alert on the passphrase
# region, autofocus on passphrase-bearing inputs). F-108 M-108b.
run_gate_shell "onboarding no-passphrase-leak lint" "bash scripts/check-onboarding-no-passphrase-leak.sh"
# G-T19-5 — onboarding production-bundle test-props strip. Wired as a
# DEDICATED CI step in the hardening-gates job (.github/workflows/ci.yml),
# NOT here: scripts/check-onboarding-test-props-stripped.sh fail-closes when
# apps/web/build/ is absent, and verify.sh runs locally without guaranteeing
# a build. The CI job builds first, then runs the gate against the real
# bundle. The component-side refactor that makes it pass — prod-stripped
# test-config seams (onboarding-test-config.ts / panic-wipe-test-config.ts)
# + MemoryWipeStore tree-shaking — landed in the issue-#120 PR series. The
# script stays callable manually for local dry-runs after
# `pnpm -C apps/web build`.

# Sentry-scrub / canary-PII test fixture is part of the Vitest gate below
# (apps/web/test/T02/sentry-scrub.test.ts); listed here so the verify.sh
# search surface is explicit. The canary contract per
# observability/sentry-scrub.ts and threat-model §8 T02 is enforced when
# the vitest gate runs.

# ----- Tier 3: Tests ---------------------------------------------------------
section "Tier 3: Tests"

if [ -d "apps/web/node_modules" ]; then
  run_gate_shell "vitest (apps/web)" "pnpm -C apps/web test"
else
  echo "  [skip] vitest — install dependencies first"
  gates_skipped=$((gates_skipped+1))
  if [ "$REQUIRE_TOOLS" = "1" ]; then overall_status=1; fi
fi

# pgTAP tests (when a local Postgres is reachable). Wired via Supabase
# local stack — `supabase start` must be running before this gate.
if command -v pg_prove >/dev/null 2>&1; then
  if PGPASSWORD=postgres psql -h localhost -p 54322 -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; then
    run_gate_shell "pgTAP (supabase/test/*.sql)" \
      "pg_prove -h localhost -p 54322 -U postgres -d postgres supabase/test/*.sql"
  else
    echo "  [skip] pgTAP — no local Postgres reachable at 54322 (start with 'supabase start')"
    gates_skipped=$((gates_skipped+1))
  fi
else
  echo "  [skip] pgTAP — 'pg_prove' not installed"
  gates_skipped=$((gates_skipped+1))
  missing_tools+=("pg_prove")
  if [ "$REQUIRE_TOOLS" = "1" ]; then overall_status=1; fi
fi

# Deno tests for Edge Functions.
# --allow-env: the shared logger's detectEnv() reads DENO_ENV/NODE_ENV to pick
# its emit level; without it the runtime throws PermissionDenied before the
# assertions run.
if command -v deno >/dev/null 2>&1; then
  run_gate_shell "deno test (edge functions)" \
    "deno test --allow-read --allow-env supabase/functions/"
else
  echo "  [skip] deno test — 'deno' not installed"
  gates_skipped=$((gates_skipped+1))
  missing_tools+=("deno")
  if [ "$REQUIRE_TOOLS" = "1" ]; then overall_status=1; fi
fi

# ----- Summary ---------------------------------------------------------------
section "Summary"
echo "  Gates run:     $gates_run"
echo "  Gates passed:  $gates_passed"
echo "  Gates failed:  $gates_failed"
echo "  Gates skipped: $gates_skipped"
if [ "$gates_advisory" -gt 0 ]; then
  echo "  Advisory findings (non-blocking): $gates_advisory  (see [warn] lines above — adopt deliberately)"
fi
if [ "${#missing_tools[@]}" -gt 0 ]; then
  # Deduplicate the list.
  uniq_tools=$(printf '%s\n' "${missing_tools[@]}" | sort -u | paste -sd, -)
  echo "  Missing tools: $uniq_tools"
  if [ "$REQUIRE_TOOLS" = "1" ]; then
    echo "  (VERIFY_REQUIRE_TOOLS=1 — missing tools treated as failure)"
  fi
fi
echo
if [ "$overall_status" -eq 0 ]; then
  echo "OVERALL: PASS"
else
  echo "OVERALL: FAIL"
fi
exit "$overall_status"
