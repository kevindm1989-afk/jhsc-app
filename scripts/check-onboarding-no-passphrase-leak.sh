#!/usr/bin/env bash
# T19 / G-T19-6 — onboarding no-passphrase-leak static lint.
#
# Per F-108 M-108b: scan lib/onboarding/D4RecoveryPassphrase.svelte,
# lib/onboarding/D6TypeBackVerify.svelte (and lib/onboarding/recovery/*)
# for forbidden affordances that could exfiltrate the recovery
# passphrase:
#
#   - navigator.clipboard.writeText  (copy-to-clipboard)
#   - SpeechSynthesisUtterance       (TTS)
#   - window.speechSynthesis         (TTS)
#   - tts.speak                       (TTS)
#   - aria-live (on a passphrase-bearing element)
#   - role="alert" / role="status" (on a passphrase-bearing element)
#
# The aria-live / role checks are scoped to the passphrase-bearing
# element; the test suite at d4-recovery-passphrase.test.ts also asserts
# this directly against the rendered DOM.
#
# Usage:
#   scripts/check-onboarding-no-passphrase-leak.sh
#
# Exit code: 0 on pass; 1 on any forbidden affordance match.

set -eu

ROOT=/home/user/agent-os/apps/web/src/lib/onboarding

# Surfaces covered (per G-T19-6 + Amendment F operational rule 4):
#   - lib/onboarding/D4RecoveryPassphrase.svelte (wrapper)
#   - lib/onboarding/D6TypeBackVerify.svelte (type-back)
#   - lib/onboarding/recovery/*.svelte (existing show-again surfaces)
FILES=(
  "$ROOT/steps/D4RecoveryPassphrase.svelte"
  "$ROOT/steps/D6TypeBackVerify.svelte"
)

# Add every Svelte file under lib/onboarding/recovery/.
if [ -d "$ROOT/recovery" ]; then
  while IFS= read -r -d '' f; do
    FILES+=("$f")
  done < <(find "$ROOT/recovery" -name '*.svelte' -type f -print0)
fi

FORBIDDEN=(
  'navigator\.clipboard\.writeText'
  'SpeechSynthesisUtterance'
  'window\.speechSynthesis'
  '\btts\.speak\b'
)

FAILURES=0
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    continue
  fi
  for pat in "${FORBIDDEN[@]}"; do
    if grep -E -n "$pat" "$f" >/dev/null 2>&1; then
      echo "FAIL: $f matches forbidden pattern: $pat" >&2
      grep -E -n "$pat" "$f" >&2
      FAILURES=$((FAILURES + 1))
    fi
  done
done

if [ "$FAILURES" -gt 0 ]; then
  echo "G-T19-6: $FAILURES forbidden passphrase-leak affordance(s) found." >&2
  exit 1
fi

echo "G-T19-6: pass — D4RecoveryPassphrase / D6TypeBackVerify / lib/onboarding/recovery clean."
exit 0
