#!/usr/bin/env bash
# verify-i18n.sh — raw-English-string detection in Svelte component templates.
#
# Source: ADR-0009 (i18n catalog from day 1). Components MUST read visible
# text via `t('catalog.key')` from $lib/i18n. Raw English strings in
# template positions fail this gate.
#
# Heuristic (intentionally conservative at scaffold; tighten as the
# component set grows):
#   - Looks for adjacent letter-letter-space-letter sequences appearing
#     inside Svelte template syntax — i.e., between > and < — that exceed
#     12 characters and do NOT contain `{` or `}` (template interpolation).
#   - Allows code-comments, attribute values, and developer-only strings
#     in .ts files.
#
# False positives go on the ALLOWLIST below. Each entry names a file +
# the rationale.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/apps/web/src"

if [ ! -d "$SRC" ]; then
  echo "verify-i18n: nothing to check — apps/web/src/ missing"
  exit 0
fi

# Files allowed to contain raw English text in templates.
ALLOWLIST=(
  "$SRC/app.html"           # static fallback shell, system-font note
  # ADR-0025 A3: the cold-instance bootstrap UI is an operator-only
  # ephemeral page the deploying operator visits once then DELETES along
  # with the Edge Function (A4). Never seen by a committee worker; AODA
  # bilingual surface doesn't apply.
  "$SRC/routes/bootstrap/+page.svelte"
)

violations=0
total_scanned=0

check_file() {
  local f="$1"
  for allow in "${ALLOWLIST[@]}"; do
    if [ "$f" = "$allow" ]; then return 0; fi
  done

  # Scan content between > and < that is at least 12 chars long and looks
  # like prose (two or more space-separated words, none of which contain
  # `{` interpolation). This will miss many single-word labels — acceptable
  # at scaffold; tighten via a real parser when component count grows.
  local matches
  matches=$(awk '
    /<script|<style/ { in_skip=1 }
    /<\/script|<\/style/ { in_skip=0; next }
    !in_skip {
      # crude: pick contents between >...< on a single line
      s = $0
      while (match(s, />[^<{}]{12,}</)) {
        block = substr(s, RSTART+1, RLENGTH-2)
        # require 2+ space-separated words of 3+ letters
        if (block ~ /[A-Za-z]{3,}[[:space:]]+[A-Za-z]{3,}/) {
          # skip pure-whitespace and t() expressions
          if (block !~ /^[[:space:]]*$/) {
            print FILENAME":"NR": "block
          }
        }
        s = substr(s, RSTART+RLENGTH)
      }
    }
  ' "$f")
  if [ -n "$matches" ]; then
    echo
    echo "[FAIL] raw English string in $f"
    echo "$matches" | sed 's/^/    /'
    local count
    count=$(echo "$matches" | wc -l | tr -d ' ')
    violations=$((violations + count))
  fi
  total_scanned=$((total_scanned+1))
}

while IFS= read -r -d '' f; do
  check_file "$f"
done < <(find "$SRC" -name '*.svelte' -print0)

if [ "$violations" -gt 0 ]; then
  echo
  echo "verify-i18n: $violations raw-string violation(s). Move strings to i18n/en-CA.json and consume via t()."
  exit 1
fi
echo "verify-i18n: clean ($total_scanned Svelte file(s) scanned)"
exit 0
