#!/usr/bin/env bash
# T19 / G-T19-5 — production-bundle test-props grep gate.
#
# Per ADR-0020 Decision 8 + F-102 M-102b: the test-only props
# `__test_step`, `__test_user_agent`, and `__test_origin` (defensively
# added per F-102 M-102b) MUST NOT appear as literal strings in the
# production-shipped JS bundle. Source files reference these via the
# split-form `'__test_' + 'step'` pattern (G-T05-10 lineage) so the
# bundler does not constant-fold the literal into the bundle.
#
# This script runs against any built bundle output under
# apps/web/build/ (the SvelteKit / Vite build output) — if no bundle
# is present (e.g., pre-build CI sweep), the script passes with a
# warning. The build-time enforcement is the test that DOES require
# the bundle.
#
# Usage:
#   scripts/check-onboarding-test-props-stripped.sh [bundle-dir]
#
# Exit code: 0 on pass; non-zero on any literal match outside source-
# map files.

set -eu

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
BUNDLE_DIR=${1:-"$REPO_ROOT/apps/web/build"}

# The banned literals — production bundles MUST NOT carry any of these
# symbols. The first three are the test-only Svelte props; the trailing
# six are the test-seam symbols exported from `__test_seams.ts` /
# `D4RecoveryPassphrase.ts` (must be runtime-stripped per ADR-0020
# Decision 8 + the module-throw guard).
PATTERNS=(
  '__test_step'
  '__test_user_agent'
  '__test_origin'
  '__test_only_get_passphrase_ref'
  '__test_advance_through_type_back'
  '__setPassphraseRefForTest'
  '__debugForceAuditFailure'
  '__debugForceClearFailure'
  '__TEST_PANIC_WIPE_HOOK'
  '__resetPanicWipeLockoutForTest'
  # Broad family catch-all (A-T19-RR-4): any `__test_<name>` symbol leaking
  # into the bundle (e.g. __test_force_wipe_in_progress, __test_store). Source
  # files reference these via the split-form pattern so the bundler does not
  # constant-fold them; a literal match here means a strip regression.
  '__test_[A-Za-z0-9_]+'
)

if [ ! -d "$BUNDLE_DIR" ]; then
  # Bundle absent — fail closed so the CI gate cannot silently skip on
  # a misconfigured build-dir argument (finding #25 / A-T19-10).
  echo "FAIL: bundle directory $BUNDLE_DIR not present — the grep gate cannot run." >&2
  echo "G-T19-5 requires a built bundle at $BUNDLE_DIR before this script runs." >&2
  exit 1
fi

FAILURES=0
for pattern in "${PATTERNS[@]}"; do
  # Scan every .js / .mjs file under the bundle dir; exclude .map files
  # (sourcemaps are allowed to reference the original symbol names).
  matches=$(find "$BUNDLE_DIR" \
    \( -name '*.js' -o -name '*.mjs' \) \
    ! -name '*.map' \
    -type f \
    -exec grep -lE "$pattern" {} + 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "FAIL: literal '$pattern' found in production bundle:" >&2
    echo "$matches" >&2
    FAILURES=$((FAILURES + 1))
  fi
done

if [ "$FAILURES" -gt 0 ]; then
  echo "G-T19-5: $FAILURES banned literal(s) leaked into production bundle." >&2
  exit 1
fi

echo "G-T19-5: pass — no __test_step / __test_user_agent / __test_origin literals in bundle."
exit 0
