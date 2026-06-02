/**
 * T19.1 — `<meta name="referrer" content="no-referrer">` pin.
 *
 * The referrer meta tag in app.html is privacy-critical: when a user
 * clicks any external link (or when the browser issues a sub-request to
 * a different origin — e.g., a redirect, a fetch to Supabase Edge
 * Functions, an image href that resolves to an off-origin URL), the
 * default behaviour is to send the previous page URL as the `Referer`
 * header. For JHSC that header could carry:
 *
 *   - The route path itself (`/onboarding`, `/settings`, `/sign-in`) —
 *     non-PI but reveals the user's app stance.
 *   - Future deep-link query strings (e.g., `/concerns/:id` once that
 *     surface exists) — those IDs are pseudonyms in audit but the URL
 *     containing them shouldn't be ambient-leakable.
 *   - Any anchor fragment the user happened to navigate to (e.g.,
 *     `#section-3` of a long-form recovery primer) — fingerprints the
 *     reader's progress.
 *
 * Setting the policy to `no-referrer` strips the `Referer` header
 * entirely on every outgoing request — both navigations and fetches.
 * Sticter than `strict-origin-when-cross-origin` (which still sends
 * the origin); the right posture for a worker-side intake app where
 * any leak to off-origin services is unwanted.
 *
 * Pins:
 *   - The tag exists at the document head.
 *   - The policy is exactly `no-referrer` (not the laxer alternatives).
 *   - Regression guard: laxer policies (`origin`, `unsafe-url`, etc.)
 *     are NOT present.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_HTML_PATH = resolve(__dirname, '../../src/app.html');

describe('T19.1 — referrer-policy meta tag (no-referrer)', () => {
  it('app.html exists', () => {
    expect(existsSync(APP_HTML_PATH)).toBe(true);
  });

  it('declares <meta name="referrer" content="no-referrer">', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    expect(src).toMatch(
      /<meta\s+name=["']referrer["']\s+content=["']no-referrer["']\s*\/?>/
    );
  });

  it('does NOT declare a laxer referrer policy (regression guard)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    // Defense pins for the four most-likely drift values. A future
    // refactor that swaps `no-referrer` for `origin` or `strict-origin-
    // when-cross-origin` would silently re-enable Referer leakage to
    // cross-origin destinations (including the Supabase Edge Function
    // origin and any future analytics destination).
    expect(src).not.toMatch(
      /<meta\s+name=["']referrer["']\s+content=["']origin["']\s*\/?>/
    );
    expect(src).not.toMatch(
      /<meta\s+name=["']referrer["']\s+content=["']origin-when-cross-origin["']\s*\/?>/
    );
    expect(src).not.toMatch(
      /<meta\s+name=["']referrer["']\s+content=["']strict-origin-when-cross-origin["']\s*\/?>/
    );
    expect(src).not.toMatch(
      /<meta\s+name=["']referrer["']\s+content=["']unsafe-url["']\s*\/?>/
    );
  });

  it('the referrer meta tag is in the document <head> (where it must live)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    const headEndAt = src.indexOf('</head>');
    const referrerAt = src.search(/<meta\s+name=["']referrer["']/);
    expect(headEndAt).toBeGreaterThan(-1);
    expect(referrerAt).toBeGreaterThan(-1);
    // Defense pin: a refactor that moved the tag into <body> would
    // make it inert (UAs only consult head-scoped referrer meta).
    expect(referrerAt).toBeLessThan(headEndAt);
  });
});
