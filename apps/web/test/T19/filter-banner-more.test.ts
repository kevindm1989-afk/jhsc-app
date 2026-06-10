/**
 * T19.1 — Additional filter predicate paths for the remaining four
 * register surfaces (reprisal, minutes, inspections, library).
 *
 * Mirrors filter-banner.test.ts which covered the first five (concerns,
 * recommendations, training, work-refusal, s51-evidence). Each pin
 * asserts the demo provider's predicate path scopes `total` to the
 * filtered count, so a "Filtered: …" banner doesn't lie about the
 * size of the result.
 */

import { describe, expect, it } from 'vitest';
import { buildDemoReprisals, fetchDemoReprisalPage } from '../../src/lib/reprisal/demo-reprisal';
import { buildDemoMinutes, fetchDemoMinutesPage } from '../../src/lib/minutes/demo-minutes';
import {
  buildDemoInspections,
  fetchDemoInspectionsPage
} from '../../src/lib/inspections/demo-inspections';
import { buildDemoLibrary, fetchDemoLibraryPage } from '../../src/lib/library/demo-library';

describe('T19.1 — additional demo provider predicate paths', () => {
  it('fetchDemoReprisalPage with active predicate excludes resolved + archived rows', async () => {
    const all = buildDemoReprisals(80, 1);
    const expected = all.filter((r) => r.status === 'filed' || r.status === 'investigating').length;
    const result = await fetchDemoReprisalPage(
      0,
      10,
      all,
      (r) => r.status === 'filed' || r.status === 'investigating'
    );
    expect(result.total).toBe(expected);
    for (const row of result.rows) {
      expect(row.status === 'filed' || row.status === 'investigating').toBe(true);
    }
  });

  it('fetchDemoMinutesPage with draft predicate scopes total to drafts', async () => {
    const all = buildDemoMinutes(80, 1);
    const expected = all.filter((r) => r.status === 'draft').length;
    const result = await fetchDemoMinutesPage(0, 10, all, (r) => r.status === 'draft');
    expect(result.total).toBe(expected);
    for (const row of result.rows) expect(row.status).toBe('draft');
  });

  it('fetchDemoInspectionsPage with quarantined predicate scopes total to integrity-failed rows', async () => {
    const all = buildDemoInspections(120, 1);
    const expected = all.filter((r) => r.integrity_status === 'quarantined').length;
    const result = await fetchDemoInspectionsPage(
      0,
      10,
      all,
      (r) => r.integrity_status === 'quarantined'
    );
    expect(result.total).toBe(expected);
    for (const row of result.rows) expect(row.integrity_status).toBe('quarantined');
  });

  it('fetchDemoLibraryPage with offline predicate scopes total to cached docs', async () => {
    const all = buildDemoLibrary(80, 1);
    const expected = all.filter((r) => r.offline_cached).length;
    const result = await fetchDemoLibraryPage(0, 10, all, (r) => r.offline_cached);
    expect(result.total).toBe(expected);
    for (const row of result.rows) expect(row.offline_cached).toBe(true);
  });

  it('omitting the predicate on each provider returns the full dataset (back-compat)', async () => {
    const reprisals = await fetchDemoReprisalPage(0, 10, buildDemoReprisals(35, 2));
    expect(reprisals.total).toBe(35);
    const minutes = await fetchDemoMinutesPage(0, 10, buildDemoMinutes(35, 2));
    expect(minutes.total).toBe(35);
    const inspections = await fetchDemoInspectionsPage(0, 10, buildDemoInspections(35, 2));
    expect(inspections.total).toBe(35);
    const library = await fetchDemoLibraryPage(0, 10, buildDemoLibrary(35, 2));
    expect(library.total).toBe(35);
  });
});
