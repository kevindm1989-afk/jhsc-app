#!/usr/bin/env bash
# verify-no-browser-buffer.sh — browser-bundle hygiene gate.
#
# Hard rule: NO bare `Buffer.` in browser-reachable production crypto / seal /
# queue code. `Buffer` is a Node global; the deployed Vite browser bundle does
# NOT polyfill it, so any `Buffer.from(...)` / `Buffer.alloc(...)` that ships
# to the browser throws `ReferenceError: Buffer is not defined` at runtime.
# This bug was invisible to the Node vitest suite (Buffer is always present in
# Node) until live smoke-testing — see apps/web/test/T08/browser-no-buffer-seal
# .test.ts for the regression proof. Use browser-native encoders instead:
#   - new Uint8Array(new TextEncoder().encode(str))   (UTF-8 encode)
#   - new TextDecoder().decode(bytes)                 (UTF-8 decode)
#   - atob/btoa-based helpers                          (base64)
#
# What this gate forbids: a BARE `Buffer.` (e.g. `Buffer.from`, `Buffer.alloc`,
# `Buffer.concat`) anywhere under the browser-reachable lib surface.
#
# What this gate ALLOWS (so it does not flag the safe patterns):
#   - `typeof Buffer` guards (e.g. `typeof Buffer !== 'undefined' ? ... : ...`)
#     — these branch to an atob/btoa fallback in the browser and only use
#     Buffer when it actually exists (Node / SSR). See jwt-claims.ts,
#     onboarding/recovery-blob-import.ts, onboarding/recovery-blob-download.ts.
#   - the test-only in-memory store doubles (memory-*-store.ts) and the
#     test-shaped *-core.ts files that are NOT on a browser production path
#     (the production reprisal path uses concerns/seal.ts; work-refusal / s51
#     production isn't built yet). These are excluded by path below.
#
# Scope: apps/web/src/lib/**. Tests (apps/web/test/**) are intentionally NOT
# scanned — the regression test deliberately references Buffer to stash/restore
# the global.
#
# Exit codes:
#   0 — clean
#   1 — at least one bare `Buffer.` found on a browser-reachable path

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB_DIR="$REPO_ROOT/apps/web/src/lib"

if [ ! -d "$LIB_DIR" ]; then
  echo "verify-no-browser-buffer: no lib dir at $LIB_DIR; nothing to check"
  exit 0
fi

# Test-only files that legitimately use Buffer and are NOT instantiated on a
# browser production code path. Matched as basename suffixes / exact relative
# paths (anchored to apps/web/src/lib/).
#
#   - memory-*-store.ts        : in-memory test doubles (auth, reprisal,
#                                work-refusal, s51-evidence, export).
#   - reprisal/reprisal-core.ts
#   - work-refusal/work-refusal-core.ts
#   - s51-evidence/s51-evidence-core.ts
#                              : test-shaped cores. The PRODUCTION reprisal
#                                path imports seal from concerns/seal.ts;
#                                work-refusal / s51 production isn't built yet.
is_excluded() {
  local rel="$1"
  case "$rel" in
    *memory-store.ts) return 0 ;;
    *memory-*-store.ts) return 0 ;;
    reprisal/reprisal-core.ts) return 0 ;;
    work-refusal/work-refusal-core.ts) return 0 ;;
    s51-evidence/s51-evidence-core.ts) return 0 ;;
  esac
  return 1
}

violations=0

# Find every TS/Svelte file under the lib surface and scan for a BARE `Buffer.`
# A bare Buffer member access is `Buffer.` NOT immediately preceded by the
# `typeof ` keyword. The negative-lookbehind isn't available in BRE/ERE grep,
# so we do it in two steps: collect `Buffer.` hits, then drop the ones whose
# `Buffer.` token is part of a `typeof Buffer` expression on the same line by
# excluding lines where EVERY `Buffer` occurrence is preceded by `typeof `.
while IFS= read -r -d '' file; do
  rel="${file#"$LIB_DIR"/}"
  if is_excluded "$rel"; then
    continue
  fi
  # Lines containing a `Buffer.` member access.
  hits=$(grep -nE 'Buffer\.' "$file" 2>/dev/null || true)
  [ -z "$hits" ] && continue
  # Filter out the safe / non-code lines:
  #   1) Comment lines — a `Buffer.` mentioned in a `//` line comment or a
  #      `*`-prefixed block-comment line (e.g. the seal.ts header explaining
  #      the OLD `Buffer.from(...)` form) is documentation, not shipped code.
  #   2) Guarded lines — a line carrying BOTH a runtime guard (`typeof Buffer`
  #      OR `typeof atob` OR `typeof btoa`) AND a `Buffer.` is the safe
  #      atob/btoa-fallback ternary: the `Buffer.` branch is dead in the
  #      browser (where the guard picks the atob/btoa path) and only runs in
  #      Node / SSR where Buffer exists. See jwt-claims.ts (typeof atob guard)
  #      and onboarding/recovery-blob-{import,download}.ts (typeof Buffer).
  bare=$(echo "$hits" \
    | grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' \
    | grep -vE 'typeof[[:space:]]+(Buffer|atob|btoa)' \
    || true)
  if [ -n "$bare" ]; then
    echo
    echo "[FAIL] bare Buffer. on a browser-reachable path: $rel"
    echo "$bare" | sed 's/^/    /'
    count=$(echo "$bare" | wc -l | tr -d ' ')
    violations=$((violations + count))
  fi
done < <(find "$LIB_DIR" -type f \( -name '*.ts' -o -name '*.svelte' \) -print0)

if [ "$violations" -gt 0 ]; then
  echo
  echo "verify-no-browser-buffer: $violations bare Buffer. usage(s) on browser paths."
  echo "Use new TextEncoder()/TextDecoder() (UTF-8) or an atob/btoa base64 helper."
  echo "If the usage is genuinely Node-only, guard it with 'typeof Buffer !== \"undefined\"'."
  exit 1
fi

echo "verify-no-browser-buffer: clean (apps/web/src/lib)"
exit 0
