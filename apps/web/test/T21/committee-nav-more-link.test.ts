/**
 * ADR-0029 P1-8b — /committee nav wiring on the /more launcher (Surface K route
 * shell + nav; A-8.4).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. Per repo
 * convention (recent-routes-on-search-and-more.test.ts / more-route-mount.test.ts)
 * the /more +page.svelte is pinned via a source-string structural check rather
 * than rendered.
 *
 * Surface K: /committee hangs off the /more link-row's **Account** group — NOT
 * the fixed bottom tab bar. Discovery is a single `.more-link` row styled like
 * its siblings, shown to every signed-in member (a non-co-chair who taps it lands
 * on the not-a-co-chair stop). The nav entry's accessible name = its <strong>
 * label + <span> blurb (committee.nav.label + committee.nav.blurb).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasKey } from '../../src/lib/i18n';

const MORE_PAGE_PATH = resolve(__dirname, '../../src/routes/more/+page.svelte');
const BOTTOM_TAB_PATH = resolve(__dirname, '../../src/lib/ui/BottomTabBar.svelte');

function moreSrc(): string {
  return readFileSync(MORE_PAGE_PATH, 'utf8');
}

describe('P1-8b — /more exposes a /committee link-row', () => {
  it('the /more launcher links to /committee with a stable testid', () => {
    const src = moreSrc();
    expect(src).toMatch(/href=["']\/committee["']/);
    expect(src).toMatch(/data-testid=["']more-link-committee["']/);
  });

  it('the link is a `.more-link` row (styled like its siblings — <strong> label + <span> blurb)', () => {
    const src = moreSrc();
    // The committee link row uses the shared .more-link chrome + a label/blurb
    // pair, so its accessible name is label + blurb (anti-pattern #2: never
    // icon-only for a navigational control).
    const rowMatch = src.match(
      /<a[^>]*href=["']\/committee["'][^>]*class=["'][^"']*more-link[^"']*["'][\s\S]*?<\/a>/
    );
    expect(rowMatch, 'a `.more-link` anchor to /committee with label+blurb').not.toBeNull();
    const row = rowMatch![0];
    expect(row).toMatch(/<strong>[\s\S]*committee\.nav\.label[\s\S]*<\/strong>/);
    expect(row).toMatch(/<span>[\s\S]*committee\.nav\.blurb[\s\S]*<\/span>/);
  });

  it('the accessible-name copy keys (committee.nav.label / committee.nav.blurb) resolve in the catalog', () => {
    expect(hasKey('committee.nav.label')).toBe(true);
    expect(hasKey('committee.nav.blurb')).toBe(true);
  });

  it('the /committee row lives in the Account group (not a new tab, not the intake group)', () => {
    const src = moreSrc();
    // Everything from the Account group heading onward — the committee link
    // must appear inside it.
    const fromAccount = src.slice(src.indexOf('data-testid="more-group-account"'));
    expect(fromAccount).toMatch(/data-testid=["']more-link-committee["']/);
  });
});

describe('P1-8b — /committee is NOT added to the fixed bottom tab bar (A-8.4)', () => {
  it('BottomTabBar.svelte does not reference /committee (nav hangs off /more only)', () => {
    const src = readFileSync(BOTTOM_TAB_PATH, 'utf8');
    expect(src).not.toMatch(/\/committee/);
  });
});
