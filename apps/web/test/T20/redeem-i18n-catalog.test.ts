/**
 * ADR-0029 P1-7 — /redeem i18n catalog coverage (Surface J copy keys).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. Mirrors the
 * catalog assertions in sign-in-route-mount.test.ts: every `redeem.*` +
 * `a11y.redeem.*` key the Surface J spec defines MUST be present (and a string)
 * in the en-CA catalog, so the route + card resolve real copy via t() rather
 * than the `[[redeem.title]]` miss-marker (which verify-i18n.sh rejects in CI).
 *
 * Scope: en-CA only (the localization-specialist owns fr-CA per ADR-0009).
 *
 * The keys are the designer's Surface J catalog (design-system.md §4 Surface J):
 *   redeem.title / redeem.intro
 *   redeem.code_label / redeem.code_helper
 *   redeem.button.idle / redeem.button.requesting / redeem.button.verifying
 *   redeem.waiting
 *   redeem.success.heading / redeem.success.body / redeem.success.cta
 *   redeem.error.invalid.heading / redeem.error.invalid.body
 *   redeem.error.rate_limited.heading / redeem.error.rate_limited.body
 *   redeem.cancelled
 *   redeem.error.unsupported.heading / redeem.error.unsupported.body
 *   redeem.error.system.heading / redeem.error.system.body
 *   redeem.incomplete_link.heading / redeem.incomplete_link.body
 *   a11y.redeem.requesting / a11y.redeem.verifying
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

const REDEEM_KEYS: readonly string[] = [
  'redeem.title',
  'redeem.intro',
  'redeem.code_label',
  'redeem.code_helper',
  'redeem.button.idle',
  'redeem.button.requesting',
  'redeem.button.verifying',
  'redeem.waiting',
  'redeem.success.heading',
  'redeem.success.body',
  'redeem.success.cta',
  'redeem.error.invalid.heading',
  'redeem.error.invalid.body',
  'redeem.error.rate_limited.heading',
  'redeem.error.rate_limited.body',
  'redeem.cancelled',
  'redeem.error.unsupported.heading',
  'redeem.error.unsupported.body',
  'redeem.error.system.heading',
  'redeem.error.system.body',
  'redeem.incomplete_link.heading',
  'redeem.incomplete_link.body'
];

const A11Y_REDEEM_KEYS: readonly string[] = ['a11y.redeem.requesting', 'a11y.redeem.verifying'];

describe('P1-7 — redeem.* catalog keys present + non-empty strings', () => {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Record<string, unknown>;

  for (const key of REDEEM_KEYS) {
    it(`catalog defines a non-empty string for ${key}`, () => {
      const v = leaf(catalog, key);
      expect(typeof v, `${key} must be a string in i18n/en-CA.json`).toBe('string');
      expect((v as string).trim().length).toBeGreaterThan(0);
    });
  }

  for (const key of A11Y_REDEEM_KEYS) {
    it(`catalog defines a non-empty screen-reader string for ${key}`, () => {
      const v = leaf(catalog, key);
      expect(typeof v, `${key} must be a string in i18n/en-CA.json`).toBe('string');
      expect((v as string).trim().length).toBeGreaterThan(0);
    });
  }
});

describe('P1-7 — t() resolves every redeem key (loader wiring) without the miss-marker', () => {
  for (const key of [...REDEEM_KEYS, ...A11Y_REDEEM_KEYS]) {
    it(`t('${key}') resolves to real copy (not [[${key}]])`, () => {
      expect(hasKey(key)).toBe(true);
      expect(t(key)).not.toBe(`[[${key}]]`);
    });
  }
});

describe('P1-7 — F-169/F-170 oracle: the normalized invalid copy carries no sub-condition vocabulary', () => {
  it('redeem.error.invalid.* never names expired/locked/consumed/wrong-code/not-found', () => {
    // Guard against a false-positive: this oracle assertion is only meaningful
    // once the keys RESOLVE to real copy. Pre-implementation the keys miss and
    // t() returns the `[[...]]` marker (which trivially has no sub-condition
    // vocabulary). Asserting resolution first makes this test fail RED now and
    // genuinely exercise the oracle defense once the copy exists.
    expect(hasKey('redeem.error.invalid.heading')).toBe(true);
    expect(hasKey('redeem.error.invalid.body')).toBe(true);
    const heading = t('redeem.error.invalid.heading');
    const body = t('redeem.error.invalid.body');
    const combined = `${heading} ${body}`;
    // The single normalized message must not let the member distinguish which
    // condition failed (enumeration / oracle defeat) — it collapses them all.
    expect(combined).not.toMatch(/expired|locked|consumed|already used|wrong code|not found/i);
  });

  it('redeem.error.invalid.body references the co-chair re-send path (P1-6 recovery)', () => {
    expect(hasKey('redeem.error.invalid.body')).toBe(true);
    expect(t('redeem.error.invalid.body')).toMatch(/co-?chair/i);
  });
});
