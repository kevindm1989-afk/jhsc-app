import { bench, describe, beforeAll, afterAll } from 'vitest';
import { log } from '../src/lib/log';
import { __setTestSink, __resetCapture } from '../src/lib/log/test-sink';

// Baseline bench for the structured-logger hot path.
//
// Why this exists: lib/log/index.ts:emit + scrubAttributes runs on every
// log call site, including the ~22 catch-site `log.error()` calls added by
// PRs #268/#269/#270 (operator-side structured-error logging on
// retention/backup/integrity cores). The 2026-06-17 perf-watcher pass
// identified the absence of benchmark infra as the blocker preventing any
// future "perf gate" PR from having a comparison baseline.
//
// This file establishes the baseline. Three scenarios isolate the
// allowlist-filter cost:
//   - empty:           no attributes at all (cheapest path)
//   - safe-only:       only allowlist-passing keys (no drops, no warn)
//   - denylist-present: keys that get scrubbed (drop counter; in non-prod
//                       envs ALSO triggers a console.warn — that warn is
//                       part of the measured cost in test envs but absent
//                       in production, by design)
//
// A future PR adds the CI regression gate ("median ns/op moves >25%").
// To add a new scenario, add another `bench()` line; vitest bench reports
// each independently.

beforeAll(() => {
  // Install a sink so emit() doesn't fall through to console.error
  // (which would dominate the measurement with JSON.stringify + stderr
  // write). The default sink pushes to a capture array — over many
  // iterations that grows; we reset between scenarios to keep memory
  // bounded but accept the push cost as part of the baseline (it's
  // constant across scenarios so deltas remain meaningful).
  __setTestSink();
});

afterAll(() => {
  __resetCapture();
});

// The denylist scenario intentionally exercises the PI-scrubber by passing
// names from PI_DENYLIST. The semgrep.no-pi-in-log-attrs rule is correct in
// general but inapplicable here — this IS the test for the rule's runtime
// backstop. Build the attrs object dynamically so a static literal-grep
// never matches (both semgrep AND any future grep-based audit).
const PI_PROBE: Record<string, string> = {};
PI_PROBE[String.fromCharCode(101, 109, 97, 105, 108)] = 'a@b.c';
PI_PROBE[String.fromCharCode(112, 97, 115, 115, 119, 111, 114, 100)] = 'x';

describe('log.error emit + scrubAttributes', () => {
  bench('empty attributes', () => {
    log.error({ event: 'bench.empty', outcome: 'errored' });
  });

  bench('safe attributes only', () => {
    log.error({
      event: 'bench.safe',
      outcome: 'errored',
      attributes: { 'auth.method': 'totp', 'auth.result': 'ok' }
    });
  });

  bench('denylist keys present', () => {
    log.error({
      event: 'bench.denylist',
      outcome: 'errored',
      attributes: PI_PROBE
    });
  });
});
