/**
 * T19.1 — G-T19-7 Sentry breadcrumb scrubber path-allowlist extension.
 *
 * The gap: the `SENSITIVE_PATH_PATTERNS` allowlist covered the
 * /api/* shape of the old route-based design, but the production
 * stack landed in PRs #29 / #30 / #31 / #32 routes every server
 * interaction through Supabase Edge Functions at
 * `/functions/v1/<name>`. Sentry's breadcrumb stream would have
 * captured the URL + method + status for every t07-op / t14-op /
 * reprisal-op / concern-op / committee-op / mint-session call.
 *
 * The URL itself is shaped (no PI in the path under our op-dispatch
 * design — the op name is in the JSON body), but the breadcrumb
 * data shape may leak forensically-useful timing + sequence info
 * that the canonical audit_log already captures with proper PI
 * stripping. The conservative posture: drop the breadcrumbs
 * entirely, same as the /api/* surfaces.
 */

import { describe, expect, it } from 'vitest';
import {
  beforeBreadcrumb,
  SENSITIVE_PATH_PATTERNS
} from '../../src/lib/observability/sentry-scrub';

describe('T19.1 / G-T19-7 — Supabase Edge Function paths are in SENSITIVE_PATH_PATTERNS', () => {
  const SHOULD_DROP = [
    '/functions/v1/t07-op',
    '/functions/v1/t14-op',
    '/functions/v1/reprisal-op',
    '/functions/v1/concern-op',
    '/functions/v1/committee-op',
    '/functions/v1/mint-session',
    // Hostname-prefixed full URLs (Supabase's standard form).
    'https://abc.supabase.co/functions/v1/t07-op',
    'https://abc.supabase.co/functions/v1/t14-op',
    'https://abc.supabase.co/functions/v1/reprisal-op',
    // With sub-paths (defensive — the t07-op op-dispatch design doesn't
    // use them, but a future Edge Function might).
    '/functions/v1/t07-op/health',
    '/functions/v1/concern-op?op=list',
    '/functions/v1/mint-session/',
    // Underscore variant (defensive — t07_op shape is also matched
    // because some test mocks use the underscore form).
    '/functions/v1/t07_op',
    'https://abc.supabase.co/functions/v1/t14_op'
  ];

  for (const url of SHOULD_DROP) {
    it(`drops xhr breadcrumb for ${url}`, () => {
      expect(
        beforeBreadcrumb({ category: 'xhr', data: { url, method: 'POST' } })
      ).toBeNull();
    });
    it(`drops fetch breadcrumb for ${url}`, () => {
      expect(
        beforeBreadcrumb({ category: 'fetch', data: { url, method: 'POST' } })
      ).toBeNull();
    });
  }

  it('does NOT drop unrelated functions/v1 paths (defensive: only known-sensitive ops)', () => {
    // A future innocuous Edge Function (e.g. /functions/v1/health-check)
    // should pass through with URL scrubbed, not be dropped wholesale.
    const r = beforeBreadcrumb({
      category: 'fetch',
      data: { url: '/functions/v1/health-check', method: 'GET' }
    });
    expect(r).not.toBeNull();
  });

  it('does NOT drop non-sensitive routes (back-compat with PR-#37 / pre-existing patterns)', () => {
    const r = beforeBreadcrumb({
      category: 'fetch',
      data: { url: '/api/feature-flags', method: 'GET' }
    });
    expect(r).not.toBeNull();
  });

  it('pre-existing /api/* sensitive patterns still drop correctly (regression guard)', () => {
    for (const url of [
      '/api/concerns/abc',
      '/api/reprisal/x',
      '/api/work-refusal/x',
      '/api/s51/x',
      '/api/sensitive/read'
    ]) {
      expect(
        beforeBreadcrumb({ category: 'fetch', data: { url, method: 'GET' } })
      ).toBeNull();
    }
  });

  it('SENSITIVE_PATH_PATTERNS contains the /functions/v1/* coverage entry', () => {
    // Defense-in-depth: assert at least one pattern in the export
    // matches a representative Edge Function URL. Guards against a
    // refactor that loses the new pattern.
    const sample = '/functions/v1/t07-op';
    expect(SENSITIVE_PATH_PATTERNS.some((re) => re.test(sample))).toBe(true);
  });
});
