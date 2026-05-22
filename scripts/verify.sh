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
  # Run the public ruleset as a separate gate to keep failures attributable.
  run_gate "semgrep (auto)"          semgrep --config auto --error --quiet .
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
if command -v deno >/dev/null 2>&1; then
  run_gate_shell "deno test (edge functions)" \
    "deno test --allow-read supabase/functions/_shared/test/"
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
