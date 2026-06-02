/**
 * T19.1 — SAFE_FIELDS + PI_DENYLIST content pins.
 *
 * PR #101's `lib-log-safefields.test.ts` pinned the EXPORTS of
 * SAFE_FIELDS, PI_DENYLIST, and SAFE_FIELDS_ALLOWLIST_ID — but
 * not their CONTENT. A refactor that empties either set without
 * removing the export would silently change the logger's
 * filtering posture (either over-restrict to no fields, or pass
 * PI through unfiltered).
 *
 * This file pins specific load-bearing keys:
 *
 *   - SAFE_FIELDS must include the universal observability keys
 *     (`route`, `outcome`, `latency_ms`) + the auth + audit-log
 *     echo keys that the canonical event types depend on.
 *
 *   - PI_DENYLIST must include the four canonical PI shapes
 *     (display_name, email, phone, address) + the C3/C4
 *     ciphertext column names + auth bearer tokens.
 *
 * Tests import the live sets so a drift trips here, not at runtime
 * when an event is dropped silently.
 */

import { describe, expect, it } from 'vitest';
import { SAFE_FIELDS, PI_DENYLIST } from '../../src/lib/log/safe-fields';

describe('T19.1 — SAFE_FIELDS universal observability keys', () => {
  it('includes `route` (every logged event carries the source route)', () => {
    expect(SAFE_FIELDS.has('route')).toBe(true);
  });

  it('includes `outcome` (success / failure discriminator)', () => {
    expect(SAFE_FIELDS.has('outcome')).toBe(true);
  });

  it('includes `latency_ms` (perf canary across every event)', () => {
    expect(SAFE_FIELDS.has('latency_ms')).toBe(true);
  });

  it('includes `feature_flag` (flag-gated event annotation)', () => {
    expect(SAFE_FIELDS.has('feature_flag')).toBe(true);
  });

  it('includes `release` (SHA tag for cross-deploy correlation)', () => {
    expect(SAFE_FIELDS.has('release')).toBe(true);
  });
});

describe('T19.1 — SAFE_FIELDS auth + audit-log echo keys', () => {
  it('includes `auth.method` + `auth.result` (T05 auth event shape)', () => {
    expect(SAFE_FIELDS.has('auth.method')).toBe(true);
    expect(SAFE_FIELDS.has('auth.result')).toBe(true);
  });

  it('includes `auth.session_id_pseudonym` (NOT the raw session_id)', () => {
    // Defense pin: the pseudonym variant is the SAFE form; the raw
    // session_id MUST stay off the allowlist (in PI_DENYLIST below).
    expect(SAFE_FIELDS.has('auth.session_id_pseudonym')).toBe(true);
  });

  it('includes `audit.event_type` + `audit.target_class` (audit echo shape)', () => {
    expect(SAFE_FIELDS.has('audit.event_type')).toBe(true);
    expect(SAFE_FIELDS.has('audit.target_class')).toBe(true);
  });

  it('includes `audit.target_id_pseudonym` (NOT raw target_id)', () => {
    expect(SAFE_FIELDS.has('audit.target_id_pseudonym')).toBe(true);
  });
});

describe('T19.1 — SAFE_FIELDS defense pins (forbidden raw-identifier keys)', () => {
  it('does NOT include raw `user_id` (would surface raw identifier in logs)', () => {
    expect(SAFE_FIELDS.has('user_id')).toBe(false);
  });

  it('does NOT include raw `session_id` (only the pseudonym variant is safe)', () => {
    expect(SAFE_FIELDS.has('session_id')).toBe(false);
  });

  it('does NOT include raw `email` / `phone` (PI by definition)', () => {
    expect(SAFE_FIELDS.has('email')).toBe(false);
    expect(SAFE_FIELDS.has('phone')).toBe(false);
  });
});

describe('T19.1 — PI_DENYLIST C2 PI shapes (the four canonical leak channels)', () => {
  it('includes display_name + displayname (case variants)', () => {
    expect(PI_DENYLIST.has('display_name')).toBe(true);
    expect(PI_DENYLIST.has('displayname')).toBe(true);
  });

  it('includes email + phone + phone_number', () => {
    expect(PI_DENYLIST.has('email')).toBe(true);
    expect(PI_DENYLIST.has('phone')).toBe(true);
    expect(PI_DENYLIST.has('phone_number')).toBe(true);
  });

  it('includes contact + address + home_address (employer-disclosure channels)', () => {
    expect(PI_DENYLIST.has('contact')).toBe(true);
    expect(PI_DENYLIST.has('address')).toBe(true);
    expect(PI_DENYLIST.has('home_address')).toBe(true);
  });

  it('includes off_employer_contact (off-employer reachback channel)', () => {
    expect(PI_DENYLIST.has('off_employer_contact')).toBe(true);
  });
});

describe('T19.1 — PI_DENYLIST auth bearer tokens', () => {
  it('includes the standard auth headers + token names', () => {
    expect(PI_DENYLIST.has('authorization')).toBe(true);
    expect(PI_DENYLIST.has('cookie')).toBe(true);
    expect(PI_DENYLIST.has('set-cookie')).toBe(true);
    expect(PI_DENYLIST.has('jwt')).toBe(true);
    expect(PI_DENYLIST.has('access_token')).toBe(true);
    expect(PI_DENYLIST.has('refresh_token')).toBe(true);
  });
});
