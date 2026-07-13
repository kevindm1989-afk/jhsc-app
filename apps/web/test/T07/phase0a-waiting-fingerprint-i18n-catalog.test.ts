/**
 * ADR-0029 P1-9-fingerprint — SetupCommitteeEncryptionCard `waiting` phase
 * i18n catalog coverage (Surface L copy — settings.setupCommitteeEncryption.
 * waiting.* + a11y.settings.setup.fingerprint.*). RED-FIRST (TDD). The
 * implementer treats this file as READ-ONLY.
 *
 * Every key the Surface L spec defines MUST be a non-empty string in the en-CA
 * root catalog so the card resolves real copy via t() rather than the
 * `[[…]]` miss-marker (which verify-i18n.sh rejects in CI). The group-label
 * key is load-bearing for the F-172 read-aloud: it MUST interpolate BOTH
 * {index} (the positional landmark) and {chars} (the client-filled spelled
 * glyphs).
 *
 * Scope: en-CA ONLY. Per the Surface L resolution (design-system.md §4 open
 * question 2), the existing settings.setupCommitteeEncryption.* keys have no
 * fr-CA siblings, so these new keys are en-CA-only and the whole subtree is
 * flagged for the localization-specialist's future fr-CA pass. This file does
 * NOT require fr-CA (flagged in the report). Mirrors
 * committee-invite-i18n-catalog.test.ts.
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

const WAITING_KEYS: readonly string[] = [
  'settings.setupCommitteeEncryption.waiting.lead',
  'settings.setupCommitteeEncryption.waiting.fingerprint_label',
  'settings.setupCommitteeEncryption.waiting.compare_heading',
  'settings.setupCommitteeEncryption.waiting.compare_body',
  'settings.setupCommitteeEncryption.waiting.computing',
  'settings.setupCommitteeEncryption.waiting.copy',
  'settings.setupCommitteeEncryption.waiting.copied',
  'settings.setupCommitteeEncryption.waiting.copy_failed',
  'settings.setupCommitteeEncryption.waiting.error.heading',
  'settings.setupCommitteeEncryption.waiting.error.body',
  'settings.setupCommitteeEncryption.waiting.error.retry'
];

const A11Y_KEYS: readonly string[] = [
  'a11y.settings.setup.fingerprint.ready',
  'a11y.settings.setup.fingerprint.region_label',
  'a11y.settings.setup.fingerprint.group_label',
  'a11y.settings.setup.fingerprint.copied'
];

const ALL_KEYS = [...WAITING_KEYS, ...A11Y_KEYS];

// ===========================================================================
// PRESENCE — every key is a non-empty string in the root catalog
// ===========================================================================

describe('P1-9 — waiting.* / a11y.settings.setup.fingerprint.* catalog keys present + non-empty', () => {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Record<string, unknown>;

  for (const key of ALL_KEYS) {
    it(`catalog defines a non-empty string for ${key}`, () => {
      const v = leaf(catalog, key);
      expect(typeof v, `${key} must be a string in i18n/en-CA.json`).toBe('string');
      expect((v as string).trim().length).toBeGreaterThan(0);
    });
  }
});

// ===========================================================================
// LOADER WIRING — t() resolves every key (no [[miss-marker]])
// ===========================================================================

describe('P1-9 — t() resolves every waiting/fingerprint key without the miss-marker', () => {
  for (const key of ALL_KEYS) {
    it(`t('${key}') resolves to real copy (not [[${key}]])`, () => {
      expect(hasKey(key)).toBe(true);
      expect(t(key)).not.toBe(`[[${key}]]`);
    });
  }
});

// ===========================================================================
// INTERPOLATION — the group label carries {index} + {chars} (F-172 read-aloud)
// ===========================================================================

describe('P1-9 [F-172] group_label interpolates the positional index AND the spelled chars', () => {
  it('the raw catalog value contains both {index} and {chars} placeholders', () => {
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Record<string, unknown>;
    const raw = leaf(catalog, 'a11y.settings.setup.fingerprint.group_label');
    expect(typeof raw).toBe('string');
    expect(raw as string).toContain('{index}');
    expect(raw as string).toContain('{chars}');
  });

  it('t(group_label, {index, chars}) fills both placeholders and leaves none behind', () => {
    expect(hasKey('a11y.settings.setup.fingerprint.group_label')).toBe(true);
    const rendered = t('a11y.settings.setup.fingerprint.group_label', { index: 3, chars: 'c 3 d 4' });
    expect(rendered).toContain('3'); // the positional index
    expect(rendered).toContain('16'); // "of 16" — the total-group landmark
    expect(rendered).toContain('c 3 d 4'); // the spelled group
    expect(rendered).not.toContain('{index}');
    expect(rendered).not.toContain('{chars}');
  });
});

// ===========================================================================
// FIDELITY — the copy teaches the F-172 compare purpose; copy is "fingerprint"
// (deliberate contrast with Surface K, where copy-of-the-value is forbidden)
// ===========================================================================

describe('P1-9 — Surface L copy fidelity', () => {
  it('the compare copy tells the member to read the fingerprint to their co-chair to confirm identity', () => {
    expect(hasKey('settings.setupCommitteeEncryption.waiting.compare_heading')).toBe(true);
    expect(hasKey('settings.setupCommitteeEncryption.waiting.compare_body')).toBe(true);
    const combined = `${t('settings.setupCommitteeEncryption.waiting.compare_heading')} ${t('settings.setupCommitteeEncryption.waiting.compare_body')}`;
    expect(combined).toMatch(/co-?chair/i);
    expect(combined).toMatch(/read|show/i);
  });

  it('the lead copy frames the calm "you are set up, now waiting for access" context', () => {
    expect(hasKey('settings.setupCommitteeEncryption.waiting.lead')).toBe(true);
    expect(t('settings.setupCommitteeEncryption.waiting.lead')).toMatch(/wait/i);
  });

  it('the copy control is FINGERPRINT-labelled and the copied announce confirms the copy', () => {
    expect(hasKey('settings.setupCommitteeEncryption.waiting.copy')).toBe(true);
    expect(hasKey('a11y.settings.setup.fingerprint.copied')).toBe(true);
    expect(t('settings.setupCommitteeEncryption.waiting.copy')).toMatch(/copy/i);
    expect(t('settings.setupCommitteeEncryption.waiting.copy')).toMatch(/fingerprint/i);
    expect(t('a11y.settings.setup.fingerprint.copied')).toMatch(/copied/i);
  });

  it('the region/ready announcements state the shape ("sixteen groups of four")', () => {
    expect(hasKey('a11y.settings.setup.fingerprint.region_label')).toBe(true);
    expect(hasKey('a11y.settings.setup.fingerprint.ready')).toBe(true);
    expect(t('a11y.settings.setup.fingerprint.region_label')).toMatch(/sixteen|16/i);
    expect(t('a11y.settings.setup.fingerprint.ready')).toMatch(/sixteen|16/i);
  });
});
