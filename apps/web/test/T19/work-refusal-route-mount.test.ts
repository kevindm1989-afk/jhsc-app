/**
 * T19.1 — /work-refusal route mount.
 *
 * Replaces the PR #139 coming-soon placeholder pins with structural
 * pins for the real WorkRefusalViewer mount + demo provider. The
 * card carries the C4 destructive-red inline-start border shared
 * with /reprisal and /s51-evidence.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/work-refusal/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/work-refusal/+page.ts');

describe('T19.1 — /work-refusal route mount (real viewer + demo provider)', () => {
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

  it('the page carries the work-refusal-page data-testid', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']work-refusal-page["']/);
  });

  it('mounts <WorkRefusalViewer> with a fetchPage prop wired through', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s+WorkRefusalViewer\s+from\s+['"]\$lib\/work-refusal\/WorkRefusalViewer\.svelte['"]/
    );
    expect(src).toMatch(/<WorkRefusalViewer\s+\{fetchPage\}/);
  });

  it('imports the demo provider (buildDemoWorkRefusals + fetchDemoWorkRefusalPage)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*\{[\s\S]*buildDemoWorkRefusals[\s\S]*fetchDemoWorkRefusalPage[\s\S]*\}\s+from\s+['"]\$lib\/work-refusal\/demo-work-refusal['"]/
    );
  });

  it('renders the demo-note callout', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']wr-demo-note["']/);
    expect(src).toMatch(/t\(['"]workRefusal\.viewer\.demo_note['"]\)/);
  });

  it('renders a back-to-home link', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']work-refusal-back-to-home["']/);
  });

  it('carries a noindex meta', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('carries the destructive-red inline-start border on the card (C4 accent)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/border-inline-start:\s*4px\s+solid\s+var\(--color-destructive\)/);
  });
});
