#!/usr/bin/env bash
# verify-tokens.sh — design-token consumption gate.
#
# Per .context/design-system.md "token-only consumption" rule.
# Fails if any file under apps/web/src/ uses a raw hex color, a raw px
# value in style props, or a raw rgba()/rgb()/hsl()/hsla() literal.
#
# Allowlist:
#   - apps/web/src/lib/tokens.ts itself (consumes design-tokens.json).
#   - app.html system-font fallback colors (scaffolder-approved as
#     fallback values used while CSS-variable boot races; tracked).
#   - any file ending in `.tokens.ts` or `.tokens.svelte`.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/apps/web/src"
TEST_DIR="$REPO_ROOT/apps/web/test"

if [ ! -d "$SRC" ]; then
  echo "verify-tokens: nothing to check — apps/web/src/ missing"
  exit 0
fi

violations=0

# Forbidden patterns and the matching include extensions.
# Hex colors:
hex_pattern='#[0-9a-fA-F]{3,8}\b'
# rgba/rgb/hsla/hsl:
rgb_pattern='\b(rgba?|hsla?)\s*\('
# Inline literal px/rem:
inline_px_pattern='style\s*=\s*\{[^}]*['"'"'\"][0-9.]+\s*(px|rem|em)['"'"'\"]'

# Files to scan.
INCLUDES=( --include='*.svelte' --include='*.ts' --include='*.tsx' --include='*.css' --include='*.scss' )
EXCLUDES=(
  --exclude='*.tokens.ts'
  --exclude='*.tokens.svelte'
  --exclude='tokens.ts'                # src/lib/tokens.ts is the typed accessor over design-tokens.json
  --exclude='app.html'                 # contains documented system-font fallback colors
  --exclude-dir='node_modules'
  --exclude-dir='.svelte-kit'
  --exclude-dir='build'
  --exclude-dir='dist'
  --exclude-dir='coverage'
)

check() {
  local label="$1"
  local pattern="$2"
  local matches
  matches=$(grep -rEn "${INCLUDES[@]}" "${EXCLUDES[@]}" "$pattern" "$SRC" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo
    echo "[FAIL] $label"
    echo "$matches" | sed 's/^/    /'
    local count
    count=$(echo "$matches" | wc -l | tr -d ' ')
    violations=$((violations + count))
  fi
}

check "raw hex color (use \$lib/tokens)" "$hex_pattern"
check "raw rgb/rgba/hsl/hsla literal (use \$lib/tokens)" "$rgb_pattern"
check "inline px/rem in style prop (use \$lib/tokens)" "$inline_px_pattern"

if [ "$violations" -gt 0 ]; then
  echo
  echo "verify-tokens: $violations violation(s)."
  exit 1
fi
echo "verify-tokens: clean"
exit 0
