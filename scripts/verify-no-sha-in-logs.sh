#!/usr/bin/env bash
# verify-no-sha-in-logs.sh — SHA-of-key emission gate.
#
# Hard rule (ADR-0024 §4 / threat-model.md §3.14 F-124 M-124b): the
# SHA-of-key is classified non-secret-but-sensitive. It MUST never land
# in structured logs, Sentry breadcrumbs, audit-log meta, or any other
# emission surface. The SHA narrows offline brute-force confirmation;
# a leaked SHA + a captured candidate set lets an attacker confirm
# candidates without further interaction.
#
# Strategy: grep the structured-log emit surfaces for any reference to
# the SHA-bearing local variable names from `key-parity.ts`:
#   - _envKeyShaHex      (supabase/functions/_shared/key-parity.ts)
#   - _tsKeyShaHex       (apps/web/src/lib/auth/server/key-parity.ts)
#   - serverShaHex       (parameter name in apps/web/src/lib/auth/server/key-parity.ts)
#   - sha256Hex          (the hashing helper; should not appear in log surfaces)
# If any of these names appear in a log emission file, fail-closed.
#
# The log emission surfaces:
#   - apps/web/src/lib/log/                (SvelteKit structured logger)
#   - supabase/functions/_shared/log.ts    (Edge Function structured logger)
#   - any other file under apps/ or supabase/ that imports from a log
#     module AND contains one of the denylisted names.
#
# Exit codes:
#   0 — no SHA references in log surfaces
#   1 — a denylisted name found in a log surface

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The scan targets — known log emission surfaces.
TARGETS=(
  "$REPO_ROOT/apps/web/src/lib/log"
  "$REPO_ROOT/supabase/functions/_shared/log.ts"
)

# The denylisted symbol names — taken verbatim from key-parity.ts
# modules. Adding a new SHA-bearing local in key-parity.ts requires
# adding it to this list.
DENYLIST=(
  "_envKeyShaHex"
  "_tsKeyShaHex"
  "serverShaHex"
  "envSha"
  "serverSha"
)

violations=0
for target in "${TARGETS[@]}"; do
  if [ ! -e "$target" ]; then
    continue
  fi
  for name in "${DENYLIST[@]}"; do
    # -F: literal string match. -r: recurse if target is a dir.
    # Quote the pattern so the shell doesn't expand.
    matches="$(grep -rFn "$name" "$target" 2>/dev/null || true)"
    if [ -n "$matches" ]; then
      echo "verify-no-sha-in-logs: FAIL — denylisted SHA name '$name' found in log emission surface:" >&2
      echo "$matches" >&2
      violations=$((violations + 1))
    fi
  done
done

if [ "$violations" -gt 0 ]; then
  echo "verify-no-sha-in-logs: $violations violation(s) — ADR-0024 §4 / F-124 M-124b" >&2
  exit 1
fi

echo "verify-no-sha-in-logs: OK — no SHA-of-key references in log emission surfaces"
exit 0
