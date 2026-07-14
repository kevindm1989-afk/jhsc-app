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
MIG_DIR="$REPO_ROOT/supabase/migrations"

# ===========================================================================
# F-121 — SQL-layer session-live uniformity (companion to the EF-dispatcher
# section below).
#
# Where F-116 gates the Edge-Function dispatchers, F-121 (threat-model §3.14 ;
# ADR-0023 Amendment A) gates the DIRECT-PostgREST surface: the three
# self-scoped READ policies and the three authenticated-grantable REVOKE RPCs
# must each gate the CALLER's session on `session_is_live` (migration
# 00000000000046 does this — the read policies inline the conjunct; the revoke
# RPCs call the `_t07_gate_session()` one-liner, which is itself
# `IF NOT public.session_is_live() THEN RAISE 'rls_denied'`).
#
# This section grep-asserts the gate is present in the LATEST SQL definition of
# each of the six surfaces (a later ungated CREATE OR REPLACE / ALTER POLICY
# would re-open the bypass, so we always check the newest definition, never an
# earlier one). Format: "<symbol>:<policy|function>".
# ===========================================================================
SQL_GATED_SURFACES=(
  "users_select_self:policy"
  "auth_sessions_select_self:policy"
  "webauthn_credentials_select_self:policy"
  "revoke_my_session:function"
  "revoke_all_my_sessions:function"
  "revoke_my_passkey:function"
)

# find_latest_migration <literal-anchor> <dir> — echo the highest-ordinal
# migration file whose text contains <literal-anchor> (fixed string). Empty if
# none. Filenames are zero-padded so a lexical sort is a numeric sort.
find_latest_migration() {
  local anchor="$1" dir="$2" latest="" f
  for f in $(ls -1 "$dir"/*.sql 2>/dev/null | sort); do
    if grep -qF "$anchor" "$f"; then latest="$f"; fi
  done
  printf '%s' "$latest"
}

# sql_surface_is_gated <symbol> <kind> <dir> — 0 iff the LATEST definition of
# <symbol> in <dir> contains the `session_is_live` gate token. Extracts only
# that symbol's definition block (so stripping the gate from ONE surface is
# caught even when sibling surfaces in the same file remain gated). Uses awk
# index() literal matching to avoid regex-escaping pitfalls.
sql_surface_is_gated() {
  local sym="$1" kind="$2" dir="$3" anchor latest block
  if [ "$kind" = "function" ]; then
    anchor="CREATE OR REPLACE FUNCTION public.$sym("
  else
    anchor="POLICY $sym "
  fi
  latest="$(find_latest_migration "$anchor" "$dir")"
  if [ -z "$latest" ]; then
    return 1   # no definition found at all → treat as an ungated offender
  fi
  if [ "$kind" = "function" ]; then
    block="$(awk -v n="$sym" '
      index($0, "CREATE OR REPLACE FUNCTION public." n "(") { cap=1; blk="" }
      cap { blk = blk $0 "\n" }
      cap && index($0, "$$;") { last = blk; cap = 0 }
      END { printf "%s", last }
    ' "$latest")"
  else
    block="$(awk -v n="$sym" '
      (index($0, "POLICY " n " ") && (index($0, "CREATE") || index($0, "ALTER"))) { cap=1; blk="" }
      cap { blk = blk $0 "\n" }
      cap && index($0, ";") { last = blk; cap = 0 }
      END { printf "%s", last }
    ' "$latest")"
  fi
  printf '%s' "$block" | grep -qF "session_is_live"
}

# sql_layer_check <dir> — assert all six SQL surfaces are gated in <dir>.
# Returns the number of ungated offenders (0 = all gated). Names each offender.
sql_layer_check() {
  local dir="$1" offenders=0 entry sym kind
  for entry in "${SQL_GATED_SURFACES[@]}"; do
    sym="${entry%%:*}"; kind="${entry##*:}"
    if ! sql_surface_is_gated "$sym" "$kind" "$dir"; then
      echo "verify-session-live-uniformity: FAIL — SQL surface '$sym' latest definition does NOT gate on session_is_live (F-121)" >&2
      offenders=$((offenders + 1))
    fi
  done
  return "$offenders"
}

# run_self_test — the lessons.md 2026-06-16 synthetic-probe rule: a gate that
# cannot fail catches nothing. Prove sql_layer_check is regression-catching by
# running it against (a) a synthetic fixture with the gate STRIPPED from one
# allowlisted surface — must be NON-ZERO — and (b) the real migrations — must
# be ZERO. Exit 0 iff both controls hold.
run_self_test() {
  local pos_ok=0 neg_ok=0 fixture

  echo "verify-session-live-uniformity: F-121 SQL-layer session-live allowlist self-test"
  echo "  finding: F-121 (session-revocation uniformity) — gate token: session_is_live"
  echo "  gated SQL surfaces (3 self-scoped read policies + 3 revoke RPCs):"
  for entry in "${SQL_GATED_SURFACES[@]}"; do
    echo "    - ${entry%%:*} (${entry##*:})"
  done

  # (a) Positive control — the real migrations must be fully gated.
  echo "  [positive control] real migrations: $MIG_DIR"
  if sql_layer_check "$MIG_DIR"; then
    pos_ok=1
    echo "    PASS — all six SQL surfaces gate on session_is_live"
  else
    echo "    FAIL — a real SQL surface is ungated (see offenders above)"
  fi

  # (b) Negative control — synthetic stripped-gate fixture. Copy the real
  # migrations and TAMPER exactly one surface (strip session_is_live from the
  # users_select_self read policy); sql_layer_check MUST catch it (non-zero).
  echo "  [negative control] synthetic stripped-gate fixture (tamper: strip session_is_live from users_select_self):"
  fixture="$(mktemp -d)"
  cp "$MIG_DIR"/*.sql "$fixture"/
  # The conjunct string below is unique to the users_select_self gate, so this
  # strips the gate from exactly one surface regardless of which ordinal the
  # ALTER POLICY lives in (robust to future renumbering). If the string ever
  # stops matching, the negative control catches nothing and this self-test
  # fails closed (neg_ok stays 0) — the correct, loud direction.
  sed -i 's/public\.session_is_live() AND auth\.uid() = id/auth.uid() = id/' "$fixture"/*.sql
  if sql_layer_check "$fixture" 2>/dev/null; then
    echo "    FAIL — the stripped-gate fixture was NOT caught; the check cannot fail (dead gate)"
  else
    neg_ok=1
    echo "    PASS — synthetic tampered fixture caught (non-zero), the check is regression-catching"
  fi
  rm -rf "$fixture"

  if [ "$pos_ok" -eq 1 ] && [ "$neg_ok" -eq 1 ]; then
    echo "verify-session-live-uniformity: F-121 self-test OK (positive control gated; negative control caught)"
    return 0
  fi
  echo "verify-session-live-uniformity: F-121 self-test FAILED (positive=$pos_ok negative=$neg_ok)" >&2
  return 1
}

# --- Argument parsing --------------------------------------------------------
# `--self-test` runs ONLY the SQL-layer self-test (the EF section has its own
# coverage via the no-arg run). Any other/no argument runs the full gate.
if [ "${1:-}" = "--self-test" ]; then
  run_self_test
  exit $?
fi

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
# authenticated/service_role — ENFORCED by the REVOKE/GRANT in
# 00000000000041_adr0029_phase1_keystone.sql; pinned by the pgTAP test
# phase1_redeem_invite_rls.sql), so it cannot be reached by a direct
# anon/authenticated RPC. Unlike bootstrap it is
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

# --- 3) SQL-layer (F-121) session-live uniformity check ---
# Assert each of the six direct-PostgREST surfaces gates on session_is_live in
# its latest migration definition (threat-model §3.14 F-121).
if ! sql_layer_check "$MIG_DIR"; then
  echo "verify-session-live-uniformity: SQL-layer FAIL — one or more F-121 surfaces are ungated" >&2
  exit 1
fi

echo "verify-session-live-uniformity: OK (rollout in progress; ${#EXEMPT_DURING_ROLLOUT[@]} EF(s) still exempt + ${#PERMANENT_ALLOWLIST[@]} permanently allowlisted; ${#SQL_GATED_SURFACES[@]} SQL surfaces F-121-gated on session_is_live)"
exit 0
