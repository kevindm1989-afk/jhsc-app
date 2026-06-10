/**
 * T19.1 — FilterBanner component + demo-provider predicate paths.
 *
 * Together these pin the URL-driven filter contract:
 *   - Dashboard tiles deep-link with `?filter=<value>` (see
 *     home-dashboard.test.ts).
 *   - Route pages read that param and pass a predicate to the demo
 *     provider, which narrows the dataset before pagination so
 *     `total` reflects the filtered count.
 *   - The FilterBanner renders above the viewer with a label + a
 *     clear-filter link back to the bare route.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import FilterBanner from '../../src/lib/ui/FilterBanner.svelte';
import {
  buildDemoConcerns,
  fetchDemoConcernsPage
} from '../../src/lib/concerns/demo-concerns';
import {
  buildDemoRecommendations,
  fetchDemoRecommendationsPage
} from '../../src/lib/recommendations/demo-recommendations';
import {
  buildDemoTraining,
  fetchDemoTrainingPage
} from '../../src/lib/training/demo-training';
import {
  buildDemoWorkRefusals,
  fetchDemoWorkRefusalPage
} from '../../src/lib/work-refusal/demo-work-refusal';
import {
  buildDemoS51Evidence,
  fetchDemoS51EvidencePage
} from '../../src/lib/s51-evidence/demo-s51-evidence';

afterEach(() => {
  cleanup();
});

describe('T19.1 — FilterBanner', () => {
  it('renders the label + clear-filter link to the supplied clearHref', () => {
    render(FilterBanner, { props: { label: 'Open concerns', clearHref: '/concerns' } });
    const banner = screen.getByTestId('filter-banner');
    expect(banner).toBeDefined();
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toMatch(/Open concerns/);
    const clear = screen.getByTestId('filter-banner-clear');
    expect(clear.getAttribute('href')).toBe('/concerns');
  });
});

describe('T19.1 — demo provider predicate paths narrow the dataset before pagination', () => {
  it('fetchDemoConcernsPage with status=open predicate scopes total to the filtered rows', async () => {
    const all = buildDemoConcerns(80, 1);
    const expected = all.filter((r) => r.status === 'open').length;
    const result = await fetchDemoConcernsPage(0, 10, all, (r) => r.status === 'open');
    expect(result.total).toBe(expected);
    for (const row of result.rows) expect(row.status).toBe('open');
  });

  it('fetchDemoRecommendationsPage with overdue predicate scopes total to the filtered rows', async () => {
    const all = buildDemoRecommendations(80, 1);
    const expected = all.filter((r) => r.status === 'overdue').length;
    const result = await fetchDemoRecommendationsPage(
      0,
      10,
      all,
      (r) => r.status === 'overdue'
    );
    expect(result.total).toBe(expected);
    for (const row of result.rows) expect(row.status).toBe('overdue');
  });

  it('fetchDemoTrainingPage with expired predicate scopes total to the filtered rows', async () => {
    const all = buildDemoTraining(80, 1);
    const expected = all.filter((r) => r.validity === 'expired').length;
    const result = await fetchDemoTrainingPage(0, 10, all, (r) => r.validity === 'expired');
    expect(result.total).toBe(expected);
    for (const row of result.rows) expect(row.validity).toBe('expired');
  });

  it('fetchDemoWorkRefusalPage with active predicate excludes resolved rows', async () => {
    const all = buildDemoWorkRefusals(80, 1);
    const expected = all.filter((r) => r.stage !== 'resolved').length;
    const result = await fetchDemoWorkRefusalPage(0, 10, all, (r) => r.stage !== 'resolved');
    expect(result.total).toBe(expected);
    for (const row of result.rows) expect(row.stage).not.toBe('resolved');
  });

  it('fetchDemoS51EvidencePage with preserving predicate scopes total', async () => {
    const all = buildDemoS51Evidence(80, 1);
    const expected = all.filter((r) => r.scene_state === 'preserving').length;
    const result = await fetchDemoS51EvidencePage(
      0,
      10,
      all,
      (r) => r.scene_state === 'preserving'
    );
    expect(result.total).toBe(expected);
    for (const row of result.rows) expect(row.scene_state).toBe('preserving');
  });

  it('omitting the predicate returns the full dataset (back-compat)', async () => {
    const all = buildDemoConcerns(35, 2);
    const result = await fetchDemoConcernsPage(0, 10, all);
    expect(result.total).toBe(35);
    expect(result.rows.length).toBe(10);
  });
});
