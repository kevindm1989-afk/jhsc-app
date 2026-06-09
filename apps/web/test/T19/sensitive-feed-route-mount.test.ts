/**
 * T19.1 — /sensitive-feed route mount.
 *
 * Replaces the original coming-soon placeholder pins (PR #141) with
 * structural pins for the real SensitiveFeedViewer mount + demo
 * provider. The 4px destructive-red inline-start border on the outer
 * card is preserved verbatim from #141 so the sensitivity-tier visual
 * gravity signal doesn't regress.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/sensitive-feed/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/sensitive-feed/+page.ts');

describe('T19.1 — /sensitive-feed route mount (real viewer + demo provider)', () => {
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

  it('the page carries the sensitive-feed-page data-testid', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']sensitive-feed-page["']/);
  });

  it('mounts <SensitiveFeedViewer> with a fetchPage prop wired through', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s+SensitiveFeedViewer\s+from\s+['"]\$lib\/audit\/SensitiveFeedViewer\.svelte['"]/
    );
    expect(src).toMatch(/<SensitiveFeedViewer\s+\{fetchPage\}/);
  });

  it('imports the demo provider (buildDemoSensitiveRows + fetchDemoSensitivePage)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*\{\s*buildDemoSensitiveRows\s*,\s*fetchDemoSensitivePage\s*\}\s+from\s+['"]\$lib\/audit\/demo-sensitive-feed['"]/
    );
  });

  it('renders the demo-note callout (so the worker knows this is not real data)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']sensitive-feed-demo-note["']/);
    expect(src).toMatch(/t\(['"]sensitiveFeed\.viewer\.demo_note['"]\)/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']sensitive-feed-back-to-home["']/);
  });

  it('carries a noindex meta', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('the .sensitive-feed-card class preserves the destructive-red inline-start border (C3/C4 accent)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /\.sensitive-feed-card\s*\{[^}]*border-inline-start:\s*4px\s+solid\s+var\(--color-destructive\)/
    );
  });
});
