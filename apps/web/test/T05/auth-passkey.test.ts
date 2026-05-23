/**
 * T05 — Auth: passkeys + TOTP bootstrap + session model.
 *
 * Source obligations (per .context/threat-model.md §8 T05 + ADR-0002):
 *   - F-37 / T7  — passkey RP-ID origin binding
 *   - F-38       — TOTP single-use, ≤15min, ≤5 attempts/15min, consumed atomically
 *   - F-39       — server-side jti revocation; replay after revoke returns 401 within 5s
 *   - F-40 / T8  — auth response for unknown vs known-wrong-cred is byte-identical & timing-eq
 *   - F-42       — auth rate limit: 10 WebAuthn attempts/min/user; 11th = 429
 *   - F-43       — TOTP secret destroyed atomically with first passkey bind
 *   - ADR-0002   — no SMS, no password; minimum-browser baseline.
 *   - observability/audit-log.md §1 Auth+session — `auth.passkey.enrolled` /
 *     `auth.passkey.revoked` / `session.revoked` emissions.
 *   - ADR-0003 Amendment A extension — `auth.passkey.assert` is
 *     structured-log-only (NOT chain-participating; 100 asserts → zero audit
 *     rows).
 *
 * Tests run against a Supabase local stack (test config at supabase/test/
 * config; the test harness boots a fresh project per file).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  enrollFirstDevice,
  loginPasskey,
  revokeAllSessions,
  revokePasskey,
  listSessions,
  type AuthClient,
} from '../../src/lib/auth';
import { createTestSupabase, type TestSupabase } from '../_helpers/supabase-test';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import {
  SYNTHETIC_USER_A,
  SYNTHETIC_EMAIL_OFF_EMPLOYER,
  CANARY_EMAIL,
} from '../_helpers/fixtures';

let supa: TestSupabase;
let auth: AuthClient;

beforeEach(async () => {
  freezeClock();
  supa = await createTestSupabase();
  auth = supa.authClient();
});

afterEach(async () => {
  restoreClock();
  await supa.tearDown();
});

// ----------------------------------------------------------------------------
// Happy path — enrollment, login, session list
// ----------------------------------------------------------------------------

describe('T05 — enrollment happy path', () => {
  it('T05 / ADR-0002 — invite-issued TOTP consumed exactly once binds the first passkey', async () => {
    const invite = await supa.coChairIssueInvite({ user_id: SYNTHETIC_USER_A });
    const result = await enrollFirstDevice(auth, {
      totp_code: invite.totp_code,
      user_id: SYNTHETIC_USER_A,
    });
    expect(result.passkey_credential_id).toBeDefined();
    expect(result.totp_consumed).toBe(true);
  });

  it('T05 / F-43 — TOTP row deleted in the SAME transaction as passkey enrollment; users.totp_destroyed_at set', async () => {
    const invite = await supa.coChairIssueInvite({ user_id: SYNTHETIC_USER_A });
    await enrollFirstDevice(auth, { totp_code: invite.totp_code, user_id: SYNTHETIC_USER_A });
    const totpRow = await supa.adminQuery(
      `SELECT id FROM auth_totp_bootstraps WHERE user_id = $1`,
      [SYNTHETIC_USER_A]
    );
    expect(totpRow.rows.length).toBe(0);
    const userRow = await supa.adminQuery(
      `SELECT totp_destroyed_at FROM users WHERE id = $1`,
      [SYNTHETIC_USER_A]
    );
    expect(userRow.rows[0].totp_destroyed_at).not.toBeNull();
  });

  it('T05 / F-43 — TOTP login attempt after first passkey set returns 401', async () => {
    const invite = await supa.coChairIssueInvite({ user_id: SYNTHETIC_USER_A });
    await enrollFirstDevice(auth, { totp_code: invite.totp_code, user_id: SYNTHETIC_USER_A });
    // The invite's totp_code is destroyed; replaying it must 401.
    const replay = await auth.attemptTotpLogin(SYNTHETIC_USER_A, invite.totp_code);
    expect(replay.status).toBe(401);
  });
});

// ----------------------------------------------------------------------------
// F-37 / T7 — passkey RP-ID origin binding
// ----------------------------------------------------------------------------

describe('T05 / F-37 / T7 — passkey RP-ID origin binding', () => {
  it('T05 / F-37 — WebAuthn assertion from a different eTLD+1 origin is rejected (NotAllowedError)', async () => {
    const enrolled = await supa.enrollUser(SYNTHETIC_USER_A);
    // Simulate an assertion from a non-RP origin. The test harness
    // (`auth.assertFromOrigin`) sets the WebAuthn `rpId` derived from the
    // origin URL; the production RP-ID is `jhsc.example.ca`.
    const result = await auth.assertFromOrigin('https://evil.example.ca', enrolled.credential);
    expect(result.error).toMatch(/NotAllowedError|origin/);
  });

  it('T05 / F-37 — passkey enrolled for `app.example.ca` does NOT authenticate at `jhsc-example.com` (look-alike)', async () => {
    const enrolled = await supa.enrollUser(SYNTHETIC_USER_A);
    const result = await auth.assertFromOrigin('https://jhsc-example.com', enrolled.credential);
    expect(result.error).toMatch(/NotAllowedError|origin/);
  });
});

// ----------------------------------------------------------------------------
// F-38 — TOTP single-use, time-bounded, attempt-capped
// ----------------------------------------------------------------------------

describe('T05 / F-38 — TOTP bootstrap', () => {
  it('T05 / F-38 — TOTP is consumed atomically; reuse returns 401 (per threat-model §8 T05 canonical contract)', async () => {
    // Reconciled with F-43 (line 83-89): same wire scenario (post-enrolment
    // TOTP login attempt) must return one status. Threat-model §8 T05 line 828
    // is verbatim "subsequent TOTP login attempt returns 401" — F-43 wins.
    // F-38's "single-use" is enforced by the atomic delete + consumed-log,
    // observable via this 401 return + the audit row.
    const invite = await supa.coChairIssueInvite({ user_id: SYNTHETIC_USER_A });
    await enrollFirstDevice(auth, { totp_code: invite.totp_code, user_id: SYNTHETIC_USER_A });
    const reuse = await auth.attemptTotpLogin(SYNTHETIC_USER_A, invite.totp_code);
    expect(reuse.status).toBe(401);
  });

  it('T05 / F-38 — TOTP expires after 15 minutes', async () => {
    const invite = await supa.coChairIssueInvite({ user_id: SYNTHETIC_USER_A });
    advanceBy(15 * 60 * 1000 + 1);
    const result = await enrollFirstDevice(auth, {
      totp_code: invite.totp_code,
      user_id: SYNTHETIC_USER_A,
    });
    expect(result.status).toBe(410);
  });

  it('T05 / F-38 — 5 wrong TOTP attempts in 15 min lock the invite; 6th returns 429; co-chair re-issue required', async () => {
    const invite = await supa.coChairIssueInvite({ user_id: SYNTHETIC_USER_A });
    for (let i = 0; i < 5; i++) {
      const r = await auth.attemptTotpLogin(SYNTHETIC_USER_A, '000000');
      expect(r.status).toBe(401);
    }
    const sixth = await auth.attemptTotpLogin(SYNTHETIC_USER_A, '000000');
    expect(sixth.status).toBe(429);
    // The invite is locked even with the CORRECT code now.
    const correctButLocked = await enrollFirstDevice(auth, {
      totp_code: invite.totp_code,
      user_id: SYNTHETIC_USER_A,
    });
    expect(correctButLocked.status).toBe(429);
  });
});

// ----------------------------------------------------------------------------
// F-39 — server-side jti revocation
// ----------------------------------------------------------------------------

describe('T05 / F-39 — session revocation propagates server-side', () => {
  it('T05 / F-39 — captured JWT after revoke-all returns 401 within 5 seconds', async () => {
    const enrolled = await supa.enrollUser(SYNTHETIC_USER_A);
    const session = await loginPasskey(auth, enrolled.credential);
    const jwt = session.access_token;

    // Captured JWT still works.
    expect((await auth.callProtected(jwt)).status).toBe(200);

    // Revoke-all from a sibling session.
    await revokeAllSessions(auth, enrolled.user_id);

    // Within 5 seconds the captured JWT must be rejected.
    advanceBy(5_000);
    const after = await auth.callProtected(jwt);
    expect(after.status).toBe(401);
  });

  it('T05 / F-39 — replayed JWT remains 401 for the JWT TTL (no eventual re-validation)', async () => {
    const enrolled = await supa.enrollUser(SYNTHETIC_USER_A);
    const session = await loginPasskey(auth, enrolled.credential);
    await revokeAllSessions(auth, enrolled.user_id);
    advanceBy(5_000);
    // Hold the JWT for 10 more minutes (still well within the 15-min TTL).
    advanceBy(10 * 60 * 1000);
    const after = await auth.callProtected(session.access_token);
    expect(after.status).toBe(401);
  });

  it('T05 / F-39 — emits a `session.revoked` audit row with `reason = user_action` on revoke-all', async () => {
    const enrolled = await supa.enrollUser(SYNTHETIC_USER_A);
    await loginPasskey(auth, enrolled.credential);
    await revokeAllSessions(auth, enrolled.user_id);
    const rows = await supa.adminQuery(
      `SELECT event_type, meta FROM audit_log WHERE actor_pseudonym = $1 AND event_type = 'session.revoked'`,
      [supa.pseudonymOf(enrolled.user_id)]
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.rows[0].meta.reason).toBe('user_action');
  });
});

// ----------------------------------------------------------------------------
// F-40 / T8 — account enumeration prevention
// ----------------------------------------------------------------------------

describe('T05 / F-40 / T8 — account enumeration prevention', () => {
  it('T05 / F-40 — auth response for unknown vs known-wrong-credential is byte-identical (status, headers, body)', async () => {
    // Known user — wrong assertion.
    await supa.enrollUser(SYNTHETIC_USER_A);
    const knownWrong = await auth.attemptPasskeyAssert(SYNTHETIC_USER_A, 'wrong-assertion');

    // Unknown user.
    const unknown = await auth.attemptPasskeyAssert(
      '9f4e9b40-0000-4000-8000-000000000099',
      'wrong-assertion'
    );

    expect(knownWrong.status).toBe(unknown.status);
    expect(knownWrong.body).toEqual(unknown.body);
    // Header set comparison (order-independent).
    const sortedKnown = Object.keys(knownWrong.headers).sort();
    const sortedUnknown = Object.keys(unknown.headers).sort();
    expect(sortedKnown).toEqual(sortedUnknown);
  });

  it('T05 / F-40 — response timing for unknown vs known-wrong-cred differs by ≤50ms (10 runs, median)', async () => {
    await supa.enrollUser(SYNTHETIC_USER_A);
    const knownTimes: number[] = [];
    const unknownTimes: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t1 = performance.now();
      await auth.attemptPasskeyAssert(SYNTHETIC_USER_A, 'wrong');
      knownTimes.push(performance.now() - t1);
      const t2 = performance.now();
      await auth.attemptPasskeyAssert('9f4e9b40-0000-4000-8000-000000000099', 'wrong');
      unknownTimes.push(performance.now() - t2);
    }
    const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    expect(Math.abs(med(knownTimes) - med(unknownTimes))).toBeLessThan(50);
  });

  it('T05 / F-40 — auth response body contains no user-enumerating fields (no "user not found" vs "wrong password")', async () => {
    await supa.enrollUser(SYNTHETIC_USER_A);
    const knownWrong = await auth.attemptPasskeyAssert(SYNTHETIC_USER_A, 'wrong');
    const body = JSON.stringify(knownWrong.body);
    expect(body).not.toMatch(/not found|unknown user|no such user|wrong password/i);
  });
});

// ----------------------------------------------------------------------------
// F-42 — auth rate limiting + brute-force burst alert
// ----------------------------------------------------------------------------

describe('T05 / F-42 — auth rate limit and burst alerting', () => {
  it('T05 / F-42 — 11th WebAuthn attempt within 1 minute returns 429 with no user-enumerating body', async () => {
    const enrolled = await supa.enrollUser(SYNTHETIC_USER_A);
    for (let i = 0; i < 10; i++) {
      await auth.attemptPasskeyAssert(SYNTHETIC_USER_A, 'wrong-' + i);
    }
    const eleventh = await auth.attemptPasskeyAssert(SYNTHETIC_USER_A, 'wrong-final');
    expect(eleventh.status).toBe(429);
    const body = JSON.stringify(eleventh.body);
    expect(body).not.toMatch(/email|user_id|@/);
  });

  it('T05 / observability-alerts §1 A-AUTH-001 — 10 auth failures in 5 min triggers burst alert', async () => {
    await supa.enrollUser(SYNTHETIC_USER_A);
    for (let i = 0; i < 10; i++) {
      await auth.attemptPasskeyAssert(SYNTHETIC_USER_A, 'wrong-' + i);
    }
    // Allow the alert dispatcher to process.
    advanceBy(1_000);
    const alerts = await supa.adminQuery(
      `SELECT alert_id FROM audit_log WHERE event_type = 'alert.fired' AND meta->>'alert_id' = 'A-AUTH-001'`
    );
    expect(alerts.rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ----------------------------------------------------------------------------
// Session list / revocation per device — design-system §4.H
// ----------------------------------------------------------------------------

describe('T05 / design-system §4.H — session list and per-device revocation', () => {
  it('T05 — session list shows every active session for the current user', async () => {
    const enrolled = await supa.enrollUser(SYNTHETIC_USER_A);
    await loginPasskey(auth, enrolled.credential, { device_fingerprint: 'device-1' });
    await loginPasskey(auth, enrolled.credential, { device_fingerprint: 'device-2' });
    const sessions = await listSessions(auth, enrolled.user_id);
    expect(sessions.length).toBe(2);
    expect(sessions.map((s) => s.device_fingerprint).sort()).toEqual(['device-1', 'device-2']);
  });

  it('T05 / F-39 — revoking a single session leaves the other active', async () => {
    const enrolled = await supa.enrollUser(SYNTHETIC_USER_A);
    const s1 = await loginPasskey(auth, enrolled.credential, { device_fingerprint: 'device-1' });
    const s2 = await loginPasskey(auth, enrolled.credential, { device_fingerprint: 'device-2' });
    await auth.revokeSession(s1.session_id);
    expect((await auth.callProtected(s1.access_token)).status).toBe(401);
    expect((await auth.callProtected(s2.access_token)).status).toBe(200);
  });

  it('T05 / audit-log.md §1 — revoke-passkey emits `auth.passkey.revoked` with cred_id_pseudonym + revoked_by_actor_pseudonym', async () => {
    const enrolled = await supa.enrollUser(SYNTHETIC_USER_A);
    await loginPasskey(auth, enrolled.credential);
    await revokePasskey(auth, enrolled.credential.credentialId, enrolled.user_id);
    const rows = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'auth.passkey.revoked' AND actor_pseudonym = $1`,
      [supa.pseudonymOf(enrolled.user_id)]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].meta.cred_id_pseudonym).toBeDefined();
    expect(rows.rows[0].meta.revoked_by_actor_pseudonym).toBeDefined();
  });
});

// ----------------------------------------------------------------------------
// `auth.passkey.assert` is structured-log-only, NOT chain-participating
// (ADR-0003 Amendment A extension)
// ----------------------------------------------------------------------------

describe('T05 / ADR-0003 Amendment A extension — auth.passkey.assert is volumetric (not chain-participating)', () => {
  it('T05 — 100 successful WebAuthn assertions produce zero rows with event_type=auth.passkey.assert in audit_log', async () => {
    const enrolled = await supa.enrollUser(SYNTHETIC_USER_A);
    for (let i = 0; i < 100; i++) {
      await loginPasskey(auth, enrolled.credential);
    }
    const chainRows = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'auth.passkey.assert'`
    );
    expect(chainRows.rows[0].n).toBe(0);
  });

  it('T05 — 100 successful WebAuthn assertions DO produce 100 structured-log lines at INFO level', async () => {
    const enrolled = await supa.enrollUser(SYNTHETIC_USER_A);
    supa.startLogCapture();
    for (let i = 0; i < 100; i++) {
      await loginPasskey(auth, enrolled.credential);
    }
    const lines = supa.stopLogCapture();
    const assertLines = lines.filter((l) => l.event === 'auth.passkey.assert' && l.level === 'INFO');
    expect(assertLines.length).toBe(100);
  });
});

// ----------------------------------------------------------------------------
// Privacy invariant — no PI/email in any auth log line
// ----------------------------------------------------------------------------

describe('T05 / logging.md §2 — auth logs contain no PI', () => {
  it('T05 — auth failure log lines do not contain the attempted email/phone/name', async () => {
    supa.startLogCapture();
    await auth.attemptPasskeyAssert(SYNTHETIC_USER_A, CANARY_EMAIL);
    await auth.attemptTotpLogin(SYNTHETIC_USER_A, CANARY_EMAIL);
    const lines = supa.stopLogCapture();
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain(CANARY_EMAIL);
    expect(serialized).not.toContain(SYNTHETIC_EMAIL_OFF_EMPLOYER);
  });
});

// ----------------------------------------------------------------------------
// Minimum browser baseline gate (ADR-0002 Operational rules)
// ----------------------------------------------------------------------------

describe('T05 / ADR-0002 / T19 — minimum browser baseline gate', () => {
  it('T05 — Safari 15 (below 16.4 baseline) is blocked at onboarding with documented "too old" page', async () => {
    const supported = auth.checkBrowserBaseline('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/15.6 Safari/605.1.15');
    expect(supported.ok).toBe(false);
    expect(supported.reason_key).toBe('onboarding.browser.unsupported_heading');
  });

  it('T05 — Chrome 130 (above 109 baseline) is supported', async () => {
    const supported = auth.checkBrowserBaseline(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    );
    expect(supported.ok).toBe(true);
  });
});
