#!/usr/bin/env bash
# verify-session-live-uniformity.sh — F-116 enforcement uniformity gate.
#
# Hard rule (ADR-0023 Amendment A): every Edge Function op dispatcher
# MUST call `session_is_live(jti)` at the top of every privileged op,
# OR be named in the `MINT_SESSION_PATHS` allowlist (the mint paths
# are the ONE legitimate exemption, compensated by F-128's post-mint
# EXISTS check).
#
# This script structurally enforces the rule by greping each
# `supabase/functions/*/index.ts` for ONE of:
#   (a) An import of `assertSessionLive` from `../_shared/...` AND a
#       call to `assertSessionLive(` somewhere in the file (the
#       TS-side precheck pattern), OR
#   (b) The EF slug appearing on the EXEMPT_DURING_ROLLOUT list below
#       (the rollout is gradual — each follow-up PR moves one EF
#       from exempt to wired; when the list is empty, this gate is
#       fully enforcing).
#
# In addition, the script asserts the closed-set invariant on the
# allowlist by reading `supabase/functions/_shared/session-live-allowlist.ts`
# and confirming `MINT_SESSION_PATHS` is exactly `['mint-session/challenge',
# 'mint-session/assert']`. Any expansion requires a new ADR-0023
# amendment + a corresponding edit here.
#
# A new EF added under `supabase/functions/` MUST EITHER import + call
# the helper OR be added to the exempt list with a rollout-PR comment.
# The script returns non-zero on any EF that fits neither category.
#
# Exit codes:
#   0 — every EF either is wired or is exempt; allowlist invariant holds
#   1 — an EF is missing the import/call AND is not exempt, OR the
#       allowlist constant deviates from its expected literal shape

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EF_DIR="$REPO_ROOT/supabase/functions"
ALLOWLIST_FILE="$EF_DIR/_shared/session-live-allowlist.ts"

# EFs that are SCAFFOLDED but NOT YET WIRED for the TS-side
# session_is_live precheck. The SECURITY DEFINER RPCs they call
# continue to enforce session_is_live() inside each RPC body (the
# existing pattern), so these EFs are NOT live-bug-bearing — but
# they don't yet have the structural belt-and-braces TS-side
# precheck ADR-0023 Amendment A specifies.
#
# Each rollout PR removes one entry. Format: EF directory name
# (the slug between supabase/functions/ and /index.ts). One per
# array entry. Comments allowed on adjacent lines.
EXEMPT_DURING_ROLLOUT=(
  # auth-op + committee-op wired in M1.1 — removed.
  # concern-op + reprisal-op + t07-op + t14-op wired in M1.2 — removed.
  # mint-session is on the FORMAL ALLOWLIST below, not the rollout
  # exempt list — its exemption is permanent (compensated by F-128).
)

# F-122 closed allowlist — the ONLY EFs permanently exempt from the
# precheck. Compensated by F-128 (post-mint EXISTS check in
# mint-session/index.ts). Expansion requires a new ADR-0023 amendment.
#
# bootstrap-first-co-chair (ADR-0025) is exempt for the same structural
# reason as mint-session: it runs on a cold instance with ZERO users and no
# session to assert. Its compensating control is the SQL one-shot guard
# (advisory-lock + count=0, mint_writer-only) — strictly stronger than a
# session check, since it can succeed at most once for the project's lifetime.
#
# redeem-invite (ADR-0029 §3.18 / F-168) is exempt for the same structural
# reason: the INVITEE has no JWT (no session yet — the redeem is how they get
# one), so a session_is_live() precheck is tautological, exactly as for
# mint-session and bootstrap-first-co-chair. This entry is the threat-model
# re-pass the F-122/F-123 allowlist-expansion rule mandates: §3.18 IS that
# re-pass (F-168). The redeem path is UNAUTHENTICATED-by-necessity but its SQL
# terminal redeem_invite_complete is mint_writer-ONLY (REVOKE PUBLIC/anon/
# authenticated/service_role — pinned in phase1_redeem_invite_rls.sql), so it
# cannot be reached by a direct anon/authenticated RPC. Unlike bootstrap it is
# NOT one-shot (no EXISTS(users) guard, no BOOTSTRAP_ENABLED); its compensating
# controls are the single-use invite + 15-min TOTP + 5-attempt lock + origin
# pin + key-parity + verified-attestation (§3.18 F-168/F-169/F-170).
PERMANENT_ALLOWLIST=(
  "mint-session"
  "bootstrap-first-co-chair"
  "redeem-invite"
)

# --- 1) Closed-set invariant on the allowlist constant ---
if [ ! -f "$ALLOWLIST_FILE" ]; then
  echo "verify-session-live-uniformity: FAIL — allowlist file missing: $ALLOWLIST_FILE" >&2
  exit 1
fi

# Extract the array literal value and assert it matches the closed set.
# Use a heredoc-friendly grep that matches both 'mint-session/challenge'
# and 'mint-session/assert' on lines inside the MINT_SESSION_PATHS array.
challenge_found=0
assert_found=0
in_array=0
while IFS= read -r line; do
  if echo "$line" | grep -qE "MINT_SESSION_PATHS\s*[:=]"; then
    in_array=1
    continue
  fi
  if [ "$in_array" -eq 1 ]; then
    # End of array (']' character).
    if echo "$line" | grep -q "\]"; then
      in_array=0
    fi
    if echo "$line" | grep -qE "'mint-session/challenge'|\"mint-session/challenge\""; then
      challenge_found=1
    fi
    if echo "$line" | grep -qE "'mint-session/assert'|\"mint-session/assert\""; then
      assert_found=1
    fi
  fi
done < "$ALLOWLIST_FILE"

if [ "$challenge_found" -ne 1 ] || [ "$assert_found" -ne 1 ]; then
  echo "verify-session-live-uniformity: FAIL — MINT_SESSION_PATHS must contain exactly 'mint-session/challenge' + 'mint-session/assert'" >&2
  echo "verify-session-live-uniformity: found challenge=$challenge_found assert=$assert_found" >&2
  echo "verify-session-live-uniformity: ADR-0023 Amendment A §4 (allowlist-expansion rule)" >&2
  exit 1
fi

# Belt-and-braces: assert the file mentions F-122 and F-128 in its
# comment block, so any future PR that nukes the comment block fails
# the gate (catches a class of "comment rot" that the regex above
# could otherwise miss).
if ! grep -qF "F-122" "$ALLOWLIST_FILE"; then
  echo "verify-session-live-uniformity: FAIL — allowlist file MUST name F-122 in its comment block" >&2
  exit 1
fi
if ! grep -qF "F-128" "$ALLOWLIST_FILE"; then
  echo "verify-session-live-uniformity: FAIL — allowlist file MUST name F-128 in its comment block" >&2
  exit 1
fi

# --- 2) Per-EF coverage / exemption check ---
violations=0
for ef_index in "$EF_DIR"/*/index.ts; do
  if [ ! -f "$ef_index" ]; then continue; fi
  ef_slug="$(basename "$(dirname "$ef_index")")"

  # Skip the formal allowlist entries.
  permanent=0
  for x in "${PERMANENT_ALLOWLIST[@]}"; do
    if [ "$x" = "$ef_slug" ]; then permanent=1; break; fi
  done
  if [ "$permanent" -eq 1 ]; then continue; fi

  # Skip the rollout-exempt entries.
  exempt=0
  for x in "${EXEMPT_DURING_ROLLOUT[@]}"; do
    if [ "$x" = "$ef_slug" ]; then exempt=1; break; fi
  done
  if [ "$exempt" -eq 1 ]; then continue; fi

  # Otherwise: require import + call of assertSessionLive.
  has_import=0
  has_call=0
  if grep -qE "import[^;]*assertSessionLive[^;]*from.*['\"][^'\"]*_shared/session-live-precheck" "$ef_index" 2>/dev/null; then
    has_import=1
  fi
  if grep -qE "assertSessionLive\s*\(" "$ef_index" 2>/dev/null; then
    has_call=1
  fi

  if [ "$has_import" -eq 1 ] && [ "$has_call" -eq 1 ]; then
    continue
  fi

  echo "verify-session-live-uniformity: FAIL — EF '$ef_slug' is not wired AND not exempt" >&2
  echo "  expected: import { assertSessionLive } from '../_shared/session-live-precheck.ts'" >&2
  echo "            AND a call 'await assertSessionLive(...)' before the first privileged RPC" >&2
  echo "  OR: add '$ef_slug' to EXEMPT_DURING_ROLLOUT with a rollout-PR comment" >&2
  violations=$((violations + 1))
done

if [ "$violations" -gt 0 ]; then
  echo "verify-session-live-uniformity: $violations violation(s) — ADR-0023 Amendment A" >&2
  exit 1
fi

echo "verify-session-live-uniformity: OK (rollout in progress; ${#EXEMPT_DURING_ROLLOUT[@]} EF(s) still exempt + ${#PERMANENT_ALLOWLIST[@]} permanently allowlisted)"
exit 0
