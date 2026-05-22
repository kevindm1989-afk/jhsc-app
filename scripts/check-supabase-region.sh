#!/usr/bin/env bash
# check-supabase-region.sh — Canadian-region pin sanity check.
#
# Source: ADR-0001 (Supabase Cloud `ca-central-1`).
#
# Scope at scaffold: verify the config note exists in supabase/config.toml
# and that no .env.example default points anywhere other than the local
# stack or a Canadian-region URL. The runtime region verification happens
# at test setup in apps/web/test/_helpers/supabase-test.ts (per the test
# harness contract).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CONFIG="$REPO_ROOT/supabase/config.toml"
ENV_EXAMPLE="$REPO_ROOT/.env.example"

violations=0

if [ ! -f "$CONFIG" ]; then
  echo "[FAIL] $CONFIG missing — Supabase region cannot be pinned"
  violations=$((violations+1))
else
  if ! grep -Eq 'region|ca-central-1|Canadian' "$CONFIG"; then
    echo "[FAIL] $CONFIG missing the 'ca-central-1' / Canadian-region note (ADR-0001)"
    violations=$((violations+1))
  fi
fi

if [ -f "$ENV_EXAMPLE" ]; then
  # Catch a US-region Supabase URL hardcoded into .env.example.
  if grep -Ei 'supabase\.co' "$ENV_EXAMPLE" | grep -Eiv 'localhost|ca-central|\.example\.|\<your-project\>' >/dev/null 2>&1; then
    echo "[FAIL] $ENV_EXAMPLE references a non-Canadian Supabase URL"
    violations=$((violations+1))
  fi
fi

if [ "$violations" -gt 0 ]; then
  echo "check-supabase-region: $violations issue(s)."
  exit 1
fi
echo "check-supabase-region: ok"
exit 0
