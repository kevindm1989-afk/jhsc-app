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
      attributes: { email: 'a@b.c', password: 'x' }
    });
  });
});
