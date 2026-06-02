/**
 * T19.1 — app.html boot CSS pins (prefers-reduced-motion +
 * prefers-color-scheme dark).
 *
 * The inline `<style>` block in app.html runs BEFORE any component
 * CSS loads — it's the safety net for two cross-cutting a11y / UX
 * contracts that need to apply from the first paint:
 *
 *   - `@media (prefers-reduced-motion: reduce)` zeros out animation
 *     and transition durations globally. Per WCAG 2.3.3 (Animation
 *     from Interactions, level AAA) and the broader vestibular-
 *     disorder accommodation that the design-system mandates,
 *     animations / transitions MUST be honoured at the user's
 *     preference. Per-component CSS opts out individually, but the
 *     global override is the load-bearing default. Silent removal
 *     would mean every animation in the app suddenly fires for
 *     users who've explicitly opted out of motion — a regression
 *     that would not break any test but would harm users.
 *
 *   - `@media (prefers-color-scheme: dark)` paints body bg / text
 *     in dark mode. The `<meta name="theme-color">` tag's dark
 *     variant (`#0c0e12`, pinned by pwa-manifest.test.ts) is
 *     specifically the body background that THIS CSS paints. The
 *     two values MUST stay aligned; pinning the CSS side of the
 *     contract is the missing half of that drift guard.
 *
 * Both queries lived in app.html since the original scaffold but
 * no test pinned them.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_HTML_PATH = resolve(__dirname, '../../src/app.html');

describe('T19.1 — prefers-reduced-motion global override', () => {
  it('app.html exists', () => {
    expect(existsSync(APP_HTML_PATH)).toBe(true);
  });

  it('declares a @media (prefers-reduced-motion: reduce) query in boot CSS', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    expect(src).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
  });

  it('the reduced-motion rule zeros animation-duration globally (WCAG 2.3.3 / vestibular accommodation)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Pin the canonical near-zero value. Exactly `0` would be brittle
    // (some UAs treat 0ms as "skip animation entirely" which breaks
    // animations that fire `animationend` events the JS depends on);
    // `0.001ms` is the standard near-zero idiom that lets the event
    // fire while the user perceives no motion.
    expect(src).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
  });

  it('the reduced-motion rule zeros transition-duration globally', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    expect(src).toMatch(/transition-duration:\s*0\.001ms\s*!important/);
  });

  it('the reduced-motion rule clamps animation-iteration-count to 1 (no infinite loops)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Defense pin: a animation with `iteration-count: infinite` whose
    // duration was zeroed would spin in a tight loop. Clamping to 1
    // shuts it down after one (zero-duration) cycle.
    expect(src).toMatch(/animation-iteration-count:\s*1\s*!important/);
  });

  it('the reduced-motion rule targets all elements + pseudo-elements (* / ::before / ::after)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Defense pin against a refactor that narrows the selector to a
    // single class or element — the override is meant to be global
    // so per-component CSS that adds new animations inherits the
    // honour-the-preference behaviour without needing to opt in.
    // Match the canonical triple-selector across one or more lines
    // of whitespace.
    expect(src).toMatch(/\*\s*,\s*\*::before\s*,\s*\*::after/);
  });
});

describe('T19.1 — prefers-color-scheme: dark body painting', () => {
  it('declares a @media (prefers-color-scheme: dark) query in boot CSS', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    expect(src).toMatch(/@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)/);
  });

  it('paints body with the dark background color that matches the theme-color dark variant (#0c0e12)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // The boot CSS painted body bg in dark mode MUST match the dark
    // `theme-color` meta tag value (`#0c0e12`, pinned by
    // pwa-manifest.test.ts). A drift between the two produces a
    // visible seam at the top of the page in standalone PWA mode:
    // the OS status bar tints with the meta value while the body
    // immediately below paints a different shade.
    // Match within a few lines after the `prefers-color-scheme: dark`
    // query opener.
    const darkBlockMatch = src.match(/@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)\s*\{[\s\S]{0,400}?#0c0e12/);
    expect(darkBlockMatch).not.toBeNull();
  });

  it('does NOT use a different dark body color (drift guard against #000 / #111 / token-mismatch)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Defense pins: a refactor that changed the dark body bg to
    // something else (pure black, the design-token dark surface
    // #0f1116, a different hand-picked value) would silently break
    // the theme-color ↔ body cross-file alignment.
    const darkBlockMatch = src.match(/@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)\s*\{[\s\S]{0,400}?\}\s*\}/);
    expect(darkBlockMatch).not.toBeNull();
    const darkBlock = darkBlockMatch?.[0] ?? '';
    // Pure black would be a worst-case glare drift; the design-token
    // value would silently violate the theme-color contract until
    // someone notices the seam.
    expect(darkBlock).not.toMatch(/background:\s*#000\b/);
    expect(darkBlock).not.toMatch(/background:\s*#0f1116\b/);
  });
});
