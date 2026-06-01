/**
 * T19.1 — app.html mobile auto-link detection disabled.
 *
 * Mobile browsers (Safari iOS particularly) auto-detect phone numbers,
 * email addresses, postal addresses, and dates in visible text and
 * convert them into tappable links (tel: / mailto: / maps: / calshow:)
 * with tooltip + share-menu integration. Worker-side concern / reprisal
 * narratives routinely include phone numbers + employer addresses that
 * the audit-trail handles correctly server-side; we don't want the
 * browser to ALSO surface them as taps in the share menu, hover
 * tooltips, or recent-history overlays — that's a forensic side-channel
 * the threat model doesn't cover.
 *
 * Pins:
 *   - The <meta name="format-detection"> tag exists with all four
 *     detectors disabled (telephone, date, address, email).
 *   - The tag sits in <head> (where meta tags must live).
 *   - Defense-in-depth: the tag is not commented out / not hidden
 *     behind a media attribute.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_HTML_PATH = resolve(__dirname, '../../src/app.html');

describe('T19.1 — app.html mobile auto-link detection disabled', () => {
  it('app.html exists at the expected path', () => {
    expect(existsSync(APP_HTML_PATH)).toBe(true);
  });

  it('contains a <meta name="format-detection"> tag with telephone=no', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Safari iOS's `telephone=yes` default is the primary leak — a
    // worker-side narrative mentioning a phone number gets auto-
    // converted to a tel: link with a long-press preview menu.
    expect(src).toMatch(
      /<meta\s+name=["']format-detection["']\s+content=["'][^"']*telephone=no/i
    );
  });

  it('the format-detection tag also disables date / address / email detectors', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Most UAs default these to no, but spelling all four out keeps
    // the contract uniform across UA versions (some Android browsers
    // add new detectors over time). Defense-in-depth: this tag is
    // the single canonical place to forbid them.
    const tagMatch = src.match(/<meta\s+name=["']format-detection["']\s+content=["']([^"']+)["']/i);
    expect(tagMatch).not.toBeNull();
    const content = tagMatch?.[1] ?? '';
    expect(content).toMatch(/telephone=no/i);
    expect(content).toMatch(/date=no/i);
    expect(content).toMatch(/address=no/i);
    expect(content).toMatch(/email=no/i);
  });

  it('the format-detection tag sits inside <head>', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    const headOpen = src.indexOf('<head>');
    const headClose = src.indexOf('</head>');
    const tagAt = src.search(/<meta\s+name=["']format-detection["']/i);
    expect(headOpen).toBeGreaterThan(-1);
    expect(headClose).toBeGreaterThan(-1);
    expect(tagAt).toBeGreaterThan(headOpen);
    expect(tagAt).toBeLessThan(headClose);
  });

  it('the format-detection tag is not commented out (defense-in-depth)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Search for the literal tag NOT inside an HTML comment.
    // Strip <!-- … --> ranges, then re-check for the tag.
    const stripped = src.replace(/<!--[\s\S]*?-->/g, '');
    expect(stripped).toMatch(/<meta\s+name=["']format-detection["']/i);
  });
});
