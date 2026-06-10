/**
 * T19.1 — FilterChipsRail extension to /audit and /sensitive-feed.
 *
 * Pins:
 *   - Both demo providers (fetchDemoAuditPage, fetchDemoSensitivePage)
 *     accept an optional predicate that scopes `total` to the
 *     filtered count.
 *   - The route pages import + mount FilterChipsRail and declare
 *     their canonical filter-value arrays.
 *   - The viewers honour `filterActive` for the empty-state copy.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDemoAuditRows, fetchDemoAuditPage } from '../../src/lib/audit/demo-audit-rows';
import {
  buildDemoSensitiveRows,
  fetchDemoSensitivePage
} from '../../src/lib/audit/demo-sensitive-feed';

const ROUTES_DIR = resolve(__dirname, '../../src/routes');
const VIEWERS_DIR = resolve(__dirname, '../../src/lib/audit');

describe('T19.1 — fetchDemoAuditPage accepts an optional predicate', () => {
  it('omitting the predicate returns the full dataset (back-compat)', async () => {
    const all = buildDemoAuditRows(35, 9);
    const result = await fetchDemoAuditPage(0, 10, all);
    expect(result.total).toBe(35);
    expect(result.rows.length).toBe(10);
  });

  it('a session.* predicate scopes total to the matching rows', async () => {
    const all = buildDemoAuditRows(60, 1);
    const expected = all.filter((r) => r.event_type.startsWith('session.')).length;
    const result = await fetchDemoAuditPage(0, 10, all, (r) =>
      r.event_type.startsWith('session.')
    );
    expect(result.total).toBe(expected);
    for (const row of result.rows) expect(row.event_type.startsWith('session.')).toBe(true);
  });
});

describe('T19.1 — fetchDemoSensitivePage accepts an optional predicate', () => {
  it('omitting the predicate returns the full dataset (back-compat)', async () => {
    const all = buildDemoSensitiveRows(35, 9);
    const result = await fetchDemoSensitivePage(0, 10, all);
    expect(result.total).toBe(35);
    expect(result.rows.length).toBe(10);
  });

  it('a c4 predicate scopes total to the matching rows', async () => {
    const all = buildDemoSensitiveRows(60, 1);
    const expected = all.filter((r) => r.sensitivity === 'c4').length;
    const result = await fetchDemoSensitivePage(0, 10, all, (r) => r.sensitivity === 'c4');
    expect(result.total).toBe(expected);
    for (const row of result.rows) expect(row.sensitivity).toBe('c4');
  });
});

describe('T19.1 — /audit route wires the FilterChipsRail with three category chips', () => {
  const src = readFileSync(resolve(ROUTES_DIR, 'audit/+page.svelte'), 'utf8');

  it('imports + mounts FilterChipsRail', () => {
    expect(src).toMatch(
      /import\s+FilterChipsRail\s+from\s+['"]\$lib\/ui\/FilterChipsRail\.svelte['"]/
    );
    expect(src).toMatch(/<FilterChipsRail\s+\{chips\}\s+\{activeValue\}/);
  });

  it('declares the three canonical filter values', () => {
    for (const value of ['sessions', 'workplace', 'committee']) {
      expect(src).toContain(`'${value}'`);
    }
  });

  it('passes filterActive=<truthy-when-filtered> to the viewer', () => {
    // /audit now composes filterParam with the date-range params; the
    // expression includes filterParam OR fromParam OR toParam.
    expect(src).toMatch(/filterActive=\{[\s\S]*filterParam\s*!==\s*null/);
  });
});

describe('T19.1 — /sensitive-feed route wires the FilterChipsRail with c3 / c4 chips', () => {
  const src = readFileSync(resolve(ROUTES_DIR, 'sensitive-feed/+page.svelte'), 'utf8');

  it('imports + mounts FilterChipsRail', () => {
    expect(src).toMatch(
      /import\s+FilterChipsRail\s+from\s+['"]\$lib\/ui\/FilterChipsRail\.svelte['"]/
    );
    expect(src).toMatch(/<FilterChipsRail\s+\{chips\}\s+\{activeValue\}/);
  });

  it('declares the two canonical sensitivity values', () => {
    for (const value of ['c3', 'c4']) {
      expect(src).toContain(`'${value}'`);
    }
  });

  it('passes filterActive={filterParam !== null} to the viewer', () => {
    expect(src).toMatch(/filterActive=\{filterParam\s*!==\s*null\}/);
  });

  it('preserves the destructive-red inline-start border on the card', () => {
    expect(src).toMatch(/border-inline-start:\s*4px\s+solid\s+var\(--color-destructive\)/);
  });
});

describe('T19.1 — AuditLogViewer + SensitiveFeedViewer accept the filterActive prop', () => {
  it('AuditLogViewer declares export let filterActive = false', () => {
    const src = readFileSync(resolve(VIEWERS_DIR, 'AuditLogViewer.svelte'), 'utf8');
    expect(src).toMatch(/export\s+let\s+filterActive\s*=\s*false/);
    expect(src).toContain('common.filterEmptyState.no_matches');
  });

  it('SensitiveFeedViewer declares export let filterActive = false', () => {
    const src = readFileSync(resolve(VIEWERS_DIR, 'SensitiveFeedViewer.svelte'), 'utf8');
    expect(src).toMatch(/export\s+let\s+filterActive\s*=\s*false/);
    expect(src).toContain('common.filterEmptyState.no_matches');
  });
});

describe('T19.1 — audit.viewer.chip.* + sensitiveFeed.viewer.chip.* i18n keys', () => {
  const catalog = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
  );

  it('audit chip labels are in the catalog', () => {
    expect(typeof catalog.audit.viewer.chip.sessions).toBe('string');
    expect(typeof catalog.audit.viewer.chip.workplace).toBe('string');
    expect(typeof catalog.audit.viewer.chip.committee).toBe('string');
  });

  it('sensitiveFeed chip labels are in the catalog', () => {
    expect(typeof catalog.sensitiveFeed.viewer.chip.c3).toBe('string');
    expect(typeof catalog.sensitiveFeed.viewer.chip.c4).toBe('string');
  });
});
