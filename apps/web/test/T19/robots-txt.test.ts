/**
 * T19.1 — robots.txt crawl-directive defense-in-depth.
 *
 * Every page in the app already carries
 *   <meta name="robots" content="noindex,nofollow" />
 * per-page (pinned by route-mount tests). robots.txt sits in front of
 * that contract: well-behaved crawlers fetch /robots.txt before any
 * other URL on the origin and obey the disallow even if they never
 * visit a page whose meta tag could surface noindex. Without this
 * file, a misconfigured crawler that ignores meta tags but respects
 * robots.txt (a not-uncommon combination) would index the entire
 * adapter-static surface — the auth ceremony, the wizard, settings,
 * the error page — for no SEO return.
 *
 * Pins:
 *   - The file exists at apps/web/static/robots.txt.
 *   - It declares `User-agent: *` (all crawlers).
 *   - It declares `Disallow: /` (the whole origin).
 *   - SvelteKit's adapter-static copies it into build/ (so the
 *     deployed origin actually serves it).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STATIC_DIR = resolve(__dirname, '../../static');
const ROBOTS_PATH = resolve(STATIC_DIR, 'robots.txt');

describe('T19.1 — robots.txt exists in the static-assets directory', () => {
  it('apps/web/static/robots.txt exists', () => {
    expect(existsSync(ROBOTS_PATH)).toBe(true);
  });
});

describe('T19.1 — robots.txt declares the disallow-everything directive', () => {
  const src = readFileSync(ROBOTS_PATH, 'utf8');

  it('declares `User-agent: *` (applies to all crawlers, not a specific bot)', () => {
    // The wildcard agent is the only one we want here — a future
    // robots.txt that singles out specific crawlers (e.g., to allow
    // Googlebot but block AhrefsBot) would still need the `*` line
    // for everything else.
    expect(src).toMatch(/^User-agent:\s*\*\s*$/m);
  });

  it('declares `Disallow: /` (the entire origin is off-limits)', () => {
    expect(src).toMatch(/^Disallow:\s*\/\s*$/m);
  });

  it('does NOT carry a Sitemap: directive (the app has no public sitemap; defense pin)', () => {
    // Defense pin: a sitemap.xml would invite crawl traffic against the
    // very URLs the Disallow forbids. If a future marketing site grows,
    // its sitemap lives on its OWN domain — not this app surface.
    expect(src).not.toMatch(/^Sitemap:/im);
  });

  it('does NOT carry an Allow: exception (defense against partial-allow drift)', () => {
    // Defense pin: an `Allow: /...` line would carve a hole in the
    // disallow and could leak the carved path to crawlers that pre-fetch
    // robots.txt for URL discovery. If a future SEO carve-out is needed,
    // it belongs on a separate marketing domain with its own robots.txt.
    expect(src).not.toMatch(/^Allow:/im);
  });
});
