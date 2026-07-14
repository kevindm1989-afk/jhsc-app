/**
 * ADR-0029 P1-8d — Surface K screen 3 (co-chair grant + F-172 fingerprint
 * confirm) i18n catalog coverage. RED-FIRST (TDD). The implementer treats this
 * file as READ-ONLY.
 *
 * Pins the `committee.grant.*` + `a11y.committee.grant.*` en-CA keys the
 * designer listed (design-system.md §4 "Surface K — screen 3", the two copy
 * tables) as non-empty strings that resolve through t() (no `[[miss-marker]]`,
 * which verify-i18n.sh rejects in CI). Mirrors the P1-9 shape
 * (phase0a-waiting-fingerprint-i18n-catalog.test.ts).
 *
 * THREE load-bearing catalog invariants beyond mere presence:
 *   1. F-180 (advisory-not-load-bearing framing): the compare copy names the
 *      SERVER as the control ("the app already makes sure the key only goes to
 *      the member who set up encryption") and NEVER claims the human compare
 *      "secures"/"verifies"/"protects" the key. The word choice IS the F-180
 *      contract (design-system.md §4 "advisory-not-load-bearing framing").
 *   2. Cross-surface no-fork (design-system.md :757,:827): the per-group SR
 *      label MUST reuse the SHARED `a11y.settings.setup.fingerprint.group_label`
 *      key verbatim. A `committee.grant`-namespaced per-group variant is a drift
 *      risk and MUST NOT exist — the byte-identical SR label is the invariant.
 *   3. F-176 (never echo the reason enum): the five reason-mapped `failed.*`
 *      bodies are actionable copy, none of which contains the raw enum token.
 *
 * Scope: en-CA ONLY (fr-CA stubbed empty per ADR-0009; flagged for the
 * localization-specialist). This file does NOT require fr-CA.
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

// The full committee.grant.* copy surface (design-system.md §4 screen-3 copy table).
const GRANT_KEYS: readonly string[] = [
  'committee.grant.row.cta',
  'committee.grant.row.cta_aria',
  'committee.grant.panel.heading',
  'committee.grant.disclosing',
  'committee.grant.not_ready.heading',
  'committee.grant.not_ready.body',
  'committee.grant.not_ready.close',
  // F-174 disclosure-ordering fix (ADV-1): the NEW `not_provisioned_actor`
  // terminal — an unprovisioned co-chair is stopped BEFORE any disclosure with
  // actionable copy telling them to finish setting up their OWN encryption
  // first. New copy keys the implementer must add (mirror the not_ready shape).
  'committee.grant.not_provisioned.heading',
  'committee.grant.not_provisioned.body',
  'committee.grant.not_provisioned.close',
  'committee.grant.confirm.lead',
  'committee.grant.fingerprint_label',
  'committee.grant.compare.heading',
  'committee.grant.compare.body',
  'committee.grant.confirm.cta',
  'committee.grant.confirm.cancel',
  'committee.grant.confirm.copy',
  'committee.grant.confirm.copied',
  'committee.grant.confirm.copy_failed',
  'committee.grant.granting',
  'committee.grant.granted.heading',
  'committee.grant.granted.body',
  'committee.grant.granted.done',
  'committee.grant.failed.heading',
  'committee.grant.failed.disclosure_denied.body',
  'committee.grant.failed.no_actor_wrap.body',
  'committee.grant.failed.unlock.body',
  'committee.grant.failed.wrap_post.body',
  'committee.grant.failed.generic.body',
  'committee.grant.failed.retry',
  'committee.grant.failed.close'
];

// The a11y.committee.grant.* keys (design-system.md §4 screen-3 a11y-keys table).
// NOTE: the per-group label is deliberately ABSENT here — it is the shared
// a11y.settings.setup.fingerprint.group_label (asserted separately below).
const A11Y_GRANT_KEYS: readonly string[] = [
  'a11y.committee.grant.fingerprint.region_label',
  'a11y.committee.grant.fingerprint.ready',
  'a11y.committee.grant.fingerprint.copied',
  'a11y.committee.grant.granting',
  'a11y.committee.grant.granted',
  'a11y.committee.grant.failed'
];

const ALL_KEYS = [...GRANT_KEYS, ...A11Y_GRANT_KEYS];

// ===========================================================================
// PRESENCE — every key is a non-empty string in the root catalog
// ===========================================================================

describe('P1-8d — committee.grant.* / a11y.committee.grant.* catalog keys present + non-empty', () => {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Record<string, unknown>;

  for (const key of ALL_KEYS) {
    it(`catalog defines a non-empty string for ${key}`, () => {
      const v = leaf(catalog, key);
      expect(typeof v, `${key} must be a string in i18n/en-CA.json`).toBe('string');
      expect((v as string).trim().length, `${key} must be non-empty`).toBeGreaterThan(0);
    });
  }
});

// ===========================================================================
// LOADER WIRING — t() resolves every key (no [[miss-marker]])
// ===========================================================================

describe('P1-8d — t() resolves every grant key without the miss-marker', () => {
  for (const key of ALL_KEYS) {
    it(`t('${key}') resolves to real copy (not [[${key}]])`, () => {
      expect(hasKey(key), `${key} must be loadable via t()`).toBe(true);
      expect(t(key)).not.toBe(`[[${key}]]`);
    });
  }
});

// ===========================================================================
// CROSS-SURFACE NO-FORK — the per-group SR label REUSES the shared P1-9 key,
// and NO committee.grant per-group variant exists (design-system.md :757,:827)
// ===========================================================================

describe('P1-8d [F-172 cross-surface] the per-group SR label is the SHARED key, not a forked one', () => {
  it('the shared a11y.settings.setup.fingerprint.group_label exists and interpolates {index}+{chars}', () => {
    expect(hasKey('a11y.settings.setup.fingerprint.group_label')).toBe(true);
    const filled = t('a11y.settings.setup.fingerprint.group_label', { index: 3, chars: 'charlie 3 delta 4' });
    expect(filled).toContain('3'); // positional index
    expect(filled).toContain('16'); // "of 16" total-group landmark (mis-sync localiser)
    expect(filled).toContain('charlie 3 delta 4'); // the spelled group
    expect(filled).not.toContain('{index}');
    expect(filled).not.toContain('{chars}');
  });

  it('NO forked committee.grant per-group label key exists (drift risk — must reuse the shared key)', () => {
    // design-system.md :757 — "do NOT mint a committee.grant per-group variant".
    expect(hasKey('a11y.committee.grant.fingerprint.group_label')).toBe(false);
    expect(hasKey('committee.grant.fingerprint.group_label')).toBe(false);
  });
});

// ===========================================================================
// A11Y-1 (WCAG 2.5.3 Label in Name) — the Grant CTA's accessible name MUST
// contain its visible label as a substring. The visible label is
// `committee.grant.row.cta` ("Grant access"); the accessible name is the
// `committee.grant.row.cta_aria` override. A speech-input user saying the
// visible words must be able to activate the control.
// ===========================================================================

describe('P1-8d [A11Y-1 / WCAG 2.5.3] the Grant CTA accessible name contains its visible label', () => {
  it('cta_aria embeds the visible cta label ("Grant access") verbatim as a substring', () => {
    expect(hasKey('committee.grant.row.cta'), 'committee.grant.row.cta must exist').toBe(true);
    expect(hasKey('committee.grant.row.cta_aria'), 'committee.grant.row.cta_aria must exist').toBe(
      true
    );
    const visible = t('committee.grant.row.cta');
    const accessible = t('committee.grant.row.cta_aria', { name: 'Sam Rivera' });
    // Label-in-name: the accessible name must CONTAIN the visible label text.
    expect(
      accessible,
      `accessible name "${accessible}" must contain the visible label "${visible}" (WCAG 2.5.3)`
    ).toContain(visible);
  });
});

// ===========================================================================
// ADV-1 not_provisioned_actor copy — the new terminal's body is actionable and
// distinct from the not_ready ("the OTHER member isn't ready") copy: this one
// is about the ACTOR's own missing setup.
// ===========================================================================

describe('P1-8d [ADV-1] not_provisioned_actor copy is actionable and distinct from not_ready', () => {
  it('the not_provisioned body resolves to a real actionable sentence (not a miss-marker)', () => {
    expect(hasKey('committee.grant.not_provisioned.body')).toBe(true);
    expect(t('committee.grant.not_provisioned.body')).not.toBe(
      '[[committee.grant.not_provisioned.body]]'
    );
    expect(
      t('committee.grant.not_provisioned.body').trim().length,
      'not_provisioned body must be an actionable message'
    ).toBeGreaterThan(15);
  });

  it('the not_provisioned body is DISTINCT from the not_ready body (different situations)', () => {
    for (const k of ['committee.grant.not_provisioned.body', 'committee.grant.not_ready.body']) {
      expect(hasKey(k), `${k} must exist`).toBe(true);
    }
    expect(t('committee.grant.not_provisioned.body')).not.toBe(t('committee.grant.not_ready.body'));
  });
});

// ===========================================================================
// INTERPOLATION — the {name} data-fills the designer marked (name is data, not
// translatable copy) resolve and leave no placeholder behind
// ===========================================================================

describe('P1-8d — {name} interpolation fills where the spec marks it', () => {
  const NAME = 'Sam Rivera';
  const NAME_KEYS: readonly string[] = [
    'committee.grant.row.cta_aria',
    'committee.grant.compare.body',
    'committee.grant.granted.body',
    'a11y.committee.grant.fingerprint.region_label',
    'a11y.committee.grant.fingerprint.ready',
    'a11y.committee.grant.granted'
  ];

  it('every {name} key has the placeholder in its raw catalog value', () => {
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Record<string, unknown>;
    for (const key of NAME_KEYS) {
      const raw = leaf(catalog, key);
      expect(typeof raw, `${key} must be a string`).toBe('string');
      expect(raw as string, `${key} must interpolate {name}`).toContain('{name}');
    }
  });

  it('t(key, {name}) fills the placeholder and leaves none behind', () => {
    for (const key of NAME_KEYS) {
      const rendered = t(key, { name: NAME });
      expect(rendered, `${key} renders the name`).toContain(NAME);
      expect(rendered, `${key} leaves no {name} placeholder`).not.toContain('{name}');
    }
  });
});

// ===========================================================================
// F-180 ADVISORY FRAMING — the compare copy positions the human compare as an
// EXTRA check layered over server controls, never as the thing that secures the
// key (design-system.md §4 "advisory-not-load-bearing framing")
// ===========================================================================

describe('P1-8d [F-180] compare copy frames the read-aloud as advisory, not load-bearing', () => {
  it('the compare body names the SERVER as the control (the key only goes to the enrolled member)', () => {
    const body = t('committee.grant.compare.body', { name: 'Sam Rivera' });
    // The final clause per design-system.md :806 — the server is the control.
    expect(body).toMatch(/only goes to the member who set up encryption/i);
    // It frames the compare as an EXTRA / double-check.
    expect(body).toMatch(/extra check|granting access to the right person/i);
  });

  it('NO screen-3 compare/CTA copy claims the visual compare secures/verifies/protects the key (F-180 forbidden vocabulary)', () => {
    // design-system.md :787 — no copy may say the compare "verifies", "secures",
    // "protects", or "confirms the identity of" the member as if the seal
    // depended on it. Sweep the compare + CTA + lead copy.
    // Guard first so this fails RED on missing keys (not weakly-passes on miss-markers).
    for (const k of [
      'committee.grant.compare.heading',
      'committee.grant.compare.body',
      'committee.grant.confirm.cta',
      'committee.grant.confirm.lead'
    ]) {
      expect(hasKey(k), `${k} must exist`).toBe(true);
    }
    const combined = [
      t('committee.grant.compare.heading'),
      t('committee.grant.compare.body', { name: 'Sam Rivera' }),
      t('committee.grant.confirm.cta'),
      t('committee.grant.confirm.lead')
    ]
      .join(' ')
      .toLowerCase();
    // These would (mis)label the advisory compare as the crypto gate.
    expect(combined).not.toMatch(/secures the key|secures your key|keeps the key secure/);
    expect(combined).not.toMatch(/verifies (their|the member'?s) identity/);
    expect(combined).not.toMatch(/this (is what|verifies|secures|protects).*(key|identity)/);
  });

  it('the confirm CTA makes the affirmative claim explicit ("It matches") without a load-bearing gate', () => {
    // design-system.md :786 — the affirmative "I checked" lives in the button
    // LABEL, deliberately NOT behind a forced checkbox that would mislabel the
    // advisory step as load-bearing.
    const cta = t('committee.grant.confirm.cta');
    expect(cta).toMatch(/matches/i);
    expect(cta).toMatch(/grant access/i);
  });
});

// ===========================================================================
// F-176 REASON MAPPING — the five failed.* bodies are actionable copy that
// never echoes the raw WrapMemberInResult.reason enum token
// ===========================================================================

describe('P1-8d [F-176] failed.* bodies are actionable and never echo the raw reason enum', () => {
  const REASON_TOKENS: readonly string[] = [
    'pubkey_disclosure_denied',
    'actor_has_no_wrap',
    'data_key_unwrap_failed',
    'wrap_post_failed',
    'decrypt_failed',
    'invalid_pubkey',
    'member_not_enrolled',
    'unknown'
  ];
  const FAILED_BODY_KEYS: readonly string[] = [
    'committee.grant.failed.disclosure_denied.body',
    'committee.grant.failed.no_actor_wrap.body',
    'committee.grant.failed.unlock.body',
    'committee.grant.failed.wrap_post.body',
    'committee.grant.failed.generic.body'
  ];

  for (const key of FAILED_BODY_KEYS) {
    it(`${key} resolves to actionable copy that echoes no raw reason-enum token`, () => {
      // Guard first so this fails RED for the RIGHT reason (missing key) rather
      // than passing weakly on the `[[…]]` miss-marker.
      expect(hasKey(key), `${key} must exist`).toBe(true);
      expect(t(key), `${key} must resolve, not miss`).not.toBe(`[[${key}]]`);
      const body = t(key).toLowerCase();
      for (const token of REASON_TOKENS) {
        expect(body, `${key} must not echo the enum token "${token}"`).not.toContain(token);
      }
      // Actionable copy is a real sentence, not "Error." — a floor length.
      expect(t(key).trim().length, `${key} must be an actionable message`).toBeGreaterThan(15);
    });
  }

  it('the reason-mapped bodies are distinct (each reason class gets its own message)', () => {
    for (const key of FAILED_BODY_KEYS) {
      expect(hasKey(key), `${key} must exist`).toBe(true);
      expect(t(key), `${key} must resolve, not miss`).not.toBe(`[[${key}]]`);
    }
    const rendered = FAILED_BODY_KEYS.map((k) => t(k));
    expect(new Set(rendered).size, 'the five failed bodies must be distinct copy').toBe(
      FAILED_BODY_KEYS.length
    );
  });
});
