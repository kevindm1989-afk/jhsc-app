/**
 * T19.1 — /reprisal route mount.
 *
 * ADR-0028 Phase 2b PR1 cutover: the demo-provider pins (ReprisalViewer mount,
 * buildDemoReprisals/fetchDemoReprisalPage import, demo-note callout) have been
 * RETIRED — the live /reprisal page cut over to the E2EE feed and no longer
 * mounts the demo register. The post-cutover surface (probe-first no-wrap
 * guard, live feed, "Report a reprisal" CTA, per-row read affordance) is pinned
 * by apps/web/test/T13b/phase2b-reprisal-page-cutover.test.ts. The still-valid
 * shell invariants below (route/loader existence, prerender + ssr=false, the
 * reprisal-page testid, the back-to-home link, the noindex meta, and the C4
 * destructive-red inline-start accent — now token-driven) are retained.
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

  // RETIRED (ADR-0028 Phase 2b PR1) — the demo-provider mount + demo-note pins:
  //   - 'mounts <ReprisalViewer> with a fetchPage prop wired through'
  //   - 'imports the demo provider (buildDemoReprisals + fetchDemoReprisalPage)'
  //   - 'renders the demo-note callout'
  // The live page mounts ReprisalIntakeForm behind the "Report a reprisal" CTA
  // and renders the pseudonymized live feed instead. See
  // apps/web/test/T13b/phase2b-reprisal-page-cutover.test.ts.

  it('renders a back-to-home link', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']reprisal-back-to-home["']/);
  });

  it('carries a noindex meta', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('preserves the destructive-red inline-start accent on the reprisal card (C4 accent)', () => {
    // ADR-0028 Phase 2b PR1 — the C4 accent is preserved but tokenized: the raw
    // `4px` shorthand became token-driven longhand (the C4-stripe width token +
    // the destructive colour token), keeping verify-tokens clean.
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/border-inline-start-color:\s*var\(--color-destructive\)/);
    expect(src).toMatch(/border-inline-start-width:\s*var\(--border-width-c4-stripe\)/);
  });
});
