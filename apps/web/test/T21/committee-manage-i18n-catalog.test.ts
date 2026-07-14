/**
 * ADR-0029 P1-8e — Surface K screen 5 i18n catalog coverage
 * (committee.role.* / committee.remove.* / committee.reactivate.* /
 *  committee.approver.* / committee.manage.* / a11y.committee.* copy).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. Mirrors
 * committee-i18n-catalog.test.ts (P1-8b) + committee-invite-i18n-catalog.test.ts
 * (P1-8c): every key the designer's screen-5 catalog defines MUST be present (a
 * non-empty string) in en-CA, so the CommitteeManageMemberCard resolves real
 * copy via t() rather than the `[[committee.role.row.cta]]` miss-marker (which
 * verify-i18n.sh rejects in CI).
 *
 * Scope: en-CA only (fr-CA stubbed empty per ADR-0009 — no hand-written French).
 *
 * This file ALSO carries the FINDING 6 / FINDING 7 (F-182) catalog-string
 * discipline directly over the i18n leaves (design-system.md "F-182 string-test
 * discipline"): the remove copy must state the non-crypto limit and NEVER claim
 * data-access revocation; the reactivate copy must state the retained-wrap
 * honesty and NEVER present a fresh grant.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../_helpers/paths';
import { hasKey, t } from '../../src/lib/i18n';

const CATALOG_PATH = path.join(REPO_ROOT, 'i18n/en-CA.json');

function leaf(catalog: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = catalog;
  for (const p of dotted.split('.')) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

// committee.role.* — the change-role flow.
const ROLE_KEYS: readonly string[] = [
  'committee.role.row.cta',
  'committee.role.row.cta_aria',
  'committee.role.modal.heading',
  'committee.role.modal.lead',
  'committee.role.modal.roles_legend',
  'committee.role.modal.self_note',
  'committee.role.modal.no_changes_hint',
  'committee.role.modal.confirm',
  'committee.role.modal.cancel',
  'committee.role.submitting',
  'committee.role.done.heading',
  'committee.role.done.body',
  'committee.role.done.toast',
  'committee.role.failed.invalid_role.body'
];

// committee.remove.* — the remove flow (F-182 honest-limit copy).
const REMOVE_KEYS: readonly string[] = [
  'committee.remove.row.cta',
  'committee.remove.row.cta_aria',
  'committee.remove.modal.heading',
  'committee.remove.modal.what',
  'committee.remove.modal.limit',
  'committee.remove.modal.self_note',
  'committee.remove.modal.confirm',
  'committee.remove.modal.confirm_self',
  'committee.remove.modal.cancel',
  'committee.remove.submitting',
  'committee.remove.done.heading',
  'committee.remove.done.body',
  'committee.remove.done.toast'
];

// committee.reactivate.* — the reactivate flow (F-182 retained-wrap copy).
const REACTIVATE_KEYS: readonly string[] = [
  'committee.reactivate.row.cta',
  'committee.reactivate.row.cta_aria',
  'committee.reactivate.modal.heading',
  'committee.reactivate.modal.what',
  'committee.reactivate.modal.wrap',
  'committee.reactivate.modal.confirm',
  'committee.reactivate.modal.cancel',
  'committee.reactivate.submitting',
  'committee.reactivate.done.heading',
  'committee.reactivate.done.body',
  'committee.reactivate.done.toast',
  'committee.reactivate.failed.already_active.body'
];

// committee.approver.* — the shared second-approver picker.
const APPROVER_KEYS: readonly string[] = [
  'committee.approver.heading',
  'committee.approver.explain',
  'committee.approver.select_label',
  'committee.approver.select_placeholder',
  'committee.approver.none_heading',
  'committee.approver.none_body',
  'committee.approver.stale'
];

// committee.manage.* — the shared cross-op states (names no member, F-160).
const MANAGE_KEYS: readonly string[] = [
  'committee.manage.you_chip',
  'committee.manage.fourEyes.heading',
  'committee.manage.fourEyes.body',
  'committee.manage.lastCoChair.heading',
  'committee.manage.lastCoChair.body',
  'committee.manage.failed.heading',
  'committee.manage.failed.session_body',
  'committee.manage.failed.co_chair_body',
  'committee.manage.failed.not_found_body',
  'committee.manage.failed.generic_body',
  'committee.manage.retry',
  'committee.manage.reload',
  'committee.manage.close'
];

// a11y.committee.* — the live-region announces.
const A11Y_KEYS: readonly string[] = [
  'a11y.committee.manage.you',
  'a11y.committee.role.submitting',
  'a11y.committee.role.done',
  'a11y.committee.remove.submitting',
  'a11y.committee.remove.done',
  'a11y.committee.reactivate.submitting',
  'a11y.committee.reactivate.done',
  'a11y.committee.approver.selected',
  'a11y.committee.manage.fourEyes',
  'a11y.committee.manage.lastCoChair',
  'a11y.committee.manage.failed'
];

const COPY_KEYS = [...ROLE_KEYS, ...REMOVE_KEYS, ...REACTIVATE_KEYS, ...APPROVER_KEYS, ...MANAGE_KEYS];
const ALL_KEYS = [...COPY_KEYS, ...A11Y_KEYS];

// ===========================================================================
// FINDING 10 — presence + non-empty string in the root catalog.
// ===========================================================================

describe('P1-8e — screen-5 committee.* / a11y.committee.* catalog keys present + non-empty', () => {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Record<string, unknown>;

  for (const key of COPY_KEYS) {
    it(`catalog defines a non-empty string for ${key}`, () => {
      const v = leaf(catalog, key);
      expect(typeof v, `${key} must be a string in i18n/en-CA.json`).toBe('string');
      expect((v as string).trim().length).toBeGreaterThan(0);
    });
  }

  for (const key of A11Y_KEYS) {
    it(`catalog defines a non-empty screen-reader string for ${key}`, () => {
      const v = leaf(catalog, key);
      expect(typeof v, `${key} must be a string in i18n/en-CA.json`).toBe('string');
      expect((v as string).trim().length).toBeGreaterThan(0);
    });
  }
});

// ===========================================================================
// FINDING 10 — loader wiring: t() resolves every key without the miss-marker.
// ===========================================================================

describe('P1-8e — t() resolves every screen-5 key (no [[miss-marker]])', () => {
  for (const key of ALL_KEYS) {
    it(`t('${key}') resolves to real copy (not [[${key}]])`, () => {
      expect(hasKey(key)).toBe(true);
      expect(t(key)).not.toBe(`[[${key}]]`);
    });
  }
});

// ===========================================================================
// Interpolation contracts — {name} / {date} placeholders consumed by t().
// ===========================================================================

describe('P1-8e — interpolation contracts', () => {
  it('committee.remove.done.body consumes {name} AND {date}', () => {
    expect(hasKey('committee.remove.done.body')).toBe(true);
    const out = t('committee.remove.done.body', { name: 'Sam Rivera', date: '2026-10-12' });
    expect(out).toContain('Sam Rivera');
    expect(out).toContain('2026-10-12');
    expect(out).not.toContain('{name}');
    expect(out).not.toContain('{date}');
  });

  it('a11y.committee.remove.done consumes {date}', () => {
    expect(hasKey('a11y.committee.remove.done')).toBe(true);
    const out = t('a11y.committee.remove.done', { date: '2026-10-12' });
    expect(out).toContain('2026-10-12');
    expect(out).not.toContain('{date}');
  });

  it('committee.role.done.body consumes {name}', () => {
    expect(hasKey('committee.role.done.body')).toBe(true);
    const out = t('committee.role.done.body', { name: 'Sam Rivera' });
    expect(out).toContain('Sam Rivera');
    expect(out).not.toContain('{name}');
  });

  it('committee.reactivate.modal.wrap consumes {name}', () => {
    expect(hasKey('committee.reactivate.modal.wrap')).toBe(true);
    const out = t('committee.reactivate.modal.wrap', { name: 'Sam Rivera' });
    expect(out).toContain('Sam Rivera');
    expect(out).not.toContain('{name}');
  });

  it('a11y.committee.approver.selected consumes {name}', () => {
    expect(hasKey('a11y.committee.approver.selected')).toBe(true);
    const out = t('a11y.committee.approver.selected', { name: 'Sam Rivera' });
    expect(out).toContain('Sam Rivera');
    expect(out).not.toContain('{name}');
  });
});

// ===========================================================================
// FINDING 6 (F-182) — the remove copy is honest about the non-crypto limit and
// carries NO data-access-revocation claim (catalog-string discipline).
// ===========================================================================

const FORBIDDEN_REVOCATION =
  /revokes? access to committee data|revoke access|can no longer decrypt|no longer read|loses? access to (the )?(committee )?data|cryptographically remove/i;

describe('P1-8e [F-182] remove i18n states the non-crypto limit, never a data-access-revocation claim', () => {
  it('committee.remove.modal.limit contains the honest non-cryptographic limit', () => {
    expect(hasKey('committee.remove.modal.limit')).toBe(true);
    const s = t('committee.remove.modal.limit');
    expect(s).toMatch(/does not rotate the shared (committee )?key|not a cryptographic lockout/i);
    expect(s).toMatch(/administrative step/i);
  });

  it('committee.remove.modal.limit does NOT claim data-access / crypto revocation', () => {
    // hasKey guards so this fails RED until the real copy exists (the
    // [[committee.remove.modal.limit]] miss-marker would trivially pass /not/).
    expect(hasKey('committee.remove.modal.limit')).toBe(true);
    expect(t('committee.remove.modal.limit')).not.toMatch(FORBIDDEN_REVOCATION);
  });

  it('committee.remove.modal.what frames a MEMBERSHIP removal, no data-access claim', () => {
    expect(hasKey('committee.remove.modal.what')).toBe(true);
    const s = t('committee.remove.modal.what');
    expect(s).toMatch(/membership/i);
    expect(s).not.toMatch(FORBIDDEN_REVOCATION);
  });

  it('committee.remove.done.body + a11y.committee.remove.done frame a MEMBERSHIP grace, not a crypto cutoff', () => {
    const combined = `${t('committee.remove.done.body', { name: 'X', date: '2026-10-12' })} ${t('a11y.committee.remove.done', { date: '2026-10-12' })}`;
    expect(combined).not.toMatch(FORBIDDEN_REVOCATION);
    // Membership framing — the grace is about reactivation, not "access ends".
    expect(t('committee.remove.done.body', { name: 'X', date: '2026-10-12' })).toMatch(/grace period|reactivate/i);
  });
});

// ===========================================================================
// FINDING 7 (F-182) — the reactivate copy states retained-wrap honesty and does
// NOT present a fresh grant / re-grant ceremony.
// ===========================================================================

describe('P1-8e [F-182] reactivate i18n states retained-wrap honesty, not a fresh grant', () => {
  it('committee.reactivate.modal.wrap states access returns via the RETAINED wrap', () => {
    expect(hasKey('committee.reactivate.modal.wrap')).toBe(true);
    const s = t('committee.reactivate.modal.wrap', { name: 'X' });
    expect(s).toMatch(/already had|retained|nothing is re-issued|not re-issued/i);
  });

  it('committee.reactivate.modal.wrap does NOT present reactivation as a fresh grant / re-grant ceremony', () => {
    // hasKey guards so this fails RED until the real copy exists (the miss-marker
    // would trivially pass the /not/ assertion).
    expect(hasKey('committee.reactivate.modal.wrap')).toBe(true);
    const s = t('committee.reactivate.modal.wrap', { name: 'X' });
    expect(s).not.toMatch(/fresh grant|re-?grant\b|grant ceremony|ceremony 4|re-?issues (the |their )?key/i);
  });
});

// ===========================================================================
// FINDING 5 (F-160) — the shared blocking/error copy names no member.
// ===========================================================================

describe('P1-8e [F-160] the shared blocking/error copy names no member (generic phrasing)', () => {
  it('fourEyes + lastCoChair + failed bodies use generic phrasing, no {name} placeholder', () => {
    for (const key of [
      'committee.manage.fourEyes.heading',
      'committee.manage.fourEyes.body',
      'committee.manage.lastCoChair.heading',
      'committee.manage.lastCoChair.body',
      'committee.manage.failed.not_found_body',
      'committee.manage.failed.generic_body'
    ]) {
      expect(hasKey(key)).toBe(true);
      // No name interpolation — these are generic, they name no member (F-160).
      expect(t(key)).not.toContain('{name}');
    }
    // lastCoChair points to a GENERIC "another worker co-chair", never a proper name.
    expect(t('committee.manage.lastCoChair.body')).toMatch(/worker co-?chair/i);
  });
});
