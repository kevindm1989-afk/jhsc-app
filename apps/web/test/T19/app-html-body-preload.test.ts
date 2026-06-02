/**
 * T19.1 — `<body data-sveltekit-preload-data="hover">` pin +
 * SvelteKit template-token presence pin.
 *
 * Two related defensive pins on app.html's body region:
 *
 *   - `data-sveltekit-preload-data="hover"` controls SvelteKit's
 *     prefetch behaviour. `hover` prefetches a route's chunk + load
 *     data on link hover (desktop) / focus, which on touch devices
 *     effectively becomes "tap". `tap` would be more aggressive
 *     (prefetches on touchstart, before the user confirms the
 *     navigation); `false` disables prefetching entirely. The
 *     current `hover` value is the conservative middle ground.
 *     Drift to either alternative changes navigation latency + the
 *     load-pattern on Edge Function calls.
 *
 *   - `%sveltekit.body%` + `%sveltekit.head%` are SvelteKit's
 *     template-token placeholders. SvelteKit injects the
 *     hydration <script>, the per-route <title>, and the CSP meta
 *     tag at these positions during prerender. A refactor that
 *     accidentally drops either token would still build but ship
 *     a completely broken HTML shell (no hydration → no app, no
 *     head injection → no title / CSP). Pinning both tokens'
 *     presence catches that silently-broken refactor.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_HTML_PATH = resolve(__dirname, '../../src/app.html');

describe('T19.1 — <body data-sveltekit-preload-data="hover"> attribute', () => {
  it('app.html exists', () => {
    expect(existsSync(APP_HTML_PATH)).toBe(true);
  });

  it('declares <body data-sveltekit-preload-data="hover">', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    expect(src).toMatch(/<body\s+data-sveltekit-preload-data=["']hover["']/);
  });

  it('does NOT use "tap" (more aggressive — prefetches on touchstart before user confirms)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    expect(src).not.toMatch(/data-sveltekit-preload-data=["']tap["']/);
  });

  it('does NOT use "off" / "false" (would disable prefetching, slowing every navigation)', () => {
    const src = readFileSync(APP_HTML_PATH, 'utf8');
    expect(src).not.toMatch(/data-sveltekit-preload-data=["'](?:off|false)["']/);
  });
});

describe('T19.1 — SvelteKit template tokens (%sveltekit.head% + %sveltekit.body%)', () => {
  const src = readFileSync(APP_HTML_PATH, 'utf8');

  it('contains %sveltekit.head% in the document <head>', () => {
    // SvelteKit injects the per-route <title>, the CSP meta tag,
    // hydration script, and any svelte:head content at this token.
    // Without it the prerendered HTML ships without a CSP and without
    // the per-route title.
    const headEndAt = src.indexOf('</head>');
    const tokenAt = src.indexOf('%sveltekit.head%');
    expect(headEndAt).toBeGreaterThan(-1);
    expect(tokenAt).toBeGreaterThan(-1);
    expect(tokenAt).toBeLessThan(headEndAt);
  });

  it('contains %sveltekit.body% inside the <body>', () => {
    // SvelteKit's hydration <script> + the slot for the rendered
    // application all live at this token. Without it the page mounts
    // a blank body and no JS runs — the noscript fallback would be
    // the only visible UI.
    const bodyOpenAt = src.indexOf('<body');
    const bodyCloseAt = src.indexOf('</body>');
    const tokenAt = src.indexOf('%sveltekit.body%');
    expect(bodyOpenAt).toBeGreaterThan(-1);
    expect(bodyCloseAt).toBeGreaterThan(-1);
    expect(tokenAt).toBeGreaterThan(bodyOpenAt);
    expect(tokenAt).toBeLessThan(bodyCloseAt);
  });

  it('the %sveltekit.html% token (root-level alternative) is NOT used (we use the head+body split)', () => {
    // Defense pin: a refactor that swapped the two-token split for
    // the single-token form would silently change where SvelteKit
    // injects its <html> attributes — and the existing `lang="en-CA"`
    // declaration would lose its position. The two-token split is
    // the established pattern.
    expect(src).not.toMatch(/%sveltekit\.html%/);
  });
});
