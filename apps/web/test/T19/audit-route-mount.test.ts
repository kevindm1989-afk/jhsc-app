/**
 * T19.1 — /audit route mount.
 *
 * Replaces the original coming-soon placeholder pin set (PR #141)
 * with structural pins for the real AuditLogViewer mount. The viewer
 * surfaces demo data via the deterministic provider in
 * $lib/audit/demo-audit-rows until the real audit-op Edge Function
 * lands; the mount test pins the WIRE shape (provider injected, demo
 * note rendered, back-to-home link, noindex meta) so a future swap-in
 * is structurally constrained.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/audit/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/audit/+page.ts');

describe('T19.1 — /audit route mount (real viewer + demo provider)', () => {
  it('the +page.svelte component exists at the expected path', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('the +page.ts loader exists alongside the component', () => {
    expect(existsSync(PAGE_TS_PATH)).toBe(true);
  });

  it('+page.ts declares prerender = true (parity with the rest of the app shell)', () => {
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*true/);
  });

  it('+page.ts declares ssr = false (no PI on the route surface)', () => {
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });

  it('the page carries the audit-page data-testid', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']audit-page["']/);
  });

  it('mounts <AuditLogViewer> with a fetchPage prop wired through', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/import\s+AuditLogViewer\s+from\s+['"]\$lib\/audit\/AuditLogViewer\.svelte['"]/);
    expect(src).toMatch(/<AuditLogViewer\s+\{fetchPage\}/);
  });

  it('imports the demo provider (buildDemoAuditRows + fetchDemoAuditPage)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{\s*buildDemoAuditRows\s*,\s*fetchDemoAuditPage\s*}\s+from\s+['"]\$lib\/audit\/demo-audit-rows['"]/
    );
  });

  it('renders the demo-note callout (so the worker knows this is not real audit data)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']audit-page-demo-note["']/);
    expect(src).toMatch(/t\(['"]audit\.viewer\.demo_note['"]\)/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']audit-back-to-home["']/);
    expect(src).toMatch(/t\(['"]common\.auditPage\.back_to_home_cta['"]\)/);
  });

  it('carries a noindex meta', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });
});
