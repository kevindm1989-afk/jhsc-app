/**
 * T19.1 — svelte.config.js CSP directives pin.
 *
 * The CSP block in svelte.config.js is the single source of truth for
 * the Content-Security-Policy meta tag SvelteKit injects into every
 * prerendered page. Per ADR-0010 / JHSC-APP-PLAN.md §7 the policy is
 * "locked down — no inline script, no third-party JS at runtime."
 *
 * The actual security value lives in what's NOT in each directive:
 * `script-src` without `'unsafe-eval'` / `'unsafe-inline'`,
 * `frame-ancestors 'none'` (clickjacking prevention), `base-uri 'self'`
 * (prevents `<base href>` injection redirecting relative URLs). No
 * existing test catches the case where a future refactor weakens any
 * of these directives — for example, adding `'unsafe-eval'` to ship a
 * dependency that needs `new Function(...)` would silently disable
 * the eval-protection contract that ADR-0010 mandates.
 *
 * The test reads svelte.config.js as text and pins both:
 *   - Required directive shapes (presence + correct value).
 *   - Forbidden values inside specific directives (defense pins
 *     against the most common CSP-weakening drift patterns).
 *
 * Reading the config as text — rather than dynamically importing it
 * — keeps the test fast, avoids the ESM/CJS interop quirks of
 * importing a SvelteKit config from vitest, and lets each pin's
 * regex live alongside the rationale comment that explains why
 * that specific value matters.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG_PATH = resolve(__dirname, '../../svelte.config.js');

describe('T19.1 — svelte.config.js exists + declares a CSP block', () => {
  it('svelte.config.js exists at the expected path', () => {
    expect(existsSync(CONFIG_PATH)).toBe(true);
  });

  it('declares a `csp:` block under `kit:`', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/\bcsp:\s*\{/);
  });

  it('declares `mode: \'auto\'` (SvelteKit picks meta vs header per route — meta for prerendered)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/\bmode:\s*['"]auto['"]/);
  });
});

describe('T19.1 — CSP directives: required shapes (presence + value)', () => {
  const src = readFileSync(CONFIG_PATH, 'utf8');

  it('default-src is set to [\'self\']', () => {
    expect(src).toMatch(/['"]default-src['"]\s*:\s*\[\s*['"]self['"]\s*\]/);
  });

  it('connect-src includes \'self\' AND https://*.supabase.co (G-T19-15 close)', () => {
    // Per the G-T19-15 resolution: the prerendered <meta CSP> must
    // allow Edge Function fetches to *.supabase.co — the standard
    // Supabase deploy origin. Without the wildcard the auth ceremony,
    // panic-wipe audit emitter, and every other Edge Function
    // consumer would be blocked at runtime. 'self' stays for same-
    // origin assets + future custom-domain Supabase deploys.
    expect(src).toMatch(
      /['"]connect-src['"]\s*:\s*\[\s*['"]self['"]\s*,\s*['"]https:\/\/\*\.supabase\.co['"]\s*\]/
    );
  });

  it('script-src is set to [\'self\'] (no third-party JS at runtime per ADR-0010)', () => {
    // ADR-0010 / JHSC-APP-PLAN.md §7 forbids third-party JS. SvelteKit
    // augments this at build time with a sha256-hash entry for its
    // single inline hydration script, but the SOURCE config must
    // declare `'self'` only — the hash gets added by the auto-CSP
    // pass at prerender, not by the source author.
    expect(src).toMatch(/['"]script-src['"]\s*:\s*\[\s*['"]self['"]\s*\]/);
  });

  it('frame-ancestors is set to [\'none\'] (clickjacking prevention)', () => {
    // `frame-ancestors 'none'` is the canonical clickjacking prevention
    // (supersedes the older X-Frame-Options: DENY header). Without this,
    // a hostile page could iframe the app and UI-redress the worker into
    // clicking on the panic-wipe button while thinking they're
    // interacting with a different surface.
    expect(src).toMatch(/['"]frame-ancestors['"]\s*:\s*\[\s*['"]none['"]\s*\]/);
  });

  it('base-uri is set to [\'self\'] (prevents <base href> injection)', () => {
    // Without `base-uri 'self'`, a successful XSS that injects
    // `<base href="https://evil/">` redirects every subsequent relative
    // URL in the document — including the Edge Function fetches in the
    // app shell — to the attacker's origin.
    expect(src).toMatch(/['"]base-uri['"]\s*:\s*\[\s*['"]self['"]\s*\]/);
  });

  it('form-action is set to [\'self\'] (prevents off-origin form submission)', () => {
    expect(src).toMatch(/['"]form-action['"]\s*:\s*\[\s*['"]self['"]\s*\]/);
  });

  it('font-src is set to [\'self\'] (no Google/Adobe Fonts — system stack only per app.html boot CSS)', () => {
    expect(src).toMatch(/['"]font-src['"]\s*:\s*\[\s*['"]self['"]\s*\]/);
  });

  it('img-src includes data: + blob: for icon SVG + recovery-blob downloads', () => {
    // The SVG icon (PR #81) is referenced via /icon.svg (self), but
    // generated thumbnails / recovery-blob downloads cross
    // data:/blob: protocols. The img-src directive must allow both
    // while still anchoring on self.
    expect(src).toMatch(/['"]img-src['"]\s*:\s*\[\s*['"]self['"]\s*,\s*['"]data:['"]\s*,\s*['"]blob:['"]\s*\]/);
  });
});

describe('T19.1 — CSP directives: forbidden values (defense pins)', () => {
  const src = readFileSync(CONFIG_PATH, 'utf8');

  // Extract the directives object so each pin can scan only that
  // block, not the whole file (a comment in the file mentioning
  // 'unsafe-eval' shouldn't false-positive).
  const directivesMatch = src.match(/directives:\s*\{([\s\S]*?)\}\s*\}/);
  const directivesBlock = directivesMatch?.[1] ?? '';

  it('the directives block was extracted (sanity check for the regex above)', () => {
    expect(directivesBlock.length).toBeGreaterThan(0);
  });

  it('script-src does NOT contain \'unsafe-eval\' (would enable eval / new Function)', () => {
    // `unsafe-eval` would re-enable `eval()` and `new Function(...)`,
    // which the threat model explicitly forbids. A dependency that
    // needs eval should be REMOVED, not whitelisted.
    expect(directivesBlock).not.toMatch(/['"]script-src['"][^,\]]*['"]unsafe-eval['"]/);
  });

  it('script-src does NOT contain \'unsafe-inline\' (would defeat XSS protection)', () => {
    // `unsafe-inline` in script-src allows inline <script>...</script>
    // blocks, which defeats the primary XSS-via-script defense. The
    // SvelteKit auto-CSP path uses a sha256 hash for its single inline
    // hydration script instead — the source config must NOT name
    // unsafe-inline.
    expect(directivesBlock).not.toMatch(/['"]script-src['"][^,\]]*['"]unsafe-inline['"]/);
  });

  it('default-src does NOT contain \'*\' wildcard (would render the CSP toothless)', () => {
    expect(directivesBlock).not.toMatch(/['"]default-src['"][^,\]]*['"]\*['"]/);
  });

  it('frame-ancestors does NOT contain \'self\' or \'*\' (defense against drift from \'none\')', () => {
    // A refactor that flips `frame-ancestors` from `'none'` to `'self'`
    // would allow same-origin iframing — needed only if the app ever
    // iframes itself (it doesn't). The conservative posture is `'none'`.
    expect(directivesBlock).not.toMatch(/['"]frame-ancestors['"]\s*:\s*\[\s*['"]self['"]\s*\]/);
    expect(directivesBlock).not.toMatch(/['"]frame-ancestors['"]\s*:\s*\[\s*['"]\*['"]\s*\]/);
  });
});
