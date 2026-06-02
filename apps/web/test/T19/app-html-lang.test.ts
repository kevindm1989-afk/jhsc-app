/**
 * T19.1 — `<html lang>` attribute pin + manifest-lang drift guard.
 *
 * The root `<html lang="en-CA">` declaration in `app.html` is the
 * primary locale signal screen readers, translation tooling, and
 * browser spell-checkers consult. WCAG 3.1.1 ("Language of Page")
 * REQUIRES the lang attribute be set + correct; without it, NVDA /
 * JAWS / VoiceOver fall back to a system-default pronunciation that
 * mangles English-Canadian copy (and would mis-pronounce future fr-CA
 * copy entirely if the lang was wrong).
 *
 * The PWA manifest separately declares `"lang": "en-CA"` (pinned by
 * pwa-manifest.test.ts) — the two values MUST stay in sync. If a
 * future locale-switching refactor changes one without the other,
 * the OS install shell, the manifest install prompt, and the in-app
 * AT announcements would disagree about what language the app is in.
 *
 * Pins:
 *   - `<html lang="en-CA">` present in app.html.
 *   - The lang value matches the manifest's lang field exactly
 *     (drift guard).
 *   - The lang attribute is NOT empty / NOT missing (regression
 *     guard against an accidental refactor that drops it).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_HTML_PATH = resolve(__dirname, '../../src/app.html');
const MANIFEST_PATH = resolve(__dirname, '../../static/manifest.webmanifest');

describe('T19.1 — <html lang> attribute on app.html', () => {
  it('app.html exists', () => {
    expect(existsSync(APP_HTML_PATH)).toBe(true);
  });

  it('declares <html lang="en-CA"> (WCAG 3.1.1 Language of Page)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Allow other attributes between `<html` and the closing `>`
    // (e.g. SvelteKit's `%sveltekit.theme%` template token, future
    // `dir="ltr"` etc.) — just pin that `lang="en-CA"` is present
    // somewhere in the opening html tag.
    expect(src).toMatch(/<html\b[^>]*\blang=["']en-CA["'][^>]*>/);
  });

  it('does NOT use a stale lang value (en, en-US, etc.) — regression guard', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Defense pin: a refactor that swaps en-CA for a less-specific
    // tag (en) or the wrong locale (en-US) would silently mis-set the
    // page's locale. Pin against the two most likely drift values.
    expect(src).not.toMatch(/<html\b[^>]*\blang=["']en["'][^>]*>/);
    expect(src).not.toMatch(/<html\b[^>]*\blang=["']en-US["'][^>]*>/);
  });

  it('declares explicit dir="ltr" on <html> (WCAG / a11y screen-reader correctness)', () => {
    // Per WCAG 3.1.1 + screen-reader best practice the `dir` attribute
    // should be explicit, not relied on via UA's lang→dir default.
    // For en-CA the value is ltr; future fr-CA stays ltr. RTL locales
    // (Arabic / Hebrew — not in scope today) would require flipping
    // this value to `rtl` in lockstep with the lang change.
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    expect(src).toMatch(/<html\b[^>]*\bdir=["']ltr["'][^>]*>/);
  });

  it('does NOT use dir="rtl" or dir="auto" (regression guard)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Defense pin: `dir="auto"` lets the UA infer from content, which
    // produces mixed-direction text on multi-locale pages — exactly
    // what the future fr-CA build wants to avoid. `dir="rtl"` would
    // mirror the whole UI; both are wrong for en-CA / fr-CA.
    expect(src).not.toMatch(/<html\b[^>]*\bdir=["'](?:rtl|auto)["'][^>]*>/);
  });
});

describe('T19.1 — html lang ↔ manifest lang drift guard', () => {
  it('the manifest lang field matches the <html lang> attribute exactly', () => {
    // The OS install shell, install prompt, and in-app AT
    // announcements must agree on locale. A drift between manifest
    // and html lang produces UX where (e.g.) iOS reads the app name
    // in en-CA pronunciation while in-app content is announced in a
    // different locale.
    const htmlSrc = readFileSync(APP_HTML_PATH, 'utf8');
    const htmlLangMatch = htmlSrc.match(/<html\b[^>]*\blang=["']([^"']+)["'][^>]*>/);
    expect(htmlLangMatch).not.toBeNull();
    const htmlLang = htmlLangMatch?.[1];

    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    expect(manifest.lang).toBe(htmlLang);
  });
});
