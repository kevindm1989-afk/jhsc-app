/**
 * T19.1 — /reprisal route mount.
 *
 * Replaces the PR #136 coming-soon placeholder pins with structural
 * pins for the real ReprisalViewer mount + demo provider. Preserves
 * the 4px destructive-red inline-start border the placeholder card
 * established for the C4 sensitivity tier.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/reprisal/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/reprisal/+page.ts');

describe('T19.1 — /reprisal route mount (real viewer + demo provider)', () => {
  it('the +page.svelte component exists at the expected path', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('the +page.ts loader exists alongside the component', () => {
    expect(existsSync(PAGE_TS_PATH)).toBe(true);
  });

  it('+page.ts declares prerender = true', () => {
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*true/);
  });

  it('+page.ts declares ssr = false (no PI on the route surface)', () => {
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });

  it('the page carries the reprisal-page data-testid', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']reprisal-page["']/);
  });

  it('mounts <ReprisalViewer> with a fetchPage prop wired through', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s+ReprisalViewer\s+from\s+['"]\$lib\/reprisal\/ReprisalViewer\.svelte['"]/
    );
    expect(src).toMatch(/<ReprisalViewer\s+\{fetchPage\}/);
  });

  it('imports the demo provider (buildDemoReprisals + fetchDemoReprisalPage)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*\{[\s\S]*buildDemoReprisals[\s\S]*fetchDemoReprisalPage[\s\S]*\}\s+from\s+['"]\$lib\/reprisal\/demo-reprisal['"]/
    );
  });

  it('renders the demo-note callout', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']rep-demo-note["']/);
    expect(src).toMatch(/t\(['"]reprisal\.viewer\.demo_note['"]\)/);
  });

  it('renders a back-to-home link', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']reprisal-back-to-home["']/);
  });

  it('carries a noindex meta', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('preserves the destructive-red inline-start border on the reprisal card (C4 accent)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/border-inline-start:\s*4px\s+solid\s+var\(--color-destructive\)/);
  });
});
