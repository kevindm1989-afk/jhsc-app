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

# strip_noise — emit "<file>:<lineno>: <code>" for each source line with
# comments AND var(--token, …) fallback expressions removed. This is what
# makes the gate flag only genuine raw colors in LIVE style values, not:
#   - design-token fallbacks (e.g. `color: var(--c, #fff)` — the documented
#     boot-race defense; the fallback is intentional, the token is canonical), or
#   - colors appearing in code comments / prose.
# Tracks /* */ and <!-- --> across lines; strips // line comments; removes
# var(...) expressions innermost-first so nested var(--a, var(--b, #fff)) is
# fully elided.
strip_noise() {
  awk '
    # Remove every var(...) expression (balanced parens) so design-token
    # fallbacks like var(--c, #fff) or var(--c, rgba(...)) — including nested
    # forms — are elided; genuine bare colors NOT inside var() survive.
    function strip_var(s,   start, j, n, c, depth, end) {
      while ((start = index(s, "var(")) > 0) {
        n = length(s); depth = 0; end = 0
        for (j = start + 3; j <= n; j++) {
          c = substr(s, j, 1)
          if (c == "(") depth++
          else if (c == ")") { depth--; if (depth == 0) { end = j; break } }
        }
        if (end == 0) { s = substr(s, 1, start - 1); break }   # unbalanced (spans lines)
        s = substr(s, 1, start - 1) substr(s, end + 1)
      }
      return s
    }
    {
      s = $0
      if (in_block) { idx = index(s, "*/"); if (idx == 0) next; s = substr(s, idx + 2); in_block = 0 }
      if (in_html)  { idx = index(s, "-->"); if (idx == 0) next; s = substr(s, idx + 3); in_html  = 0 }
      while ((b = index(s, "/*")) > 0) {
        rest = substr(s, b + 2); e = index(rest, "*/")
        if (e == 0) { s = substr(s, 1, b - 1); in_block = 1; break }
        s = substr(s, 1, b - 1) substr(rest, e + 2)
      }
      while ((b = index(s, "<!--")) > 0) {
        rest = substr(s, b + 4); e = index(rest, "-->")
        if (e == 0) { s = substr(s, 1, b - 1); in_html = 1; break }
        s = substr(s, 1, b - 1) substr(rest, e + 3)
      }
      if ((b = index(s, "//")) > 0) s = substr(s, 1, b - 1)
      s = strip_var(s)
      print FILENAME ":" FNR ": " s
    }
  ' "$1"
}

check() {
  local label="$1"
  local pattern="$2"
  local matches=""
  while IFS= read -r -d '' f; do
    local m
    m=$(strip_noise "$f" | grep -E "$pattern" || true)
    if [ -n "$m" ]; then matches+="$m"$'\n'; fi
  done < <(
    find "$SRC" \
      -type d \( -name node_modules -o -name .svelte-kit -o -name build -o -name dist -o -name coverage \) -prune -o \
      -type f \( -name '*.svelte' -o -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.scss' \) \
      ! -name '*.tokens.ts' ! -name '*.tokens.svelte' ! -name 'tokens.ts' ! -name 'app.html' \
      -print0
  )
  matches=$(printf '%s' "$matches" | sed '/^$/d')
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
