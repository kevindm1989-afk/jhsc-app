#!/usr/bin/env bash
#
# Bundle-size CI gate — fails if `apps/web/build/_app/immutable/chunks/`
# grows past a checked-in budget. Catches accidental bloat (lodash
# full import, heavy icon set, dependency-graph expansion) before it
# reaches production. Pinned per the 2026-06-17 perf-watcher pass.
#
# Budget is the CURRENT measured size at the time of pinning plus a
# +25% headroom. Legitimate growth past the headroom requires a
# conscious bump of the budget (and a one-line note here explaining
# why the chunks grew). That review friction is the point.
#
# Run after `pnpm -C apps/web build`; gate exits 1 on over-budget.

set -euo pipefail

ROOT="${BUNDLE_SIZE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CHUNKS_DIR="${BUNDLE_CHUNKS_DIR:-$ROOT/apps/web/build/_app/immutable/chunks}"

# Budget — bytes. Bumped consciously when a real reason requires it;
# DO NOT bump silently to make a regressed PR green.
#
# 2026-06-17 pin: measured 5,254,814 bytes (5.01 MiB) + 25% headroom
# → 6,568,517.5 → rounded to 6,650,000 bytes (6.34 MiB).
BUDGET_BYTES="${BUNDLE_CHUNKS_BUDGET_BYTES:-6650000}"

if [ ! -d "$CHUNKS_DIR" ]; then
  echo "[bundle-size] FAIL: chunks dir not found at $CHUNKS_DIR" >&2
  echo "[bundle-size] (build artefact missing — run \`pnpm -C apps/web build\` first)" >&2
  exit 1
fi

ACTUAL_BYTES=$(du -sb "$CHUNKS_DIR" | awk '{print $1}')
HUMAN_ACTUAL=$(numfmt --to=iec --suffix=B --format="%.2f" "$ACTUAL_BYTES")
HUMAN_BUDGET=$(numfmt --to=iec --suffix=B --format="%.2f" "$BUDGET_BYTES")

echo "[bundle-size] chunks dir: $CHUNKS_DIR"
echo "[bundle-size] actual: $ACTUAL_BYTES bytes ($HUMAN_ACTUAL)"
echo "[bundle-size] budget: $BUDGET_BYTES bytes ($HUMAN_BUDGET)"

if [ "$ACTUAL_BYTES" -gt "$BUDGET_BYTES" ]; then
  DELTA=$((ACTUAL_BYTES - BUDGET_BYTES))
  HUMAN_DELTA=$(numfmt --to=iec --suffix=B --format="%.2f" "$DELTA")
  PCT=$(awk "BEGIN {printf \"%.1f\", ($ACTUAL_BYTES - $BUDGET_BYTES) * 100 / $BUDGET_BYTES}")
  echo "[bundle-size] FAIL: over budget by $DELTA bytes ($HUMAN_DELTA, +${PCT}%)" >&2
  echo "[bundle-size] If this is intentional, bump BUDGET_BYTES at the top of" >&2
  echo "[bundle-size] scripts/check-bundle-size.sh + add a one-line note explaining why." >&2
  exit 1
fi

REMAINING=$((BUDGET_BYTES - ACTUAL_BYTES))
HUMAN_REMAINING=$(numfmt --to=iec --suffix=B --format="%.2f" "$REMAINING")
echo "[bundle-size] PASS: within budget ($HUMAN_REMAINING headroom)"
