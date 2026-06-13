#!/usr/bin/env bash
# check-audit-enum-coverage.sh — audit-log closed-enum drift gate.
#
# Source obligations:
#   - ADR-0003 Amendment A (closed enum of `event_type` values).
#   - ADR-0003 Amendment A extension (work_refusal.read / s51_evidence.read).
#   - Amendments D, E (forensic-reveal pair), F (recovery_blob.viewed).
#   - observability/audit-log.md §1 (canonical enum table).
#
# What this script verifies (today, at scaffold):
#   1. The canonical enum list is documented in observability/audit-log.md.
#   2. Every `audit_emit(...)` call site (if any) uses a string literal that
#      exists in the documented enum.
#
# What it WILL verify once the T18 migration lands (DEFERRED — flagged):
#   3. The Postgres CHECK constraint on audit_log.event_type matches the
#      documented list byte-for-byte.
#   4. The retention schedule table covers every enum value (ADR-0015).
#
# Until T18 ships, items 3 and 4 are placeholders (printed but not enforced).
# Per the scaffolder rule "every gate runs, never silently skipped".

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AUDIT_DOC="$REPO_ROOT/observability/audit-log.md"

# The canonical enum (verbatim from audit-log.md §1 + ADR amendments).
EXPECTED_ENUM=(
  identity_keypair.created
  identity_privkey.recovery_blob.written
  identity_privkey.recovery_blob.restored
  identity_privkey.recovery_blob.viewed
  recovery_reset.issued
  panic_wipe.invoked
  committee_data_key.wrapped_for_member
  committee_data_key.unwrap
  committee_data_key.rotation.started
  committee_data_key.rotation.completed
  committee_data_key.member_revoked
  auth.passkey.enrolled
  auth.passkey.revoked
  session.revoked
  concern.created
  concern.updated
  concern.source_revealed
  inspection.synced
  inspection.synced.hmac_fail
  queue.integrity_fail
  recommendation.created
  recommendation.employer_response_logged
  reprisal.created
  reprisal.read
  reprisal.update
  reprisal.status_changed.4eyes_pending
  reprisal.status_changed.4eyes_completed
  sensitive.access_attempt
  work_refusal.read
  work_refusal.created
  work_refusal.update
  s51_evidence.read
  s51_evidence.created
  s51_evidence.update
  s51_evidence.create.rejected
  audit.forensic_reveal.4eyes_pending
  audit.forensic_reveal.4eyes_completed
  export.generated
  export.contained_concern_derived_items
  retention.deleted
  member.added
  member.removed
  member.role_changed
  committee.key_rotated
  client.cache_policy_violation
  client.identity_selftest_fail
  alert.fired
  audit.integrity_check.ran
  audit.integrity_check.mismatch
  audit.chain_anchor.weekly
)

# (1) Documentation present.
if [ ! -f "$AUDIT_DOC" ]; then
  echo "check-audit-enum-coverage: missing $AUDIT_DOC"
  exit 1
fi

# (2) Every expected enum must be documented either in observability/audit-log.md
#     OR in .context/decisions.md (ADR amendments add enum values; the audit-log.md
#     contract document is updated by the observability-setup agent on its next
#     pass — flagged finding #1 in audit-log.md §6 for some entries).
DECISIONS_DOC="$REPO_ROOT/.context/decisions.md"
missing=()
for e in "${EXPECTED_ENUM[@]}"; do
  if grep -Fq "\`$e\`" "$AUDIT_DOC"; then continue; fi
  if [ -f "$DECISIONS_DOC" ] && grep -Fq "\`$e\`" "$DECISIONS_DOC"; then continue; fi
  missing+=("$e")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "check-audit-enum-coverage: the following enum values are documented neither in"
  echo "  $(basename "$AUDIT_DOC") nor in .context/decisions.md:"
  printf '  - %s\n' "${missing[@]}"
  exit 1
fi

# (2b) audit_emit() call-site coverage.
if grep -rq "audit_emit\s*(" "$REPO_ROOT/apps/web/src" "$REPO_ROOT/supabase" 2>/dev/null; then
  bad_calls=$(grep -rEhn "audit_emit\s*\(\s*['\"][^'\"]+['\"]" "$REPO_ROOT/apps/web/src" "$REPO_ROOT/supabase" 2>/dev/null \
    | awk -F"['\"]" '{print $2}' | sort -u || true)
  if [ -n "$bad_calls" ]; then
    while IFS= read -r used; do
      found=0
      for e in "${EXPECTED_ENUM[@]}"; do
        if [ "$used" = "$e" ]; then found=1; break; fi
      done
      if [ "$found" -ne 1 ]; then
        echo "check-audit-enum-coverage: audit_emit('$used') is not on the closed enum"
        exit 1
      fi
    done <<<"$bad_calls"
  fi
fi

# (3) + (4) — DEFERRED until T18 migration lands.
echo "check-audit-enum-coverage: OK — ${#EXPECTED_ENUM[@]} enum value(s) documented; call-site coverage complete."
echo "check-audit-enum-coverage: DB-side CHECK + ADR-0015 schedule drift checks are DEFERRED until T18 migration; see ADR-0003 Amendment A."
exit 0
