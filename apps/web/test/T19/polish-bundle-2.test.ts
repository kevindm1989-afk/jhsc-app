/**
 * T19.1 — Polish bundle 2: print-friendly chrome + filter-aware titles.
 *
 *   - Shared chrome components (FilterChipsRail, FilterBanner) carry
 *     `data-print="hide"` so a print of any register surface yields a
 *     clean list, no chrome.
 *   - Each register viewer's pagination controls carry
 *     `data-print="hide"`.
 *   - Each register route's back-to-home footer carries
 *     `data-print="hide"`.
 *   - Each register route computes a `pageTitle` reactive that feeds
 *     into `<svelte:head><title>` so the browser tab + window title
 *     reflect the active filter when one is set.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

const ROUTES: ReadonlyArray<readonly [string, string]> = [
  // ['concerns', 'con'] RETIRED — ADR-0027 Phase 2a PR2: live /concerns no
  // longer composes a reactive pageTitle from a filter-axis chip rail.
  ['recommendations', 'recs'],
  ['training', 'trn'],
  ['work-refusal', 'wr'],
  ['s51-evidence', 's51'],
  ['reprisal', 'rep'],
  ['minutes', 'min'],
  ['inspections', 'ins'],
  ['library', 'lib'],
  ['audit', 'audit-page'],
  ['sensitive-feed', 'sensitive-feed']
];

const VIEWERS: ReadonlyArray<readonly [string, string, string]> = [
  ['concerns', 'ConcernsViewer', 'con-controls'],
  ['recommendations', 'RecommendationsViewer', 'recs-controls'],
  ['training', 'TrainingViewer', 'trn-controls'],
  ['work-refusal', 'WorkRefusalViewer', 'wr-controls'],
  ['s51-evidence', 'S51EvidenceViewer', 's51-controls'],
  ['reprisal', 'ReprisalViewer', 'rep-controls'],
  ['minutes', 'MinutesViewer', 'min-controls'],
  ['inspections', 'InspectionsViewer', 'ins-controls'],
  ['library', 'LibraryViewer', 'lib-controls'],
  ['audit', 'AuditLogViewer', 'audit-viewer-controls'],
  ['audit', 'SensitiveFeedViewer', 'sensitive-feed-controls']
];

describe('T19.1 — shared chrome carries data-print="hide"', () => {
  it('FilterChipsRail nav has data-print="hide"', () => {
    const src = read('src/lib/ui/FilterChipsRail.svelte');
    expect(src).toMatch(/<nav[\s\S]*?data-print="hide"[\s\S]*?>/);
  });
  it('FilterBanner aside has data-print="hide"', () => {
    const src = read('src/lib/ui/FilterBanner.svelte');
    expect(src).toMatch(/<aside[\s\S]*?data-print="hide"[\s\S]*?>/);
  });
});

describe('T19.1 — every register viewer pagination controls carry data-print="hide"', () => {
  for (const [dir, viewer, testid] of VIEWERS) {
    it(`${viewer} (.../${dir}/${viewer}.svelte ${testid})`, () => {
      const src = read(`src/lib/${dir}/${viewer}.svelte`);
      const re = new RegExp(`data-testid="${testid}"[^>]*data-print="hide"`);
      expect(src).toMatch(re);
    });
  }
});

describe('T19.1 — every register route footer carries data-print="hide"', () => {
  for (const [route] of ROUTES) {
    it(`/${route}/+page.svelte has a data-print="hide" footer`, () => {
      const src = read(`src/routes/${route}/+page.svelte`);
      // Match a <p ...> that contains data-print="hide" and a back-to-home anchor.
      expect(src).toMatch(/<p[^>]*data-print="hide"[\s\S]*?back-to-home/);
    });
  }
});

describe('T19.1 — every register route computes pageTitle and uses it in <title>', () => {
  for (const [route] of ROUTES) {
    it(`/${route}/+page.svelte computes and uses pageTitle`, () => {
      const src = read(`src/routes/${route}/+page.svelte`);
      expect(src).toMatch(/\$:\s*pageTitle\s*=/);
      expect(src).toMatch(
        /<title>\{pageTitle\}\s*—\s*\{t\(['"]common\.app_name['"]\)\}<\/title>/
      );
    });
  }
});
