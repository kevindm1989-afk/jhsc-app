/**
 * T19.1 — `.github/workflows/ci.yml` job structural pins.
 *
 * The CI workflow file orchestrates every gate that runs on PRs +
 * pushes to main. If a job is accidentally removed (e.g., during a
 * workflow refactor), the corresponding gate stops running on PRs
 * silently — locally tests still pass, but the merge protection
 * the gate provides is gone. The Hardening Gates flake-tolerance
 * meta-issue showed how easy it is for jobs to be skipped without
 * anyone noticing immediately.
 *
 * This file pins:
 *
 *   - The five top-level jobs by their YAML key + display name.
 *   - The trigger contract (`on.pull_request` + `on.push`).
 *   - The concurrency policy (`cancel-in-progress: true`) — without
 *     this a rapid push storm queues redundant CI runs that compete
 *     for the live-stack containers.
 *   - The Ubuntu runner version (22.04) — drift to a different
 *     runner could silently change Docker / Postgres behaviour
 *     (the committee pgTAP + Supabase live-stack jobs depend on
 *     specific container support).
 *
 * Pinning here is defense-in-depth alongside CODEOWNERS / branch-
 * protection rules that ENFORCE specific checks; the structural
 * pin catches workflow drift at the test-suite layer where it's
 * cheap to fix instead of post-merge.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKFLOW_PATH = resolve(__dirname, '../../../../.github/workflows/ci.yml');

describe('T19.1 — .github/workflows/ci.yml exists + has the canonical structure', () => {
  it('the workflow file exists at the expected path', () => {
    expect(existsSync(WORKFLOW_PATH)).toBe(true);
  });

  const src = readFileSync(WORKFLOW_PATH, 'utf8');

  it('declares the workflow name "CI"', () => {
    expect(src).toMatch(/^name:\s*CI\s*$/m);
  });

  it('triggers on pull_request to main', () => {
    expect(src).toMatch(/pull_request:\s*\n\s+branches:\s*\[main\]/);
  });

  it('triggers on push to main (re-run after merge → gate the deploy)', () => {
    expect(src).toMatch(/push:\s*\n\s+branches:\s*\[main\]/);
  });

  it('uses cancel-in-progress concurrency (rapid pushes don\'t queue redundant runs)', () => {
    // Without `cancel-in-progress: true`, a rapid push storm queues
    // redundant CI runs that compete for the live-stack containers
    // (Supabase pgTAP + GoTrue), exhausting the runner quota and
    // serializing PR throughput.
    expect(src).toMatch(/concurrency:[\s\S]{0,200}?cancel-in-progress:\s*true/);
  });
});

describe('T19.1 — ci.yml five canonical jobs are present', () => {
  const src = readFileSync(WORKFLOW_PATH, 'utf8');

  it('declares the `build-and-test` job ("Build, typecheck & tests")', () => {
    expect(src).toMatch(/^\s{2}build-and-test:\s*$/m);
    expect(src).toMatch(/name:\s*Build,\s*typecheck\s*&\s*tests/);
  });

  it('declares the `hardening-gates` job ("Hardening gates")', () => {
    // Runs gitleaks + semgrep + the bundle-grep gate + verify-i18n.sh
    // + other static-analysis gates. Dropping this job re-opens the
    // PI-leak / secret-leak surface at PR time.
    expect(src).toMatch(/^\s{2}hardening-gates:\s*$/m);
    expect(src).toMatch(/name:\s*Hardening\s*gates/);
  });

  it('hardening-gates builds a production bundle and runs the test-props strip gate against it (G-T19-5 / #125)', () => {
    // The bundle-scanning gates must inspect a REAL production build. The job
    // sets NODE_ENV=ci job-wide, which makes Vite's `import.meta.env.PROD`
    // false and leaves DCE-guarded test-only seam code IN the bundle — a
    // non-deployable hybrid. The Build step therefore overrides
    // NODE_ENV=production. Pinning both the override AND the gate invocation
    // guards against silently reverting #125 (which would let `__test_*` /
    // `__debug*` symbols ship undetected — the only other coverage is the
    // synthetic-fixture bundle-strip-gate.test.ts).
    expect(src).toMatch(/NODE_ENV:\s*production/);
    expect(src).toMatch(/check-onboarding-test-props-stripped\.sh/);
  });

  it('declares the `committee-db-tests` job ("Committee DB tests (pgTAP)")', () => {
    // Runs pgTAP against the migrations under supabase/test/*.sql.
    // The committee membership + RLS contracts are SQL-side; this
    // is the only gate that exercises them.
    expect(src).toMatch(/^\s{2}committee-db-tests:\s*$/m);
    expect(src).toMatch(/name:\s*Committee\s*DB\s*tests\s*\(pgTAP\)/);
  });

  it('declares the `supabase-live-stack` job ("Supabase live stack (GoTrue + RLS)")', () => {
    // The only gate that proves the GoTrue → auth.uid() → RLS chain
    // end-to-end against a live stack. Documented in decisions.md §5
    // as load-bearing.
    expect(src).toMatch(/^\s{2}supabase-live-stack:\s*$/m);
    expect(src).toMatch(/name:\s*Supabase\s*live\s*stack/);
  });

  it('declares the `mint-live-e2e` job ("Mint live-trust e2e (asymmetric JWKS)")', () => {
    // The mint-session ES256 + JWKS verification chain end-to-end.
    // Pins ADR-0023's asymmetric-JWT contract.
    expect(src).toMatch(/^\s{2}mint-live-e2e:\s*$/m);
    expect(src).toMatch(/name:\s*Mint\s*live-trust\s*e2e/);
  });
});

describe('T19.1 — ci.yml runner + timeout pins (Ubuntu 22.04)', () => {
  const src = readFileSync(WORKFLOW_PATH, 'utf8');

  it('every job runs on ubuntu-22.04 (pinned OS — drift could change Docker/Postgres behaviour)', () => {
    // Drift to `ubuntu-latest` (or 24.04+) would silently change the
    // host Docker/Postgres version, which the committee pgTAP + live
    // stack jobs depend on. Pinning the specific version is the
    // reproducible-build posture per scaffolder hard rules.
    const runners = src.match(/runs-on:\s*[^\s]+/g) ?? [];
    expect(runners.length).toBeGreaterThanOrEqual(5);
    for (const r of runners) {
      expect(r).toMatch(/runs-on:\s*ubuntu-22\.04/);
    }
  });

  it('no job uses ubuntu-latest (defense pin against drift to a moving target)', () => {
    expect(src).not.toMatch(/runs-on:\s*ubuntu-latest/);
  });
});
