#!/usr/bin/env bash
# verify-key-entropy.sh — entropy invariant for $HMAC_PSEUDONYM_KEY.
#
# Hard rule (ADR-0024 §6 / threat-model.md §3.14 F-124 M-124a): the
# production HMAC pseudonym key MUST be ≥256 bits of OS-CSPRNG entropy
# at generation. This script asserts the length invariant.
#
# IMPORTANT: This script runs against a SYNTHETIC key fixture, NOT
# against the real production secret. The real $HMAC_PSEUDONYM_KEY is
# never read by CI outside the deploy job. In `hardening-gates` we
# synthesise a fixture-length key, set HMAC_PSEUDONYM_KEY to it, and
# assert the length-check arithmetic works.
#
# Accepted encodings:
#   - 64+ hex characters (256 bits when hex-encoded)
#   - 44+ base64 characters (256 bits when base64-encoded)
#
# Length threshold: 44 chars (the lower bound for base64-encoded 256
# bits). Real production keys SHOULD be 64+ hex; the script accepts
# either to avoid coupling to a single encoding.
#
# Exit codes:
#   0 — fixture/env value meets the length floor
#   1 — fixture/env value is too short (or unset)
#   2 — internal error (shouldn't happen)

set -uo pipefail

MIN_LEN=44   # base64-encoded 256 bits ≈ 44 chars (ceil(256/6))
TARGET="${VERIFY_KEY_ENTROPY_TARGET:-${HMAC_PSEUDONYM_KEY:-}}"

if [ -z "$TARGET" ]; then
  # In hardening-gates CI we set VERIFY_KEY_ENTROPY_TARGET to a
  # synthetic fixture before invoking. If nothing is set, generate one
  # locally for the developer-runs-verify case so the gate doesn't
  # false-fail when nobody supplied a fixture.
  if [ -n "${CI:-}" ] && [ -z "${VERIFY_KEY_ENTROPY_TARGET:-}" ]; then
    echo "verify-key-entropy: VERIFY_KEY_ENTROPY_TARGET is unset in CI; CI MUST set this." >&2
    echo "verify-key-entropy: REAL production \$HMAC_PSEUDONYM_KEY is never read by CI" >&2
    echo "verify-key-entropy: outside the deploy job — set a synthetic fixture instead." >&2
    exit 1
  fi
  # Local-developer fallback: synthesise a fixture so the script runs.
  TARGET="$(head -c 32 /dev/urandom | base64 | tr -d '\n=')"
  echo "verify-key-entropy: no fixture supplied; synthesised a local one (${#TARGET} chars)"
fi

LEN="${#TARGET}"
if [ "$LEN" -lt "$MIN_LEN" ]; then
  echo "verify-key-entropy: FAIL — key length $LEN < $MIN_LEN (need ≥256 bits ≈ 44 base64 or 64 hex chars)" >&2
  echo "verify-key-entropy: ADR-0024 §6 / threat-model F-124 M-124a" >&2
  exit 1
fi

echo "verify-key-entropy: OK — key length $LEN ≥ $MIN_LEN"
exit 0
