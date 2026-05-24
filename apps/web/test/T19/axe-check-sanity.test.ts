/**
 * Sanity-test: confirm the axe-check helper actually runs axe-core against
 * the real DOM and surfaces violations. The accessibility-specialist's
 * Phase F pass owns the per-surface coverage; this test pins the
 * helper's contract (real axe, not stub).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freezeClock, restoreClock } from '../_helpers/clock';
import axeCheck from '../_helpers/axe-check';

beforeEach(() => {
  freezeClock();
});
afterEach(() => {
  restoreClock();
  document.body.innerHTML = '';
});

describe('axe-check helper — A11Y-T19-5 verification', () => {
  it('surfaces a button-name violation when a synthetic <button> has no accessible name', async () => {
    document.body.innerHTML = '<button id="bad"></button>';
    const r = await axeCheck(document.body, { wcagLevel: 'wcag2aa' });
    const ids = r.violations.map((v) => v.id);
    expect(ids).toContain('button-name');
  });

  it('returns zero violations for a structurally-clean button with an accessible name', async () => {
    document.body.innerHTML = '<button id="ok">Click me</button>';
    const r = await axeCheck(document.body, { wcagLevel: 'wcag2aa' });
    const ids = r.violations.map((v) => v.id);
    expect(ids).not.toContain('button-name');
  });
});
