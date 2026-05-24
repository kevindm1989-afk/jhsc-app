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
  "$ROOT/OnboardingFlow.svelte"
)

# Add every Svelte file under lib/onboarding/recovery/.
if [ -d "$ROOT/recovery" ]; then
  while IFS= read -r -d '' f; do
    FILES+=("$f")
  done < <(find "$ROOT/recovery" -name '*.svelte' -type f -print0)
fi

# Forbidden affordances anywhere in the passphrase-bearing surfaces.
FORBIDDEN=(
  'navigator\.clipboard\.writeText'
  'SpeechSynthesisUtterance'
  'window\.speechSynthesis'
  '\btts\.speak\b'
  # autofocus on the passphrase-bearing surfaces can race the audit-
  # before-side-effect contract; manage focus deterministically.
  '\bautofocus\b'
)

# Forbidden ONLY on the strictest set (the wrapper files that render the
# passphrase <code> directly). The chrome (OnboardingFlow) legitimately
# uses aria-live / role="alert" / role="status" for the wizard's step-
# change announcer and error toasts; those are NOT on the passphrase-
# bearing element. The wrapper files MUST NOT decorate the visible
# passphrase region with any live-region attribute (F-108 M-108c — TTS
# exfiltration + AODA cognitive-accessibility defense).
STRICT_FILES=(
  "$ROOT/steps/D4RecoveryPassphrase.svelte"
  "$ROOT/steps/D6TypeBackVerify.svelte"
)
if [ -d "$ROOT/recovery" ]; then
  while IFS= read -r -d '' f; do
    STRICT_FILES+=("$f")
  done < <(find "$ROOT/recovery" -name '*.svelte' -type f -print0)
fi

STRICT_FORBIDDEN=(
  'aria-live'
  'role="alert"'
  'role="status"'
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

for f in "${STRICT_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    continue
  fi
  for pat in "${STRICT_FORBIDDEN[@]}"; do
    # Narrow allowlist of legitimate uses on these surfaces (rendered
    # OUTSIDE the passphrase <code>):
    #   - data-testid="d4-error" (D.4 error toast; argon2-unavailable
    #     surfaces below the passphrase wrapper)
    #   - data-testid="show-again-danger-toast" (recovery-screen's
    #     audit-failed danger toast; M-54b/c)
    # We also ignore comment lines (// or /* ... */ or HTML <!-- ... -->).
    matches=$(grep -E -n "$pat" "$f" \
      | grep -v 'data-testid="d4-error"' \
      | grep -v 'data-testid="show-again-danger-toast"' \
      | grep -Ev '^[0-9]+:\s*(\/\/|\/\*|\*|<!--)' \
      || true)
    if [ -n "$matches" ]; then
      echo "FAIL: $f matches strict-forbidden pattern: $pat" >&2
      echo "$matches" >&2
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
