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
#
#    Retry loop — guard against the Supabase CLI ES256 leading-zero bug.
#    The CLI emits P-256 coordinates (x/y/d) as base64url WITHOUT zero-
#    padding raw-integer representations, so ~1.17% of generations produce
#    a component whose high byte is 0x00 that gets trimmed during emit.
#    GoTrue then fatals at startup with `invalid "x" length (31) for curve
#    "P-256"` (or "y" / "d") because each P-256 coordinate MUST be exactly
#    32 bytes — RFC 7518 §6.2.1. A correctly-padded coordinate base64url-
#    encodes to 43 chars (no `=` padding per JWS / JWK convention); a
#    trimmed coordinate base64url-encodes to 42. We retry generation
#    until all three components are 43 chars. P(success per attempt)
#    ≥ 98.83%, so 10 attempts give a > 1 - 10^-19 confidence ceiling.
echo "==> generating the ES256 signing key (single key — local CLI limit)"
attempt=0
while : ; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 10 ]; then
    echo "ERROR: 10 attempts exhausted generating a well-formed ES256 key — aborting." >&2
    echo "       This is statistically improbable (P ~ 10^-19); the Supabase CLI's" >&2
    echo "       gen-signing-key behaviour may have changed. Inspect $KEYS_FILE." >&2
    exit 1
  fi
  k1="$(supabase gen signing-key --algorithm ES256)"
  printf '%s\n' "$k1" | jq -s '[.[] | if type=="array" then .[] else . end]' > "$KEYS_FILE"
  # Each P-256 component (x / y / d) base64url-encoded without padding
  # should be exactly 43 chars (= ceil(32 bytes * 8 / 6)). 42 chars means
  # the CLI trimmed a leading-zero byte from the raw-integer form.
  x_len=$(jq -r '.[0].x | length' "$KEYS_FILE")
  y_len=$(jq -r '.[0].y | length' "$KEYS_FILE")
  d_len=$(jq -r '.[0].d | length' "$KEYS_FILE")
  if [ "$x_len" = "43" ] && [ "$y_len" = "43" ] && [ "$d_len" = "43" ]; then
    if [ "$attempt" -gt 1 ]; then
      echo "    (succeeded on attempt $attempt — CLI leading-zero flake skipped)"
    fi
    break
  fi
  echo "    attempt $attempt: short component (x=$x_len y=$y_len d=$d_len chars; expected 43), regenerating..."
done

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
