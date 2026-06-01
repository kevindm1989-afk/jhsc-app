/**
 * T19.1 — app.html `<noscript>` JS-required fallback.
 *
 * The app uses adapter-static with ssr=false. JS-disabled browsers
 * receive a blank shell at /, /sign-in, /settings, /onboarding —
 * no explanation, no actionable path. The `<noscript>` block tells
 * the user JS is required.
 *
 * Pins:
 *   - The block exists inside <body>.
 *   - It contains a heading + actionable body text.
 *   - The block is unconditional (no media query / JS-detection
 *     gating that would break the "JS disabled" branch).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_HTML_PATH = resolve(__dirname, '../../src/app.html');

describe('T19.1 — app.html JS-required <noscript> fallback', () => {
  it('app.html exists at the expected path', () => {
    expect(existsSync(APP_HTML_PATH)).toBe(true);
  });

  it('contains a <noscript> block inside <body>', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    expect(src).toMatch(/<noscript>[\s\S]*?<\/noscript>/);
    // The block must sit INSIDE <body> (not <head> — noscript in
    // <head> is also legal but our shell renders user-visible UI
    // and needs a layout container, so <body> is correct here).
    const bodyOpen = src.indexOf('<body');
    const bodyClose = src.indexOf('</body>');
    const noscriptAt = src.indexOf('<noscript>');
    expect(bodyOpen).toBeGreaterThan(-1);
    expect(bodyClose).toBeGreaterThan(-1);
    expect(noscriptAt).toBeGreaterThan(bodyOpen);
    expect(noscriptAt).toBeLessThan(bodyClose);
  });

  it('the <noscript> block contains a heading + actionable body text', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    const noscriptMatch = src.match(/<noscript>([\s\S]*?)<\/noscript>/);
    expect(noscriptMatch).not.toBeNull();
    const inner = noscriptMatch?.[1] ?? '';
    // A heading so screen-readers parsing the noscript shell get a
    // landmark to anchor on.
    expect(inner).toMatch(/<h1>[\s\S]*?<\/h1>/);
    // Actionable instructions — not just "this app needs JS" but
    // tells the user what to do.
    expect(inner).toMatch(/enable javascript/i);
    expect(inner).toMatch(/reload/i);
  });

  it('the <noscript> block is unconditional (no JS-detection gating)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Defense against a refactor that hides the noscript via a
    // <style media="…"> rule or a CSS class that only fires when JS
    // can compute it (defeating the whole point of noscript).
    expect(src).not.toMatch(/<noscript[^>]+style[^>]*display\s*:\s*none/);
    expect(src).not.toMatch(/<noscript[^>]+hidden/);
  });
});
