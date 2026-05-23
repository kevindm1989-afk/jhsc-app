#!/usr/bin/env bash
# check-recovery-surface-lint.sh — recovery-passphrase reveal surface
# exfil-channel lint (ADR-0003 Amendment F operational rule 4).
#
# Per Amendment F operational rule 4 the recovery-passphrase reveal
# surface offers hold-to-reveal and NOTHING ELSE. Static-lint fails on
# any match for `SpeechSynthesisUtterance`, `window.speechSynthesis`, or
# `tts` under EITHER recovery surface directory.
#
# Scope widening — privacy-review-t07 T07-A3 (carry-forward, Amendment
# pass #5):
#   - The reveal UI lives at `src/lib/onboarding/recovery/`.
#   - The hold-to-reveal CONTROLLER lives at `src/lib/recovery/`.
#   The test at `apps/web/test/T07/e2ee-key-core.test.ts` greps only the
#   first path; this script widens to cover both paths so a future
#   regression in `show-again.ts` (or any sibling under
#   `src/lib/recovery/`) is caught by the verify-gate even if the test
#   file is not re-run.
#
# Exit codes: 0 — clean; 1 — offending identifier present.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_BASE="$REPO_ROOT/apps/web/src"

# Both surfaces (T07-A3 widening). Either or both may be missing in
# scaffold-only branches — that is not a failure.
SURFACES=(
  "$SRC_BASE/lib/onboarding/recovery"
  "$SRC_BASE/lib/recovery"
)

PATTERN='SpeechSynthesisUtterance|window\.speechSynthesis|\btts\b'

matches=""
for dir in "${SURFACES[@]}"; do
  if [ -d "$dir" ]; then
    found=$(grep -rEn --include='*.ts' --include='*.svelte' "$PATTERN" "$dir" 2>/dev/null || true)
    if [ -n "$found" ]; then
      matches="${matches}${found}"$'\n'
    fi
  fi
done

# Filter out matches inside test fixtures / `__test*` files.
offending=""
if [ -n "$matches" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      */test/*) continue ;;
      *.fixture.*) continue ;;
    esac
    offending="${offending}${line}"$'\n'
  done <<<"$matches"
fi

if [ -n "$offending" ]; then
  echo "[FAIL] check-recovery-surface-lint: forbidden exfil-channel identifier in recovery surface"
  echo "$offending" | sed 's/^/    /'
  exit 1
fi

echo "check-recovery-surface-lint: clean (both src/lib/onboarding/recovery/ and src/lib/recovery/ checked)"
exit 0
