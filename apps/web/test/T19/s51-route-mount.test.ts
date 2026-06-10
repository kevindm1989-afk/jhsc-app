/**
 * T19.1 — /s51-evidence route mount.
 *
 * Replaces the PR #141 coming-soon placeholder pins with structural
 * pins for the real S51EvidenceViewer mount + demo provider.
 * Preserves the 4px destructive-red inline-start border the
 * placeholder card established for the C4 sensitivity tier.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/s51-evidence/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/s51-evidence/+page.ts');

describe('T19.1 — /s51-evidence route mount (real viewer + demo provider)', () => {
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

  it('the page carries the s51-page data-testid', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']s51-page["']/);
  });

  it('mounts <S51EvidenceViewer> with a fetchPage prop wired through', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s+S51EvidenceViewer\s+from\s+['"]\$lib\/s51-evidence\/S51EvidenceViewer\.svelte['"]/
    );
    expect(src).toMatch(/<S51EvidenceViewer\s+\{fetchPage\}/);
  });

  it('imports the demo provider (buildDemoS51Evidence + fetchDemoS51EvidencePage)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*\{[\s\S]*buildDemoS51Evidence[\s\S]*fetchDemoS51EvidencePage[\s\S]*\}\s+from\s+['"]\$lib\/s51-evidence\/demo-s51-evidence['"]/
    );
  });

  it('renders the demo-note callout', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']s51-demo-note["']/);
    expect(src).toMatch(/t\(['"]s51\.viewer\.demo_note['"]\)/);
  });

  it('renders a back-to-home link', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']s51-back-to-home["']/);
  });

  it('carries a noindex meta', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('preserves the destructive-red inline-start border on the card (C4 accent)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/border-inline-start:\s*4px\s+solid\s+var\(--color-destructive\)/);
  });
});
