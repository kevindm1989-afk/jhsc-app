#!/usr/bin/env bash
# verify-key-parity-import.sh — EF cold-start parity-check coverage gate.
#
# Hard rule (ADR-0024 §2): every Edge Function MUST call
# `assertKeyParity()` (from `_shared/key-parity.ts`) on its first
# invocation per process. Without this, an EF process can serve traffic
# under a mismatched key and silently corrupt the audit trail.
#
# Structural enforcement: this script walks `supabase/functions/*/index.ts`
# and asserts each one EITHER:
#   (a) imports `assertKeyParity` from '../_shared/key-parity.ts', AND
#       calls `assertKeyParity(` somewhere in the file; OR
#   (b) is listed in the EXEMPT_DURING_ROLLOUT array below.
#
# The exempt list exists only because ADR-0024 ships the shared module
# in M2 (this PR) and individual EF wiring lands in M2.1..M2.N follow-up
# PRs. Each follow-up PR removes one EF from the exempt list. When the
# list is empty, the rollout is complete and this script becomes a
# pure coverage gate.
#
# A new EF added to `supabase/functions/` MUST EITHER import + call
# `assertKeyParity` OR be added to the exempt list with a comment
# pointing at the rollout PR that will wire it. The CI grep returns
# non-zero on any EF that fits neither category.
#
# Exit codes:
#   0 — every EF either imports+calls or is exempt
#   1 — an EF is missing the import/call AND is not exempt

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EF_DIR="$REPO_ROOT/supabase/functions"

# EFs that are SCAFFOLDED but NOT YET WIRED for the cold-start check.
# Each rollout PR removes one entry. When the list is empty, every EF
# is wired and the gate is fully enforcing.
#
# Format: EF directory name (the slug between supabase/functions/ and
# /index.ts). One per line. Comments allowed (lines starting with #).
EXEMPT_DURING_ROLLOUT=(
  "auth-op"        # rollout: M2.1
  "committee-op"   # rollout: M2.1
  "concern-op"     # rollout: M2.2
  "mint-session"   # rollout: M2.3 (special — pre-mint path; check runs AFTER mint validation)
  "reprisal-op"    # rollout: M2.2
  "t07-op"         # rollout: M2.2
  "t14-op"         # rollout: M2.2
)

violations=0
for ef_index in "$EF_DIR"/*/index.ts; do
  if [ ! -f "$ef_index" ]; then continue; fi
  ef_slug="$(basename "$(dirname "$ef_index")")"

  # Is this EF in the exempt list?
  exempt=0
  for x in "${EXEMPT_DURING_ROLLOUT[@]}"; do
    if [ "$x" = "$ef_slug" ]; then exempt=1; break; fi
  done

  # Does it import + call assertKeyParity?
  has_import=0
  has_call=0
  if grep -qF "assertKeyParity" "$ef_index" 2>/dev/null; then
    # Look for both the import line and the call site.
    if grep -qE "import[^;]*assertKeyParity[^;]*from.*['\"][^'\"]*_shared/key-parity" "$ef_index" 2>/dev/null; then
      has_import=1
    fi
    if grep -qE "assertKeyParity\s*\(" "$ef_index" 2>/dev/null; then
      has_call=1
    fi
  fi

  if [ "$has_import" -eq 1 ] && [ "$has_call" -eq 1 ]; then
    continue  # OK — wired
  fi
  if [ "$exempt" -eq 1 ]; then
    continue  # OK — explicitly exempt
  fi

  echo "verify-key-parity-import: FAIL — EF '$ef_slug' is not wired AND not exempt" >&2
  echo "  expected: import assertKeyParity from '../_shared/key-parity.ts'" >&2
  echo "            AND a call site 'assertKeyParity(...)' inside Deno.serve" >&2
  echo "  OR: add '$ef_slug' to EXEMPT_DURING_ROLLOUT with a rollout-PR comment" >&2
  violations=$((violations + 1))
done

if [ "$violations" -gt 0 ]; then
  echo "verify-key-parity-import: $violations violation(s) — ADR-0024 §2" >&2
  exit 1
fi

echo "verify-key-parity-import: OK (rollout in progress; ${#EXEMPT_DURING_ROLLOUT[@]} EF(s) still exempt)"
exit 0
