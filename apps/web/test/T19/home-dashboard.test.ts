/**
 * T19.1 — HomeDashboard component renders the five register tiles.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import HomeDashboard from '../../src/lib/home/HomeDashboard.svelte';
import { ZERO_SUMMARY, type HomeSummary } from '../../src/lib/home/home-summary';

afterEach(() => {
  cleanup();
});

describe('T19.1 — HomeDashboard', () => {
  it('renders the six tiles plus the see-all link', () => {
    render(HomeDashboard, { props: { summary: ZERO_SUMMARY } });
    for (const id of [
      'hd-tile-concerns',
      'hd-tile-recommendations',
      'hd-tile-training',
      'hd-tile-work-refusal',
      'hd-tile-s51',
      'hd-tile-report'
    ]) {
      expect(screen.getByTestId(id)).toBeDefined();
    }
    expect(screen.getByTestId('hd-more-link')).toBeDefined();
  });

  it('renders the counts the summary supplies', () => {
    const summary: HomeSummary = {
      openConcerns: 7,
      overdueRecommendations: 2,
      expiredTraining: 4,
      activeRefusals: 1,
      preservingScenes: 1,
      currentMonthActivity: 23,
      priorMonthActivity: 0,
      monthlyActivityTrailing: []
    };
    render(HomeDashboard, { props: { summary } });
    expect(screen.getByTestId('hd-count-concerns').textContent).toBe('7');
    expect(screen.getByTestId('hd-count-recommendations').textContent).toBe('2');
    expect(screen.getByTestId('hd-count-training').textContent).toBe('4');
    expect(screen.getByTestId('hd-count-work-refusal').textContent).toBe('1');
    expect(screen.getByTestId('hd-count-s51').textContent).toBe('1');
    expect(screen.getByTestId('hd-count-report').textContent).toBe('23');
  });

  it('marks tiles with counts > 0 as active and zero-count tiles as inactive', () => {
    const summary: HomeSummary = {
      openConcerns: 0,
      overdueRecommendations: 3,
      expiredTraining: 0,
      activeRefusals: 2,
      preservingScenes: 0,
      currentMonthActivity: 11,
      priorMonthActivity: 0,
      monthlyActivityTrailing: []
    };
    render(HomeDashboard, { props: { summary } });
    expect(screen.getByTestId('hd-tile-concerns').getAttribute('data-active')).toBe('false');
    expect(screen.getByTestId('hd-tile-recommendations').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('hd-tile-training').getAttribute('data-active')).toBe('false');
    expect(screen.getByTestId('hd-tile-work-refusal').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('hd-tile-s51').getAttribute('data-active')).toBe('false');
    expect(screen.getByTestId('hd-tile-report').getAttribute('data-active')).toBe('true');
  });

  it('each tile deep-links to its register surface WITH the matching filter param', () => {
    // The filter param wires each tile to the same predicate the
    // summariser already applies — so a click on "Open concerns: 7"
    // lands on a register narrowed to those 7 rows. Without the
    // filter, the count is lost on click.
    render(HomeDashboard, { props: { summary: ZERO_SUMMARY } });
    expect(screen.getByTestId('hd-tile-concerns').getAttribute('href')).toBe(
      '/concerns?filter=open'
    );
    expect(screen.getByTestId('hd-tile-recommendations').getAttribute('href')).toBe(
      '/recommendations?filter=overdue'
    );
    expect(screen.getByTestId('hd-tile-training').getAttribute('href')).toBe(
      '/training?filter=expired'
    );
    expect(screen.getByTestId('hd-tile-work-refusal').getAttribute('href')).toBe(
      '/work-refusal?filter=active'
    );
    expect(screen.getByTestId('hd-tile-s51').getAttribute('href')).toBe(
      '/s51-evidence?filter=preserving'
    );
    expect(screen.getByTestId('hd-tile-report').getAttribute('href')).toBe('/report');
    expect(screen.getByTestId('hd-more-link').getAttribute('href')).toBe('/more');
  });
});
