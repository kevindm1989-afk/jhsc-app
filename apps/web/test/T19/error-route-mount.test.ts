/**
 * T19.1 — customized SvelteKit error page mount.
 *
 * Pins the structural contract for the +error.svelte component:
 *   - The component exists at apps/web/src/routes/+error.svelte.
 *   - It branches on `$page.status === 404` vs the generic case so
 *     404s get their own friendlier copy.
 *   - All visible text resolves via t() per ADR-0009.
 *   - It does NOT render `$page.error.message` (which can leak PI
 *     per ADR-0010 / threat-model §3.1 — the structured logger +
 *     Sentry are the canonical error reporting channel; the user
 *     just sees the status code + friendly copy).
 *   - A back-to-home link gives the user a path out.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/+error.svelte');

describe('T19.1 — +error.svelte customized error page', () => {
  it('the +error.svelte component exists at the expected path', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('imports the $page store from $app/stores (SvelteKit page-level error context)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/import\s*{[^}]*page[^}]*}\s+from\s+['"]\$app\/stores['"]/);
  });

  it('branches on status === 404 for a friendlier 404-specific copy', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Defense-in-depth: a generic "Something went wrong" headline
    // for a 404 looks like a bug — the route exists but it broke.
    // 404s should say "Page not found" so the user knows the issue
    // is the URL, not the app.
    expect(src).toMatch(/status\s*===\s*404/);
    expect(src).toMatch(/t\(['"]common\.errorPage\.heading_404['"]\)/);
    expect(src).toMatch(/t\(['"]common\.errorPage\.heading_other['"]\)/);
  });

  it('renders the status code so the user can quote it to support', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']error-status["']/);
    expect(src).toMatch(/t\(['"]common\.errorPage\.status_label['"]\)/);
  });

  it('does NOT render $page.error.message (PI-leak risk per ADR-0010 / threat-model §3.1)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // The error message can carry raw user IDs, ciphertext column
    // names, etc. Showing it to the user violates the SDK-layer PI
    // scrubbing contract. Search ONLY the template portion (after
    // </script>) so the same string appearing in a source comment
    // explaining why it's forbidden doesn't false-positive.
    const scriptCloseAt = src.lastIndexOf('</script>');
    const template = scriptCloseAt >= 0 ? src.slice(scriptCloseAt) : src;
    expect(template).not.toMatch(/\$page\.error\.message/);
    expect(template).not.toMatch(/page\.error\.message/);
    // Also: defensively, ensure the source never renders
    // `error.message` from any object (could come via destructuring).
    expect(template).not.toMatch(/\berror\.message\b/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']error-back-to-home["']/);
    expect(src).toMatch(/t\(['"]common\.errorPage\.back_to_home_cta['"]\)/);
  });

  it('every common.errorPage.* key referenced is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.common.errorPage).toBeDefined();
    expect(typeof catalog.common.errorPage.title).toBe('string');
    expect(typeof catalog.common.errorPage.heading_404).toBe('string');
    expect(typeof catalog.common.errorPage.heading_other).toBe('string');
    expect(typeof catalog.common.errorPage.body_404).toBe('string');
    expect(typeof catalog.common.errorPage.body_other).toBe('string');
    expect(typeof catalog.common.errorPage.status_label).toBe('string');
    expect(typeof catalog.common.errorPage.back_to_home_cta).toBe('string');
  });

  it('the page carries a noindex meta tag (error pages should not be indexed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });
});
