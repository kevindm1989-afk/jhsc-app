#!/usr/bin/env bash
# verify-no-third-party-js.sh — bundle hygiene gate.
#
# Hard rule (JHSC-APP-PLAN.md §7 / ADR-0010): no third-party JS at runtime.
# The Sentry SDK is bundled; the SDK CDN URL must never appear in the built
# bundle. Same for Google Fonts, Google APIs, GTM, and generic CDN-shaped
# script URLs.
#
# Strategy:
#   1. If a built bundle exists under apps/web/build/, grep it.
#   2. If no built bundle exists, grep the SOURCE under apps/web/src/ as
#      a pre-build sanity check.
#
# The CI workflow runs `pnpm build` BEFORE invoking this script so the
# bundle-grep branch runs in CI.
#
# Forbidden patterns (heuristic but loud):
#   - browser.sentry-cdn.com
#   - js.sentry-cdn.com
#   - fonts.googleapis.com
#   - fonts.gstatic.com
#   - googletagmanager.com
#   - www.google-analytics.com
#   - cdn.jsdelivr.net  (catch-all CDN; bundles must self-host)
#   - unpkg.com
#   - cdnjs.cloudflare.com
#   - HMAC_PSEUDONYM_KEY  (browser must NEVER ship the pseudonym key)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$REPO_ROOT/apps/web/build"
SRC_DIR="$REPO_ROOT/apps/web/src"

scan_target=""
if [ -d "$BUILD_DIR" ]; then
  scan_target="$BUILD_DIR"
elif [ -d "$SRC_DIR" ]; then
  echo "verify-no-third-party-js: no built bundle yet; scanning SOURCE as fallback."
  scan_target="$SRC_DIR"
else
  echo "verify-no-third-party-js: no scan target; nothing to check"
  exit 0
fi

violations=0

check_pattern() {
  local label="$1"
  local pattern="$2"
  local matches
  matches=$(grep -rEn --include='*.js' --include='*.ts' --include='*.svelte' \
    --include='*.html' --include='*.css' --include='*.json' \
    "$pattern" "$scan_target" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo
    echo "[FAIL] $label"
    echo "$matches" | sed 's/^/    /' | head -50
    local count
    count=$(echo "$matches" | wc -l | tr -d ' ')
    violations=$((violations + count))
  fi
}

check_pattern "Sentry CDN (must bundle the SDK)"        'sentry-cdn\.com'
check_pattern "Google Fonts (no Google Fonts — system stack only)" 'fonts\.(googleapis|gstatic)\.com'
check_pattern "Google Tag Manager / Analytics"          '(googletagmanager|google-analytics)\.com'
check_pattern "Generic CDN (jsdelivr / unpkg / cdnjs)"  '(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)'
check_pattern "HMAC_PSEUDONYM_KEY in bundle (env-var name leak)" 'HMAC_PSEUDONYM_KEY'

if [ "$violations" -gt 0 ]; then
  echo
  echo "verify-no-third-party-js: $violations match(es) — bundle must be free of third-party JS."
  exit 1
fi
echo "verify-no-third-party-js: clean ($(basename "$scan_target"))"
exit 0
