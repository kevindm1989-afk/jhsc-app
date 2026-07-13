/**
 * ADR-0029 P1-8c — /committee invite + re-send i18n catalog coverage
 * (Surface K screens 2/4 committee.invite.* + committee.resend.* copy).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. Mirrors
 * committee-i18n-catalog.test.ts (P1-8b): every `committee.invite.*` /
 * `committee.resend.*` / `a11y.committee.{invite,resend}.*` key the Surface K
 * screen-2/4 spec defines MUST be present (a non-empty string) in the en-CA
 * catalog, so the invite/pending components resolve real copy via t() rather than
 * the `[[committee.invite.cta]]` miss-marker (which verify-i18n.sh rejects in CI).
 *
 * Scope: en-CA only (the localization-specialist owns fr-CA per ADR-0009).
 *
 * The keys are the designer's Surface K screen-2/4 catalog. Per the orchestrator
 * resolution (2026-07-13), the `rate_limited` + `exists` error states are collapsed
 * into the GENERIC error (429 is defensive-only; any-other → generic), so this file
 * requires ONLY the keys the resolved state machine actually renders — it does NOT
 * require committee.invite.error.rate_limited.* / .exists.* (flagged in the report).
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

// Screen 2 (Invite a member) — the keys the RESOLVED state machine renders.
const INVITE_KEYS: readonly string[] = [
  'committee.invite.cta',
  'committee.invite.form.heading',
  'committee.invite.roles.legend',
  'committee.invite.role.worker_member',
  'committee.invite.role.worker_co_chair',
  'committee.invite.role.certified_member',
  'committee.invite.role.co_chair_note',
  'committee.invite.roles.required',
  'committee.invite.form.submit',
  'committee.invite.form.cancel',
  'committee.invite.form.submitting',
  'committee.invite.code.heading',
  'committee.invite.code.label',
  'committee.invite.custody.heading',
  'committee.invite.custody.body',
  'committee.invite.link.label',
  'committee.invite.link.helper',
  'committee.invite.link.copy',
  'committee.invite.link.copied',
  'committee.invite.link.copy_failed',
  'committee.invite.code.once',
  'committee.invite.code.done',
  'committee.invite.code.resend_now',
  'committee.invite.error.not_co_chair.heading',
  'committee.invite.error.not_co_chair.body',
  'committee.invite.error.reload',
  'committee.invite.error.invalid_role.heading',
  'committee.invite.error.invalid_role.body',
  'committee.invite.error.generic.heading',
  'committee.invite.error.generic.body'
];

// Screen 4 (Re-send code) — Pending-invites section + per-row re-send.
const RESEND_KEYS: readonly string[] = [
  'committee.resend.section.heading',
  'committee.resend.section.blurb',
  'committee.resend.list_aria',
  'committee.resend.loading',
  'committee.resend.empty.heading',
  'committee.resend.empty.body',
  'committee.resend.status.waiting',
  'committee.resend.status.expired',
  'committee.resend.row.issued',
  'committee.resend.row.expires',
  'committee.resend.row.action',
  'committee.resend.row.action_aria',
  'committee.resend.row.reinvite',
  'committee.resend.confirm.heading',
  'committee.resend.confirm.body',
  'committee.resend.confirm.go',
  'committee.resend.confirm.cancel',
  'committee.resend.submitting',
  'committee.resend.code.heading',
  'committee.resend.invalid.heading',
  'committee.resend.invalid.body',
  'committee.resend.invalid.reinvite',
  'committee.resend.error.generic.heading',
  'committee.resend.error.generic.body'
];

// The roster cross-reference hint added in P1-8c (roster ↔ Pending-invites).
const ROSTER_HINT_KEYS: readonly string[] = ['committee.roster.badge.pending_invite.hint'];

const A11Y_KEYS: readonly string[] = [
  'a11y.committee.invite.submitting',
  'a11y.committee.invite.code_ready',
  'a11y.committee.resend.submitting',
  'a11y.committee.resend.code_ready'
];

const ALL_KEYS = [...INVITE_KEYS, ...RESEND_KEYS, ...ROSTER_HINT_KEYS, ...A11Y_KEYS];

const DATE_KEYS: readonly string[] = [
  'committee.resend.row.issued',
  'committee.resend.row.expires'
];

// ===========================================================================
// PRESENCE — every key is a non-empty string in the root catalog
// ===========================================================================

describe('P1-8c — committee.invite.* / committee.resend.* catalog keys present + non-empty', () => {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Record<string, unknown>;

  for (const key of [...INVITE_KEYS, ...RESEND_KEYS, ...ROSTER_HINT_KEYS]) {
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
// LOADER WIRING — t() resolves every key (no [[miss-marker]])
// ===========================================================================

describe('P1-8c — t() resolves every invite/resend key without the miss-marker', () => {
  for (const key of ALL_KEYS) {
    it(`t('${key}') resolves to real copy (not [[${key}]])`, () => {
      expect(hasKey(key)).toBe(true);
      expect(t(key)).not.toBe(`[[${key}]]`);
    });
  }
});

// ===========================================================================
// INTERPOLATION — {date} + {name} placeholders are consumed by t()
// ===========================================================================

describe('P1-8c — interpolation contracts', () => {
  for (const key of DATE_KEYS) {
    it(`${key} interpolates a {date} placeholder`, () => {
      expect(hasKey(key)).toBe(true);
      expect(t(key, { date: '2026-05-20' })).toContain('2026-05-20');
      expect(t(key, { date: '2026-05-20' })).not.toContain('{date}');
    });
  }

  it('committee.resend.row.action_aria interpolates a {name} placeholder', () => {
    expect(hasKey('committee.resend.row.action_aria')).toBe(true);
    const rendered = t('committee.resend.row.action_aria', { name: 'Pending Paula' });
    expect(rendered).toContain('Pending Paula');
    expect(rendered).not.toContain('{name}');
  });
});

// ===========================================================================
// F-170 — the custody copy teaches the split; the link copy is LINK-labelled
// ===========================================================================

describe('P1-8c — F-170 custody copy teaches the code/link split', () => {
  it('the custody callout tells the co-chair to send the code and link SEPARATELY', () => {
    expect(hasKey('committee.invite.custody.heading')).toBe(true);
    expect(hasKey('committee.invite.custody.body')).toBe(true);
    expect(t('committee.invite.custody.heading')).toMatch(/separate/i);
    // The body warns against putting both in the same message.
    expect(t('committee.invite.custody.body')).toMatch(/same message|different app|out loud/i);
  });

  it('the link helper reassures that the link does NOT contain the code (safe to send)', () => {
    expect(hasKey('committee.invite.link.helper')).toBe(true);
    expect(t('committee.invite.link.helper')).toMatch(/does not contain the code|safe/i);
  });

  it('the copy control is LINK-labelled — "Copy link", never "copy code"', () => {
    // hasKey guards so this fails RED until the real copy exists (the
    // [[committee.invite.link.copy]] miss-marker would otherwise match /link/i).
    expect(hasKey('committee.invite.link.copy')).toBe(true);
    expect(hasKey('committee.invite.link.copied')).toBe(true);
    expect(t('committee.invite.link.copy')).toMatch(/link/i);
    expect(t('committee.invite.link.copy')).not.toMatch(/code/i);
    expect(t('committee.invite.link.copied')).toMatch(/copied/i);
  });

  it('the "shown once" reminder tells the co-chair the code is not recoverable', () => {
    expect(hasKey('committee.invite.code.once')).toBe(true);
    expect(t('committee.invite.code.once')).toMatch(/once/i);
  });
});

// ===========================================================================
// F-176 — the error copy carries no raw reason enum / HTTP status
// ===========================================================================

describe('P1-8c — F-176 posture: mapped error copy leaks no raw reason enum / status', () => {
  it('the invite generic error copy names no CommitteeOpReason enum / HTTP status', () => {
    // hasKey guards guarantee this fails RED until the real copy exists (rather
    // than passing accidentally against the [[miss-marker]]).
    expect(hasKey('committee.invite.error.generic.heading')).toBe(true);
    expect(hasKey('committee.invite.error.generic.body')).toBe(true);
    const combined = `${t('committee.invite.error.generic.heading')} ${t('committee.invite.error.generic.body')}`;
    expect(combined).not.toMatch(/rls_denied|invalid_role|membership_exists|already_active|invite_invalid|unknown\b|rate_limited/i);
    expect(combined).not.toMatch(/\b(400|401|403|409|422|429|500)\b/);
  });

  it('the re-send generic error copy names no CommitteeOpReason enum / HTTP status', () => {
    expect(hasKey('committee.resend.error.generic.heading')).toBe(true);
    expect(hasKey('committee.resend.error.generic.body')).toBe(true);
    const combined = `${t('committee.resend.error.generic.heading')} ${t('committee.resend.error.generic.body')}`;
    expect(combined).not.toMatch(/rls_denied|invite_invalid|unknown\b|rate_limited/i);
    expect(combined).not.toMatch(/\b(401|403|422|429|500)\b/);
  });

  it('the invite_invalid re-send copy is a normalized message (no raw enum), pointing to "invite again"', () => {
    expect(hasKey('committee.resend.invalid.heading')).toBe(true);
    expect(hasKey('committee.resend.invalid.body')).toBe(true);
    const combined = `${t('committee.resend.invalid.heading')} ${t('committee.resend.invalid.body')}`;
    // The co-chair gets the SAME literal an attacker would (F-169/F-170 oracle):
    // it must not echo the raw closed-literal reason.
    expect(combined).not.toContain('invite_invalid');
    expect(t('committee.resend.invalid.reinvite')).toMatch(/invite again/i);
  });
});
