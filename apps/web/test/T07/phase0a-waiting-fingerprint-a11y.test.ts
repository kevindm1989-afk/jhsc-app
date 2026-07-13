/**
 * ADR-0029 P1-9-fingerprint — SetupCommitteeEncryptionCard `waiting` phase
 * ACCESSIBILITY contract (Surface L a11y packet — AODA / WCAG 2.0 AA / F-172).
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. These tests
 * are the accessibility-specialist's checklist for the member-side fingerprint.
 *
 * The read-aloud technique IS the security boundary (F-172): the member reads
 * the fingerprint to a co-chair who re-derives + compares it before granting
 * committee-key access. A skipped/duplicated/transposed GROUP is the failure
 * mode, so the SR structure is optimised for accurate human conveyance of a
 * 64-char string — grouped, numbered, spelled, navigable:
 *   - an <ol role="group" aria-label="…sixteen groups of four…"> of 16 <li>;
 *   - each group is a role="img" whose aria-label is "group N of 16, c 3 d 4"
 *     (position landmark + digit-by-digit spelled glyphs — the OneTimeCodeCard
 *     mechanism applied PER GROUP);
 *   - groups are STATIC (not tab stops);
 *   - focus moves ONCE to the top of the new content (a single deliberate move,
 *     mirroring Surface J success — not an assertive re-announce);
 *   - a polite role="status" announces the fingerprint is ready;
 *   - the ONE clipboard affordance ("Copy fingerprint") copies the contiguous
 *     value and announces via aria-live WITHOUT moving focus.
 *
 * NOTE (honest scope): touch targets ≥44px are a LAYOUT property; jsdom does no
 * layout, so pixel size is the accessibility-specialist's real-browser pass.
 * This file pins the STRUCTURAL posture (native controls, no positive tabindex,
 * role/aria/live-region categorisation) + an axe WCAG 2 AA structural sweep.
 *
 * Time note: the waiting surface reads NO clock/date, so tests use real timers
 * deliberately (determinism holds — no Date/RNG/network; the device privkey is
 * a fixed byte pattern, so the fingerprint is reproducible). Mirrors
 * committee-invite-a11y.test.ts for the axe helper + role/aria assertion style.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import _sodium from 'libsodium-wrappers-sumo';
import axeCheck from '../_helpers/axe-check';
import { setJwt, clearJwt } from '../../src/lib/auth/session-jwt-store';
import { t, hasKey } from '../../src/lib/i18n';
import { pubkeyFingerprint } from '../../src/lib/crypto';

// RED-FIRST: the `waiting` phase / a11y structure do not exist yet.
import SetupCommitteeEncryptionCard from '../../src/lib/crypto/SetupCommitteeEncryptionCard.svelte';

await _sodium.ready;
const sodium = _sodium;

const USER = '9f4e9b40-0000-4000-8000-00000000001a';
const DEVICE_PRIV = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const DEVICE_PUB = sodium.crypto_scalarmult_base(DEVICE_PRIV);
const EXPECTED_FP = await pubkeyFingerprint(DEVICE_PUB); // 64 lowercase hex

function keyState() {
  return { key_id: 'k-1', epoch: 1, wrap_count: 1, actor_has_wrap: false };
}
function makeClient() {
  return { getCommitteeKeyState: vi.fn(async () => ({ ok: true as const, data: keyState() })) };
}
function makeLocalIdentity() {
  return { getIdentityPrivateKey: vi.fn(async () => DEVICE_PRIV) };
}
function makeJwt(sub: string): string {
  const seg = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${seg({ alg: 'ES256', typ: 'JWT' })}.${seg({ sub, iat: 1700000000, exp: 1700001000 })}.sig`;
}
function accName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}
function renderCard() {
  setJwt(makeJwt(USER));
  return render(SetupCommitteeEncryptionCard, {
    props: { client: makeClient() as never, localIdentity: makeLocalIdentity() as never }
  });
}
async function toShown() {
  const { container } = renderCard();
  const box = await screen.findByTestId('setup-committee-fingerprint');
  return { container, box };
}

let clipboardWrites: string[] = [];

beforeEach(() => {
  clipboardWrites = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (s: string) => void clipboardWrites.push(String(s)) }
  });
});
afterEach(() => {
  cleanup();
  clearJwt();
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: undefined });
  vi.restoreAllMocks();
});

// ===========================================================================
// GROUPED STRUCTURE — <ol role="group"> of 16 <li>, per-group role="img"
// ===========================================================================

describe('P1-9 [a11y/F-172] grouped structure — ordered list of 16 numbered, spelled groups', () => {
  it('the fingerprint is an <ol> of exactly 16 <li>', async () => {
    const { box } = await toShown();
    const ol = box.querySelector('ol');
    expect(ol, 'the grouped fingerprint is an <ol>').not.toBeNull();
    expect(ol!.querySelectorAll('li')).toHaveLength(16);
  });

  it('the list carries role="group" so it is announced as a single navigable landmark', async () => {
    const { box } = await toShown();
    const group = box.querySelector('[role="group"]');
    expect(group, 'the grouped fingerprint sits in a role="group"').not.toBeNull();
  });

  it('each group is a role="img" spelling its 4 glyphs with a positional aria-label ("group N of 16, charlie 3 delta 4")', async () => {
    const { box } = await toShown();
    const imgs = Array.from(box.querySelectorAll('[role="img"]')) as HTMLElement[];
    expect(imgs).toHaveLength(16);

    // Every group carries position ("group N of 16") + glyph-by-glyph spelling,
    // where the confusable hex LETTERS a-f are NATO-phoneticized (alpha..foxtrot)
    // so a mis-hearing of the "E-set" (b/c/d/e) cannot corrupt the F-172
    // read-aloud, and digits 0-9 are spoken plainly (Surface L OQ-1 resolution).
    const NATO: Record<string, string> = {
      a: 'alpha',
      b: 'bravo',
      c: 'charlie',
      d: 'delta',
      e: 'echo',
      f: 'foxtrot'
    };
    const spell = (g: string) =>
      g
        .split('')
        .map((ch) => NATO[ch] ?? ch)
        .join(' ');
    const glyph = '(?:alpha|bravo|charlie|delta|echo|foxtrot|[0-9])';
    const format = new RegExp(`^group (?:[1-9]|1[0-6]) of 16, ${glyph} ${glyph} ${glyph} ${glyph}$`);
    imgs.forEach((img, i) => {
      const label = img.getAttribute('aria-label') ?? '';
      expect(label, `group ${i + 1} aria-label format`).toMatch(format);
      expect(label.startsWith(`group ${i + 1} of 16, `), `group ${i + 1} is numbered in order`).toBe(true);
    });

    // Byte-exact check on a specific group (the spec's own example shape).
    const g3chars = EXPECTED_FP.slice(8, 12); // group 3 (0-indexed 2)
    const expectedG3 = `group 3 of 16, ${spell(g3chars)}`;
    expect(imgs[2]!.getAttribute('aria-label')).toBe(expectedG3);
  });

  it('the groups are STATIC (not tab stops) and nothing in the waiting phase has a positive tabindex', async () => {
    const { container, box } = await toShown();
    // No group is a tab stop.
    for (const el of Array.from(box.querySelectorAll('[role="img"], li'))) {
      expect(el.getAttribute('tabindex') === '0', 'a group must not be a tab stop').toBe(false);
    }
    // No positive tabindex anywhere in the card.
    const positives = Array.from(container.querySelectorAll('[tabindex]')).filter(
      (el) => Number(el.getAttribute('tabindex')) > 0
    );
    expect(positives).toEqual([]);
  });
});

// ===========================================================================
// LIVE REGIONS + FOCUS — polite "ready", single focus move on entry
// ===========================================================================

describe('P1-9 [a11y] live regions + focus-on-entry', () => {
  it('a polite role="status" region announces the fingerprint is ready', async () => {
    expect(hasKey('a11y.settings.setup.fingerprint.ready')).toBe(true);
    const { container } = await toShown();
    const statuses = Array.from(container.querySelectorAll('[role="status"]'));
    const announced = statuses.some((r) =>
      (r.textContent ?? '').includes(t('a11y.settings.setup.fingerprint.ready'))
    );
    expect(announced, 'a role="status" region carries a11y.settings.setup.fingerprint.ready').toBe(true);
  });

  it('the list region carries the "sixteen groups of four" aria-label so the SR user knows the shape up front', async () => {
    expect(hasKey('a11y.settings.setup.fingerprint.region_label')).toBe(true);
    const { box } = await toShown();
    const group = box.querySelector('[role="group"]');
    expect(group).not.toBeNull();
    expect(group!.getAttribute('aria-label')).toBe(t('a11y.settings.setup.fingerprint.region_label'));
  });

  it('focus moves ONCE to a tabindex="-1" element at the top of the new content (single deliberate move)', async () => {
    const { container } = await toShown();
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active, 'focus landed on a deliberate target').not.toBeNull();
      expect(active!.getAttribute('tabindex'), 'the focus target is a programmatic -1 target').toBe('-1');
      expect(container.contains(active), 'focus is inside the waiting card').toBe(true);
      expect((active!.textContent ?? '').trim().length, 'the focus target carries readable lead/heading text').toBeGreaterThan(0);
    });
  });
});

// ===========================================================================
// COPY AFFORDANCE — exactly one, "Copy fingerprint", announces without stealing focus
// ===========================================================================

describe('P1-9 [a11y] Copy fingerprint control', () => {
  it('there is exactly one clipboard affordance and it is a native button named "Copy fingerprint"', async () => {
    expect(hasKey('settings.setupCommitteeEncryption.waiting.copy')).toBe(true);
    const { box, container } = await toShown();
    void box;
    const copies = Array.from(container.querySelectorAll('button,a')).filter((el) => /copy/i.test(accName(el)));
    expect(copies).toHaveLength(1);
    expect(copies[0]!.tagName.toLowerCase()).toBe('button');
    expect(accName(copies[0]!)).toBe(t('settings.setupCommitteeEncryption.waiting.copy'));
  });

  it('the copy control announces "Fingerprint copied" via aria-live WITHOUT moving focus', async () => {
    expect(hasKey('a11y.settings.setup.fingerprint.copied')).toBe(true);
    const { container } = await toShown();
    const copyBtn = screen.getByTestId('share-url-btn');
    const before = document.activeElement;
    await fireEvent.click(copyBtn);
    await waitFor(() => {
      const live = Array.from(container.querySelectorAll('[aria-live="polite"]'));
      expect(
        live.some((r) => (r.textContent ?? '').includes(t('a11y.settings.setup.fingerprint.copied')))
      ).toBe(true);
    });
    expect(document.activeElement).toBe(before);
  });
});

// ===========================================================================
// axe WCAG 2 AA structural sweep — shown + derive_error
// ===========================================================================

describe('P1-9 [a11y] axe WCAG 2 AA structural sweep', () => {
  it('the `shown` waiting state has no axe violations', async () => {
    const { container } = await toShown();
    const r = await axeCheck(container, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });

  it('the `derive_error` fail-safe state has no axe violations', async () => {
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('synthetic-digest-failure'));
    setJwt(makeJwt(USER));
    const { container } = render(SetupCommitteeEncryptionCard, {
      props: { client: makeClient() as never, localIdentity: makeLocalIdentity() as never }
    });
    await screen.findByTestId('setup-committee-waiting-error');
    const r = await axeCheck(container, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });
});
