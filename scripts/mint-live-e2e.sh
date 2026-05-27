#!/usr/bin/env bash
# ============================================================================
# mint-session live-stack e2e (TRUST LAYER) — ADR-0023 / threat-model §3.12.
#
# Proves, against a REAL Supabase stack, that a mint-issued ES256 token is
# trusted by GoTrue/PostgREST via the JWKS and may invoke the mint_writer-only
# RPCs, while anon is denied. The crypto/verification + mint orchestration are
# already covered hermetically (supabase/functions/mint-session/test/*); this
# closes the one gap that needs a live stack.
#
# REQUIREMENTS: Docker (running), the Supabase CLI, Deno, and jq.
# NOT wired into CI by default (see README for how to add it once confirmed).
#
# Run from the repo root in a Docker-capable environment:
#   bash scripts/mint-live-e2e.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

for tool in supabase deno jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 2; }
done
if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon not reachable — the Supabase local stack needs Docker." >&2
  exit 2
fi

KEYS_FILE="supabase/signing_keys.local.json"   # gitignored; contains private keys
CONFIG="supabase/config.toml"
CONFIG_BAK="$(mktemp)"
cp "$CONFIG" "$CONFIG_BAK"

cleanup() {
  supabase stop --no-backup >/dev/null 2>&1 || true
  cp "$CONFIG_BAK" "$CONFIG"          # restore config.toml (drops signing_keys_path)
  rm -f "$CONFIG_BAK" "$KEYS_FILE"    # never leave private key material behind
}
trap cleanup EXIT

# 1. Generate ONE ES256 signing key in GoTrue's EXACT format. Letting the CLI
#    author it avoids the "failed to decode signing keys" / "no signing key
#    detected" format errors that hand-rolled JWKs hit; GoTrue rejects Ed25519
#    ("must be one of [RS256 ES256]"), hence ES256.
#    NOTE: the LOCAL Supabase CLI accepts only ONE signing key ("multiple
#    signing keys detected, only 1 signing key is supported"), so the mint
#    function signs with the SAME key GoTrue uses. The separate validation-only
#    mint key (key isolation) is a HOSTED-Supabase property — hosted supports
#    key rotation / multiple JWKS keys; local dev does not. This harness proves
#    the trust + grant boundary; key isolation is verified in the hosted config.
echo "==> generating the ES256 signing key (single key — local CLI limit)"
k1="$(supabase gen signing-key --algorithm ES256)"
printf '%s\n' "$k1" | jq -s '[.[] | if type=="array" then .[] else . end]' > "$KEYS_FILE"

# 2. Point GoTrue at the key set. Insert under the [auth] table ONLY (not
#    [auth.email]). signing_keys_path resolves relative to the supabase/ config
#    directory.
awk '1; /^\[auth\]$/ {print "signing_keys_path = \"./signing_keys.local.json\""}' \
  "$CONFIG" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"

# 3. Bring up the stack (applies migrations 0-3, incl. the mint RPCs + grants).
#    Force a clean restart: `supabase start` is a no-op if the stack is already
#    running, so config.toml changes (signing_keys_path) would NOT take effect.
echo "==> supabase stop (ensure the new signing key config is loaded on start)"
supabase stop --no-backup >/dev/null 2>&1 || true
echo "==> supabase start"
supabase start

# 4. Run the trust e2e signing with the (single) signing key.
echo "==> running trust e2e"
# shellcheck disable=SC2046  # status -o env emits KEY="value" lines we want as vars
eval "$(supabase status -o env)"   # sets API_URL, ANON_KEY, ...
MINT_SIGNING_JWK="$(jq -c '.[0]' "$KEYS_FILE")" \
SUPABASE_URL="${API_URL:?supabase status did not provide API_URL}" \
SUPABASE_ANON_KEY="${ANON_KEY:?supabase status did not provide ANON_KEY}" \
  deno run --allow-net --allow-env --allow-read scripts/mint-live-e2e.ts

echo "==> done"
