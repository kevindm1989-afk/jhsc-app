/**
 * T19.1 — app.html boot-time meta tag pins (charset, viewport,
 * color-scheme).
 *
 * Three head-level declarations that establish baseline rendering
 * before any application code runs. None of them were pinned by
 * existing tests before this file:
 *
 *   - `<meta charset="utf-8">` — encoding declaration. HTML5 requires
 *     this to be in the first 1024 bytes of the document; removing it
 *     or swapping the value silently corrupts non-ASCII catalog strings
 *     (the i18n catalog uses curly quotes, em-dashes, and the ellipsis
 *     character that would garble under any other encoding).
 *
 *   - `<meta name="viewport" content="width=device-width, initial-scale=1">` —
 *     mobile viewport sizing. Without it, mobile UAs render the page at
 *     a 980-pixel virtual viewport scaled to fit, which makes the form
 *     controls of the worker intake surfaces too small to use. The
 *     content value MUST allow user scaling: `user-scalable=no` and
 *     `maximum-scale=1` would lock the page at the initial zoom, which
 *     violates WCAG 1.4.4 (Resize text — users with low vision must be
 *     able to zoom to 200%).
 *
 *   - `<meta name="color-scheme" content="light dark">` — declares
 *     support for both color schemes so UA-rendered form controls
 *     (checkboxes, date pickers, file inputs) and scrollbars adopt the
 *     palette that matches the user's `prefers-color-scheme`. Without
 *     this, those controls render in the UA default (typically light)
 *     even when the page body paints dark — producing a jarring
 *     contrast band around every native form widget.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_HTML_PATH = resolve(__dirname, '../../src/app.html');

describe('T19.1 — <meta charset="utf-8"> (encoding declaration)', () => {
  it('app.html exists', () => {
    expect(existsSync(APP_HTML_PATH)).toBe(true);
  });

  it('declares <meta charset="utf-8"> (HTML5 encoding contract)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    expect(src).toMatch(/<meta\s+charset=["']utf-8["']\s*\/?>/i);
  });

  it('the charset declaration sits early in <head> (HTML5 spec: within the first 1024 bytes)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    const charsetAt = src.search(/<meta\s+charset=/i);
    expect(charsetAt).toBeGreaterThan(-1);
    // The 1024-byte limit is the HTML5 spec floor; in practice this
    // tag is the FIRST element in <head>. A refactor that moved it
    // later (e.g., after a chunk of imports/scripts) would violate
    // the spec and risk encoding-detection drift.
    expect(charsetAt).toBeLessThan(1024);
  });

  it('does NOT declare a non-utf-8 charset (regression guard)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // The catalog uses curly quotes, em-dashes, and ellipsis chars
    // that would garble under iso-8859-1 / windows-1252. Pin against
    // the two most likely drift values.
    expect(src).not.toMatch(/<meta\s+charset=["']iso-8859-1["']/i);
    expect(src).not.toMatch(/<meta\s+charset=["']windows-1252["']/i);
  });
});

describe('T19.1 — <meta name="viewport"> (mobile sizing + zoom)', () => {
  it('declares <meta name="viewport"> with width=device-width + initial-scale=1', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Match the canonical value; allow whitespace variation in the
    // content attr.
    expect(src).toMatch(
      /<meta\s+name=["']viewport["']\s+content=["']width=device-width,\s*initial-scale=1["']\s*\/?>/
    );
  });

  it('does NOT lock zoom via user-scalable=no (WCAG 1.4.4 Resize text)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Defense pin: `user-scalable=no` (or its synonym `0`) locks the
    // page at the initial zoom, which prevents low-vision users from
    // zooming to 200%. WCAG 1.4.4 requires resize support. This pin
    // catches the most common anti-a11y viewport refactor.
    expect(src).not.toMatch(/user-scalable=(?:no|0)/);
  });

  it('does NOT lock zoom via maximum-scale=1 (WCAG 1.4.4 Resize text)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Defense pin: `maximum-scale=1` is the other common zoom lock.
    // Same WCAG 1.4.4 concern.
    expect(src).not.toMatch(/maximum-scale=1\b/);
  });
});

describe('T19.1 — <meta name="color-scheme"> (UA-rendered widget palette)', () => {
  it('declares <meta name="color-scheme" content="light dark">', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    expect(src).toMatch(
      /<meta\s+name=["']color-scheme["']\s+content=["']light dark["']\s*\/?>/
    );
  });

  it('does NOT lock the scheme to a single mode (regression guard)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Defense pin: `content="light"` or `content="dark"` alone would
    // force every UA-rendered widget into one palette even when the
    // user prefers the other, producing high-contrast bands around
    // native controls. The boot stylesheet in app.html paints body
    // bg via `prefers-color-scheme` query — the color-scheme meta
    // must list both modes for the widgets to follow suit.
    expect(src).not.toMatch(/<meta\s+name=["']color-scheme["']\s+content=["']light["']\s*\/?>/);
    expect(src).not.toMatch(/<meta\s+name=["']color-scheme["']\s+content=["']dark["']\s*\/?>/);
  });
});
