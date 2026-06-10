/**
 * T19.1 — /training route mount.
 *
 * Replaces the PR #139 coming-soon placeholder pins with structural
 * pins for the real TrainingViewer mount + demo provider.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/training/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/training/+page.ts');

describe('T19.1 — /training route mount (real viewer + demo provider)', () => {
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

  it('the page carries the training-page data-testid', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']training-page["']/);
  });

  it('mounts <TrainingViewer> with a fetchPage prop wired through', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s+TrainingViewer\s+from\s+['"]\$lib\/training\/TrainingViewer\.svelte['"]/
    );
    expect(src).toMatch(/<TrainingViewer\s+\{fetchPage\}/);
  });

  it('imports the demo provider (buildDemoTraining + fetchDemoTrainingPage)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*\{[\s\S]*buildDemoTraining[\s\S]*fetchDemoTrainingPage[\s\S]*\}\s+from\s+['"]\$lib\/training\/demo-training['"]/
    );
  });

  it('renders the demo-note callout', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']trn-demo-note["']/);
    expect(src).toMatch(/t\(['"]training\.viewer\.demo_note['"]\)/);
  });

  it('renders a back-to-home link', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']training-back-to-home["']/);
  });

  it('carries a noindex meta', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });
});
