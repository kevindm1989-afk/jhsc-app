/**
 * T19.1 — /concerns route mount.
 *
 * Replaces the PR #136 coming-soon placeholder pins with structural
 * pins for the real ConcernsViewer mount + demo provider.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/concerns/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/concerns/+page.ts');

describe('T19.1 — /concerns route mount (real viewer + demo provider)', () => {
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

  it('the page carries the concerns-page data-testid', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']concerns-page["']/);
  });

  it('mounts <ConcernsViewer> with a fetchPage prop wired through', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s+ConcernsViewer\s+from\s+['"]\$lib\/concerns\/ConcernsViewer\.svelte['"]/
    );
    expect(src).toMatch(/<ConcernsViewer\s+\{fetchPage\}/);
  });

  it('imports the demo provider (buildDemoConcerns + fetchDemoConcernsPage)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*\{[\s\S]*buildDemoConcerns[\s\S]*fetchDemoConcernsPage[\s\S]*\}\s+from\s+['"]\$lib\/concerns\/demo-concerns['"]/
    );
  });

  it('renders the demo-note callout', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']con-demo-note["']/);
    expect(src).toMatch(/t\(['"]concern\.viewer\.demo_note['"]\)/);
  });

  it('renders a back-to-home link', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']concerns-back-to-home["']/);
  });

  it('carries a noindex meta', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });
});
