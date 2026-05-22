/**
 * T08 — Member concern intake (anonymous-by-default) + hazard register read.
 *
 * Source obligations:
 *   - threat-model §8 T08 — F-15, F-16, F-17, F-18, F-20; ADR-0007 route inventory.
 *   - ADR-0007 — committee-members-only intake; no public-write route.
 *   - Plan §6 T3 — anonymous toggle defaults ON; source-reveal flow.
 *   - design-system §4 Surface B — every state for the intake form.
 *   - i18n en-CA — `concern.intake.anon.helper_on` / `concern.named.advisory_*`
 *     surface; SR strings `a11y.concern.anonymous_on` / `.anonymous_off`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/svelte';
import ConcernIntakeForm from '../../src/lib/concerns/ConcernIntakeForm.svelte';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import { createTestSupabase, type TestSupabase } from '../_helpers/supabase-test';
import {
  SYNTHETIC_USER_A,
  SYNTHETIC_USER_C_INACTIVE,
  SYNTHETIC_USER_D_NONMEMBER,
  SYNTHETIC_DISPLAY_NAME,
  CANARY_PII_X,
} from '../_helpers/fixtures';

let supa: TestSupabase;
beforeEach(async () => {
  freezeClock();
  supa = await createTestSupabase();
});
afterEach(async () => {
  cleanup();
  restoreClock();
  await supa.tearDown();
});

// ============================================================================
// F-17 / T3 — anonymous default lock (structural enforcement)
// ============================================================================

describe('T08 / F-17 / T3 — anonymous toggle default-ON is structurally locked', () => {
  it('T08 / T3 / Surface B "empty" — initial render: anonymous toggle is ON; source_name field is NOT rendered', () => {
    render(ConcernIntakeForm);
    const toggle = screen.getByRole('switch', { name: /anonymous/i });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByLabelText(/source.*worker/i)).toBeNull();
  });

  it('T08 / T3 — there is NO "remember last setting" affordance: a freshly mounted form ALWAYS starts anonymous, even after a previous named submission', async () => {
    const { unmount } = render(ConcernIntakeForm);
    const toggle = screen.getByRole('switch', { name: /anonymous/i });
    fireEvent.click(toggle); // → named
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    unmount();
    render(ConcernIntakeForm);
    const fresh = screen.getByRole('switch', { name: /anonymous/i });
    expect(fresh.getAttribute('aria-checked')).toBe('true');
  });

  it('T08 / T3 — flipping the toggle OFF shows the named advisory `concern.named.advisory_body` BEFORE the source_name field becomes interactable', () => {
    render(ConcernIntakeForm);
    const toggle = screen.getByRole('switch', { name: /anonymous/i });
    fireEvent.click(toggle);
    const advisory = screen.getByTestId('named-source-advisory');
    const sourceNameInput = screen.getByLabelText(/source.*worker/i) as HTMLInputElement;
    // DOM order: advisory precedes input.
    const order = advisory.compareDocumentPosition(sourceNameInput);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// ============================================================================
// F-17 — audit log always carries actor_id regardless of anonymous toggle
// ============================================================================

describe('T08 / F-17 — audit row carries actor_id regardless of anonymous-source state', () => {
  it('T08 / F-17 — anonymous=true submission writes `concern.created` audit row with non-null actor_pseudonym = submitter', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await supa.client(user).insertConcern({
      title: 'title-1',
      body: 'body-1',
      anonymous: true,
      hazard_class: 'physical',
      severity: 'medium',
      location_id: 'loc-1',
    });
    const rows = await supa.adminQuery(
      `SELECT actor_pseudonym, meta FROM audit_log WHERE event_type = 'concern.created' ORDER BY id DESC LIMIT 1`
    );
    expect(rows.rows[0].actor_pseudonym).toBe(supa.pseudonymOf(user.user_id));
    expect(rows.rows[0].meta.anonymous_default_kept).toBe(true);
  });

  it('T08 / F-17 — anonymous=false submission writes audit row with submitter actor_pseudonym (NOT NULL) and anonymous_default_kept=false', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await supa.client(user).insertConcern({
      title: 'title-2',
      body: 'body-2',
      anonymous: false,
      source_name_plaintext: SYNTHETIC_DISPLAY_NAME,
      hazard_class: 'physical',
      severity: 'high',
      location_id: 'loc-1',
    });
    const rows = await supa.adminQuery(
      `SELECT actor_pseudonym, meta FROM audit_log WHERE event_type = 'concern.created' ORDER BY id DESC LIMIT 1`
    );
    expect(rows.rows[0].actor_pseudonym).toBe(supa.pseudonymOf(user.user_id));
    expect(rows.rows[0].meta.anonymous_default_kept).toBe(false);
  });
});

// ============================================================================
// F-15 — RLS denies INSERT to non-active-members
// ============================================================================

describe('T08 / F-15 — `concerns` INSERT RLS', () => {
  it('T08 / F-15 — active member INSERT succeeds', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const id = await supa.client(user).insertConcern({
      title: 'ok',
      body: 'ok',
      anonymous: true,
      hazard_class: 'physical',
      severity: 'medium',
      location_id: 'loc-1',
    });
    expect(id).toBeDefined();
  });

  it('T08 / F-15 — authenticated user with NO committee_membership row → RLS denies INSERT', async () => {
    const user = await supa.makeAuthSession(SYNTHETIC_USER_D_NONMEMBER); // no membership row
    const r = await supa.client(user).attemptInsertConcernRaw({
      title: 'x',
      body: 'x',
      anonymous: true,
    });
    expect(r.status).toBe('rls_denied');
  });

  it('T08 / F-15 — `active = false` member: RLS denies INSERT', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_C_INACTIVE, { active: false });
    const r = await supa.client(user).attemptInsertConcernRaw({
      title: 'x',
      body: 'x',
      anonymous: true,
    });
    expect(r.status).toBe('rls_denied');
  });

  it('T08 / F-15 + F-30 — removed member with a still-valid JWT: INSERT denied within 60 seconds of `committee_membership.active = false`', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const sess = await supa.loginAs(user);
    await supa.coChairUpdateMembership(SYNTHETIC_USER_A, { active: false });
    advanceBy(60_000);
    const r = await supa.callProtected(sess.access_token, {
      path: '/api/concerns',
      method: 'POST',
      body: { title: 'x', body: 'x', anonymous: true },
    });
    expect([401, 403]).toContain(r.status);
  });
});

// ============================================================================
// F-16 — UPDATE writes per-field-hash audit row
// ============================================================================

describe('T08 / F-16 — UPDATE on concerns emits prev_field_hashes', () => {
  it('T08 / F-16 — updating the title writes an audit row with `prev_field_hashes` jsonb that contains the sha256 of the prior `title_ct`', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const id = await supa.client(user).insertConcern({
      title: 'original-title',
      body: 'original-body',
      anonymous: true,
      hazard_class: 'physical',
      severity: 'medium',
      location_id: 'loc-1',
    });
    const before = await supa.adminQuery(`SELECT encode(digest(title_ct, 'sha256'), 'hex') AS h FROM concerns WHERE id = $1`, [id]);
    const priorHash = before.rows[0].h;
    await supa.client(user).updateConcern(id, { title: 'new-title' });
    const rows = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'concern.updated' ORDER BY id DESC LIMIT 1`
    );
    expect(rows.rows[0].meta.prev_field_hashes.title_ct).toBe(priorHash);
  });
});

// ============================================================================
// F-18 — Default list payload omits source_name_ct
// ============================================================================

describe('T08 / F-18 — concern list default payload omits source_name_ct', () => {
  it('T08 / F-18 — GET /api/concerns default payload contains no `source_name_ct` key on any row', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await supa.client(user).insertConcern({
      title: 'x',
      body: 'x',
      anonymous: false,
      source_name_plaintext: SYNTHETIC_DISPLAY_NAME,
      hazard_class: 'physical',
      severity: 'high',
      location_id: 'loc-1',
    });
    const res = await supa.client(user).listConcerns();
    for (const row of res.items) {
      expect(Object.keys(row)).not.toContain('source_name_ct');
      expect(Object.keys(row)).not.toContain('source_name_ciphertext');
    }
  });

  it('T08 / F-18 — reveal-source action writes `concern.source_revealed` audit row BEFORE plaintext returns to client', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const id = await supa.client(user).insertConcern({
      title: 'x',
      body: 'x',
      anonymous: false,
      source_name_plaintext: SYNTHETIC_DISPLAY_NAME,
      hazard_class: 'physical',
      severity: 'high',
      location_id: 'loc-1',
    });
    const auditSpy = supa.spyAuditWrites();
    const res = await supa.client(user).revealConcernSource(id, 'per-record-passphrase-x');
    const auditTs = auditSpy.last_written_ts_for('concern.source_revealed')!;
    const responseTs = res.received_at_ts;
    expect(auditTs).toBeLessThan(responseTs);
    expect(res.source_name).toBe(SYNTHETIC_DISPLAY_NAME);
  });
});

// ============================================================================
// F-20 — Rate limiting on POST /api/concerns
// ============================================================================

describe('T08 / F-20 — concern-creation rate limit', () => {
  it('T08 / F-20 — 21st POST in 1 hour returns 429 AND no row written for the 21st', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    for (let i = 0; i < 20; i++) {
      await supa.client(user).insertConcern({
        title: `t${i}`,
        body: 'b',
        anonymous: true,
        hazard_class: 'physical',
        severity: 'medium',
        location_id: 'loc-1',
      });
    }
    const r = await supa.client(user).attemptInsertConcernRaw({
      title: 't21',
      body: 'b',
      anonymous: true,
    });
    expect(r.status).toBe(429);
    const count = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM concerns WHERE actor_id = $1`,
      [SYNTHETIC_USER_A]
    );
    expect(count.rows[0].n).toBe(20);
  });

  it('T08 / F-20 — 429 response body contains no PI', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    for (let i = 0; i < 20; i++) {
      await supa.client(user).insertConcern({
        title: `t${i}`,
        body: 'b',
        anonymous: true,
        hazard_class: 'physical',
        severity: 'medium',
        location_id: 'loc-1',
      });
    }
    const r = await supa.client(user).attemptInsertConcernRaw({
      title: 't21',
      body: 'b',
      anonymous: true,
    });
    const body = JSON.stringify(r.body);
    expect(body).not.toContain(SYNTHETIC_DISPLAY_NAME);
    expect(body).not.toContain(CANARY_PII_X);
  });
});

// ============================================================================
// ADR-0007 — Route inventory: no public-write surface
// ============================================================================

describe('T08 / ADR-0007 — route inventory: no public-write surface for concerns', () => {
  it('T08 / ADR-0007 — no unauthenticated route accepts POST /api/concerns (or any concern-write path)', async () => {
    const r = await supa.fetch('/api/concerns', { method: 'POST', anonymous: true });
    expect([401, 403, 404]).toContain(r.status);
  });

  it('T08 / ADR-0007 — route inventory test confirms no email-ingestion or public form path exists', async () => {
    const inventory = supa.getRouteInventory();
    const publicWriteSurfaces = inventory.filter(
      (r) =>
        r.path.match(/concern|reprisal|inspection|work-refusal|s51/) &&
        r.methods.some((m) => ['POST', 'PUT', 'PATCH'].includes(m)) &&
        r.auth_required === false
    );
    expect(publicWriteSurfaces).toEqual([]);
  });
});

// ============================================================================
// Accessibility for Surface B (designer §4 / WCAG)
// ============================================================================

describe('T08 / design-system §4.B / WCAG 2.0 AA — concern intake a11y', () => {
  it('T08 / a11y — the anonymous switch announces locale string for ON state on initial render', () => {
    render(ConcernIntakeForm);
    const toggle = screen.getByRole('switch', { name: /anonymous source.*press to switch off/i });
    expect(toggle).toBeDefined();
  });

  it('T08 / a11y — the named-source advisory has role=status and is linked via aria-describedby from the source_name input', () => {
    render(ConcernIntakeForm);
    fireEvent.click(screen.getByRole('switch', { name: /anonymous/i }));
    const advisory = screen.getByTestId('named-source-advisory');
    expect(advisory.getAttribute('role')).toBe('status');
    const sourceName = screen.getByLabelText(/source.*worker/i);
    expect(sourceName.getAttribute('aria-describedby')).toContain(advisory.id);
  });
});
