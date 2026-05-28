#!/usr/bin/env bash
# check-libsodium-sumo-locked.sh — lockfile-lint for the libsodium dep.
#
# Source obligation: G-T07-12 "pnpm lockfile-lint rule asserting
# libsodium-wrappers-sumo is the resolved dep in production builds".
#
# Why this matters:
#   - The recovery-blob path (apps/web/src/lib/crypto/recovery-blob.ts) calls
#     `crypto_pwhash` for Argon2id key derivation (F-08 floor).
#   - The standard `libsodium-wrappers` build omits `crypto_pwhash`; only the
#     `-sumo` build exposes it.
#   - ADR-0003 Amendment G enforces fail-closed AT RUNTIME when the function
#     is missing, but a deployment that accidentally resolves the non-sumo
#     dep would only fail when a user attempts D.4 onboarding — too late for
#     a healthy production posture. The boot-time assertion
#     (`assertArgon2idAvailable` in recovery-blob.ts) catches it on first
#     paint; this script catches it at PR-time, before any container is built.
#
# What this script verifies:
#   1. `apps/web/package.json` lists `libsodium-wrappers-sumo` as a dep.
#   2. `apps/web/package.json` does NOT list `libsodium-wrappers` (the
#      non-sumo build — easy accidental revert).
#   3. The pnpm lockfile resolves `libsodium-wrappers-sumo` and does NOT
#      resolve `libsodium-wrappers` as a direct dep of the workspace.
#
# Exit codes:
#   0 — all three assertions hold
#   1 — any assertion fails (specific failure printed)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$REPO_ROOT/apps/web/package.json"
LOCK="$REPO_ROOT/pnpm-lock.yaml"

if [ ! -f "$PKG" ]; then
  echo "check-libsodium-sumo-locked: missing $PKG"
  exit 1
fi
if [ ! -f "$LOCK" ]; then
  echo "check-libsodium-sumo-locked: missing $LOCK"
  exit 1
fi

# (1) package.json declares -sumo.
if ! grep -Eq '"libsodium-wrappers-sumo"\s*:' "$PKG"; then
  echo "check-libsodium-sumo-locked: apps/web/package.json does NOT depend on libsodium-wrappers-sumo"
  echo "  Required by G-T07-12 (Argon2id / F-08 floor). Add it to dependencies."
  exit 1
fi

# (2) package.json does NOT declare the non-sumo build.
if grep -Eq '"libsodium-wrappers"\s*:' "$PKG"; then
  echo "check-libsodium-sumo-locked: apps/web/package.json still depends on libsodium-wrappers (non-sumo)"
  echo "  The non-sumo build OMITS crypto_pwhash. Remove it; libsodium-wrappers-sumo is the only allowed variant."
  exit 1
fi

# (3) lockfile resolves -sumo and does NOT directly resolve non-sumo.
# Pin via a workspace-importer block ("apps/web:" → "dependencies:" → "libsodium-wrappers-sumo:").
# We grep the simpler invariant: -sumo appears as a key, non-sumo does not appear as a top-level
# "libsodium-wrappers:" key (avoiding false positives from the sumo substring).
if ! grep -Eq '^\s+libsodium-wrappers-sumo:\s*' "$LOCK"; then
  echo "check-libsodium-sumo-locked: pnpm-lock.yaml does not resolve libsodium-wrappers-sumo"
  echo "  Run 'pnpm install' after updating apps/web/package.json."
  exit 1
fi
# Match `libsodium-wrappers:` only when NOT followed by `-sumo` — the negative
# lookahead is awk's lookbehind would be cleaner but stay portable.
if grep -E '^\s+libsodium-wrappers:\s*' "$LOCK" | grep -vq 'sumo'; then
  echo "check-libsodium-sumo-locked: pnpm-lock.yaml still resolves libsodium-wrappers (non-sumo) as a direct dep"
  echo "  Remove libsodium-wrappers from apps/web/package.json + run 'pnpm install' to refresh the lockfile."
  exit 1
fi

echo "check-libsodium-sumo-locked: OK — libsodium-wrappers-sumo resolved; non-sumo absent from lockfile."
exit 0
