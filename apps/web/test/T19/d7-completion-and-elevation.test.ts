/**
 * T19 — D.7 Completion + F-114 elevation-of-privilege guard (additive to scaffold).
 *
 * Covers:
 *   - F-114 / M-114a — T19 PR-review-time integration test: D.1 → D.7 end-to-end produces
 *     ZERO role.% audit rows; a pre-seeded inactive committee_membership row is UNCHANGED
 *     post-D.7
 *   - F-114 / M-114b — D7Complete.svelte file header carries the no-elevation invariant
 *     comment (static lint mirroring M-105c documentation-comment lint)
 *   - F-114 / M-114c — pre-seeded inactive membership row's `active` field stays false
 *     after D.7 completes (T19 does NOT flip active=false → true; co-chair owns activation)
 *   - F-114 / M-114a — static lint: zero references to committee_membership / INSERT INTO
 *     committee_membership / role: in lib/onboarding/ source
 *   - Designer §4 Surface D.T19.h — completion summary state matrix: check-circle icon
 *     present (color-blind safety); next-step pointer block per ADR-0020 Decision 3.f
 *
 * Note: the PR-review-time `git diff --name-only main...T19-branch -- src/lib/committee/`
 * assertion is OUT OF SCOPE for the test-writer (it lives in the security-reviewer's
 * CI gate at PR-review time). This file covers the INTEGRATION half (audit rows + DB
 * state); the PR-review-time half is documented in the test-writer's pass.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import OnboardingFlow from '../../src/lib/onboarding/OnboardingFlow.svelte';
import { createTestSupabase, type TestSupabase } from '../_helpers/supabase-test';
import { SYNTHETIC_USER_A } from '../_helpers/fixtures';
import { t } from '../../src/lib/i18n';

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

// ----------------------------------------------------------------------------
// Walk helper (mirror of d4-recovery-passphrase.test.ts walkSrc).
// ----------------------------------------------------------------------------

function walkSrc(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const p = path.join(root, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkSrc(p));
    else if (/\.(ts|svelte)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

// ============================================================================
// D.7 completion surface — happy path
// ============================================================================

describe('T19 / D.7 — completion surface renders', () => {
  it('renders the "You\'re set up" heading', async () => {
    render(OnboardingFlow, { props: { __test_step: 'D.7' } });
    expect(screen.getByRole('heading', { name: /you'?re set up/i })).toBeDefined();
  });

  it('renders the "Open the app" primary button', async () => {
    render(OnboardingFlow, { props: { __test_step: 'D.7' } });
    expect(screen.getByRole('button', { name: t('onboarding.completion_d7.primary_button') })).toBeDefined();
  });

  it('Designer D.T19.h — check-circle icon is REQUIRED (color-blind safety)', async () => {
    render(OnboardingFlow, { props: { __test_step: 'D.7' } });
    const card = screen.getByTestId('completion-summary');
    // Icon presence — either an <svg> with the check-circle name OR an <i> /
    // image with a check-icon descriptor. The implementer encodes the icon
    // identity in a data-attribute the test can introspect.
    const icon = card.querySelector('[data-icon="check-circle"], svg[data-icon="check-circle"]');
    expect(icon).not.toBeNull();
  });

  it('next-step pointer block names panic-wipe + sessions (Decision 3.f)', async () => {
    render(OnboardingFlow, { props: { __test_step: 'D.7' } });
    const pointer = screen.getByTestId('completion-next-steps');
    expect(pointer.textContent ?? '').toMatch(/Settings.*Sessions|sign out other devices/i);
    expect(pointer.textContent ?? '').toMatch(/Settings.*Wipe|wipe this device/i);
  });

  it('D.7 catalog keys reachable via t()', () => {
    expect(t('onboarding.completion_d7.heading')).not.toMatch(/^\[\[/);
    expect(t('onboarding.completion_d7.body')).not.toMatch(/^\[\[/);
    expect(t('onboarding.completion_d7.checklist.passkey')).not.toMatch(/^\[\[/);
    expect(t('onboarding.completion_d7.checklist.recovery_blob_downloaded')).not.toMatch(/^\[\[/);
    expect(t('onboarding.completion_d7.checklist.recovery_blob_printed')).not.toMatch(/^\[\[/);
    expect(t('onboarding.completion_d7.checklist.sessions_reviewed')).not.toMatch(/^\[\[/);
    expect(t('onboarding.completion_d7.next_steps_heading')).not.toMatch(/^\[\[/);
    expect(t('onboarding.completion_d7.next_steps_body')).not.toMatch(/^\[\[/);
    expect(t('onboarding.completion_d7.primary_button')).not.toMatch(/^\[\[/);
  });
});

// ============================================================================
// F-114 M-114b — file header carries the no-elevation invariant comment
// ============================================================================

describe('T19 / F-114 M-114b — D7Complete.svelte header documents the no-elevation invariant', () => {
  it('D7Complete.svelte opens with a comment stating the no-role-confer invariant', () => {
    // Either name is accepted (the architect uses D7Complete in some places and
    // D7Completion in others). Try both.
    const candidates = [
      '/home/user/agent-os/apps/web/src/lib/onboarding/steps/D7Complete.svelte',
      '/home/user/agent-os/apps/web/src/lib/onboarding/steps/D7Completion.svelte'
    ];
    const present = candidates.find((p) => existsSync(p));
    expect(present, `expected one of: ${candidates.join(' OR ')} to exist`).toBeDefined();
    const src = readFileSync(present!, 'utf8');
    const header = src.split('\n').slice(0, 60).join('\n');
    expect(header).toMatch(/INVARIANT/i);
    expect(header).toMatch(/role|confer|admin/i);
    expect(header).toMatch(/F-?114/);
  });
});

// ============================================================================
// F-114 M-114a — static lint: zero references to committee_membership / role: in lib/onboarding
// ============================================================================

describe('T19 / F-114 M-114a — no committee_membership writes anywhere in lib/onboarding source', () => {
  it('no source under lib/onboarding references "committee_membership" / "INSERT INTO committee_membership"', () => {
    const files = walkSrc('/home/user/agent-os/apps/web/src/lib/onboarding');
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/\bcommittee_membership\b/.test(stripped)) offenders.push(`${f} (committee_membership)`);
      if (/INSERT\s+INTO\s+committee_membership/i.test(stripped))
        offenders.push(`${f} (INSERT INTO committee_membership)`);
    }
    expect(offenders).toEqual([]);
  });

  it('no source under lib/onboarding writes a "role: <something>" object literal naming a privileged role', () => {
    const files = walkSrc('/home/user/agent-os/apps/web/src/lib/onboarding');
    const offenders: string[] = [];
    const PRIVILEGED = /\b(worker_co_?chair|certified_member|employer_co_?chair)\b/;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (PRIVILEGED.test(stripped)) offenders.push(`${f}: contains privileged role literal`);
    }
    expect(offenders).toEqual([]);
  });
});

// ============================================================================
// F-114 M-114a INTEGRATION — D.1 → D.7 produces zero role.% audit rows
// ============================================================================

describe('T19 / F-114 M-114a (integration) — D.1 → D.7 produces zero role.% audit rows', () => {
  it('exercising the full D.1 → D.7 flow leaves the role.% audit-row count at zero', async () => {
    const { default: harness } = await import('../_helpers/onboarding-harness');
    const ctx = await harness.startFromD1();
    await ctx.advanceThroughTo('D.4');
    await ctx.completeTypeBackVerify();
    await ctx.advanceThroughTo('D.7');

    const r = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type LIKE 'role.%' AND ts > $1`,
      [ctx.startTsMs]
    );
    expect(r.rows[0].n).toBe(0);
  });

  it('a pre-seeded inactive committee_membership row stays inactive after D.7 completes (M-114c)', async () => {
    // Pre-seed: an inactive membership row for the user about to onboard.
    await supa.coChairUpdateMembership(SYNTHETIC_USER_A, { active: false });

    const { default: harness } = await import('../_helpers/onboarding-harness');
    const ctx = await harness.startFromD1({ user_id: SYNTHETIC_USER_A });
    await ctx.advanceThroughTo('D.4');
    await ctx.completeTypeBackVerify();
    await ctx.advanceThroughTo('D.7');

    const r = await supa.adminQuery(
      `SELECT active FROM committee_membership WHERE user_id = $1`,
      [SYNTHETIC_USER_A]
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].active).toBe(false);
  });
});
