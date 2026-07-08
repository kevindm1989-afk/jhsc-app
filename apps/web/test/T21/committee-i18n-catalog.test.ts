/**
 * ADR-0029 P1-8b — /committee i18n catalog coverage (Surface K committee.* copy).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. Mirrors
 * redeem-i18n-catalog.test.ts: every `committee.*` + `a11y.committee.*` key the
 * Surface K spec defines MUST be present (and a non-empty string) in the en-CA
 * catalog, so the route + roster resolve real copy via t() rather than the
 * `[[committee.roster.title]]` miss-marker (which verify-i18n.sh rejects in CI).
 *
 * Scope: en-CA only (the localization-specialist owns fr-CA per ADR-0009).
 *
 * The keys are the designer's Surface K catalog (design-system.md §4 Surface K).
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

// Every Surface K committee.* key (nav + roster shell + row + role + badge).
const COMMITTEE_KEYS: readonly string[] = [
  'committee.nav.label',
  'committee.nav.blurb',
  'committee.roster.title',
  'committee.roster.signed_out',
  'committee.roster.loading',
  'committee.roster.list_aria',
  'committee.roster.not_co_chair.heading',
  'committee.roster.not_co_chair.body',
  'committee.roster.not_co_chair.back',
  'committee.roster.session_expired',
  'committee.roster.error.heading',
  'committee.roster.error.body',
  'committee.roster.error.retry',
  'committee.roster.empty.heading',
  'committee.roster.empty.body',
  'committee.roster.row.unnamed',
  'committee.roster.row.contact_label',
  'committee.roster.row.date_invited',
  'committee.roster.row.date_joined',
  'committee.roster.row.date_member_since',
  'committee.roster.row.date_removed',
  'committee.roster.row.date_grace_until',
  'committee.roster.role.worker_co_chair',
  'committee.roster.role.worker_member',
  'committee.roster.role.certified_member',
  'committee.roster.badge.active.text',
  'committee.roster.badge.active.sr',
  'committee.roster.badge.pending_grant.text',
  'committee.roster.badge.pending_grant.sr',
  'committee.roster.badge.awaiting_identity.text',
  'committee.roster.badge.awaiting_identity.sr',
  'committee.roster.badge.pending_invite.text',
  'committee.roster.badge.pending_invite.sr',
  'committee.roster.badge.inactive.text',
  'committee.roster.badge.inactive.sr',
  'committee.roster.back_to_more'
];

const A11Y_COMMITTEE_KEYS: readonly string[] = ['a11y.committee.roster.loaded'];

// Keys that interpolate {date}.
const DATE_KEYS: readonly string[] = [
  'committee.roster.row.date_invited',
  'committee.roster.row.date_joined',
  'committee.roster.row.date_member_since',
  'committee.roster.row.date_removed',
  'committee.roster.row.date_grace_until'
];

describe('P1-8b — committee.* catalog keys present + non-empty strings', () => {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Record<string, unknown>;

  for (const key of COMMITTEE_KEYS) {
    it(`catalog defines a non-empty string for ${key}`, () => {
      const v = leaf(catalog, key);
      expect(typeof v, `${key} must be a string in i18n/en-CA.json`).toBe('string');
      expect((v as string).trim().length).toBeGreaterThan(0);
    });
  }

  for (const key of A11Y_COMMITTEE_KEYS) {
    it(`catalog defines a non-empty screen-reader string for ${key}`, () => {
      const v = leaf(catalog, key);
      expect(typeof v, `${key} must be a string in i18n/en-CA.json`).toBe('string');
      expect((v as string).trim().length).toBeGreaterThan(0);
    });
  }
});

describe('P1-8b — t() resolves every committee key (loader wiring) without the miss-marker', () => {
  for (const key of [...COMMITTEE_KEYS, ...A11Y_COMMITTEE_KEYS]) {
    it(`t('${key}') resolves to real copy (not [[${key}]])`, () => {
      expect(hasKey(key)).toBe(true);
      expect(t(key)).not.toBe(`[[${key}]]`);
    });
  }
});

describe('P1-8b — interpolation contracts', () => {
  for (const key of DATE_KEYS) {
    it(`${key} interpolates a {date} placeholder`, () => {
      expect(hasKey(key)).toBe(true);
      // The placeholder must be consumed by t() — a rendered date replaces it.
      expect(t(key, { date: '2026-02-10' })).toContain('2026-02-10');
      expect(t(key, { date: '2026-02-10' })).not.toContain('{date}');
    });
  }

  it('a11y.committee.roster.loaded interpolates a {count} placeholder', () => {
    expect(hasKey('a11y.committee.roster.loaded')).toBe(true);
    expect(t('a11y.committee.roster.loaded', { count: 5 })).toContain('5');
    expect(t('a11y.committee.roster.loaded', { count: 5 })).not.toContain('{count}');
  });
});

describe('P1-8b — F-176 posture: the roster error/stop copy carries no raw reason enum', () => {
  it('the generic error copy names no raw CommitteeOpReason enum / HTTP status', () => {
    expect(hasKey('committee.roster.error.heading')).toBe(true);
    expect(hasKey('committee.roster.error.body')).toBe(true);
    const combined = `${t('committee.roster.error.heading')} ${t('committee.roster.error.body')}`;
    expect(combined).not.toMatch(/rls_denied|4eyes_required|membership_exists|unknown\b/i);
    expect(combined).not.toMatch(/\b(401|403|500)\b/);
  });

  it('the not-a-co-chair copy is calm/informational — it names the co-chair boundary, not a failure', () => {
    expect(hasKey('committee.roster.not_co_chair.heading')).toBe(true);
    expect(hasKey('committee.roster.not_co_chair.body')).toBe(true);
    const combined = `${t('committee.roster.not_co_chair.heading')} ${t('committee.roster.not_co_chair.body')}`;
    // References co-chairs (the boundary) without leaking the raw denial enum.
    expect(combined).toMatch(/co-?chair/i);
    expect(combined).not.toMatch(/rls_denied|error|denied|forbidden/i);
  });
});
