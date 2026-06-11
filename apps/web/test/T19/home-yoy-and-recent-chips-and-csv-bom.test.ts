/**
 * T19 — HomeDashboard "monthly activity" tile shows a YoY delta;
 * RecentActivityCard surfaces category filter chips;
 * triggerCsvDownload prepends a UTF-8 BOM for Excel compatibility.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import HomeDashboard from '../../src/lib/home/HomeDashboard.svelte';
import RecentActivityCard from '../../src/lib/home/RecentActivityCard.svelte';
import { triggerCsvDownload } from '../../src/lib/ui/csv';
import { ZERO_SUMMARY, type HomeSummary } from '../../src/lib/home/home-summary';
import type { DemoAuditRow } from '../../src/lib/audit/demo-audit-rows';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('T19 — HomeDashboard "monthly activity" tile YoY delta', () => {
  it('hides the YoY indicator when both current and prior counts are zero', () => {
    render(HomeDashboard, { props: { summary: ZERO_SUMMARY } });
    expect(screen.queryByTestId('hd-tile-report-yoy')).toBeNull();
  });

  it('renders the YoY indicator with sign + suffix when there is activity', () => {
    const summary: HomeSummary = {
      ...ZERO_SUMMARY,
      currentMonthActivity: 12,
      priorMonthActivity: 7
    };
    render(HomeDashboard, { props: { summary } });
    const yoy = screen.getByTestId('hd-tile-report-yoy');
    expect(yoy.getAttribute('data-delta')).toBe('5');
    expect(yoy.textContent ?? '').toMatch(/\+5/);
  });

  it('renders is-up + is-down direction classes based on the delta', () => {
    const summary: HomeSummary = {
      ...ZERO_SUMMARY,
      currentMonthActivity: 8,
      priorMonthActivity: 12
    };
    render(HomeDashboard, { props: { summary } });
    const yoy = screen.getByTestId('hd-tile-report-yoy');
    expect(yoy.getAttribute('data-delta')).toBe('-4');
    expect(yoy.className).toContain('is-down');
  });

  it('renders the is-flat class when the delta is zero but activity exists', () => {
    const summary: HomeSummary = {
      ...ZERO_SUMMARY,
      currentMonthActivity: 5,
      priorMonthActivity: 5
    };
    render(HomeDashboard, { props: { summary } });
    const yoy = screen.getByTestId('hd-tile-report-yoy');
    expect(yoy.getAttribute('data-delta')).toBe('0');
    expect(yoy.className).toContain('is-flat');
  });
});

describe('T19 — home-summary carries priorMonthActivity', () => {
  it('ZERO_SUMMARY defaults priorMonthActivity to 0', () => {
    expect(ZERO_SUMMARY.priorMonthActivity).toBe(0);
  });
});

describe('T19 — RecentActivityCard filter chips', () => {
  const sample: DemoAuditRow[] = [
    {
      id: 'a',
      ts: '2026-06-11T09:00:00.000Z',
      event_type: 'session.created',
      actor_pseudonym: 'a1b2c3d4e5f6',
      meta: {}
    },
    {
      id: 'b',
      ts: '2026-06-11T08:00:00.000Z',
      event_type: 'concern.created',
      actor_pseudonym: 'a1b2c3d4e5f6',
      meta: {}
    },
    {
      id: 'c',
      ts: '2026-06-11T07:00:00.000Z',
      event_type: 'committee_member.added',
      actor_pseudonym: 'a1b2c3d4e5f6',
      meta: {}
    }
  ];

  it('renders 4 chips (All + sessions + workplace + committee) when rows exist', () => {
    render(RecentActivityCard, { props: { rows: sample } });
    expect(screen.getAllByTestId('ra-chip')).toHaveLength(4);
  });

  it('the All chip is pressed by default and the list shows every row', () => {
    render(RecentActivityCard, { props: { rows: sample } });
    const chips = screen.getAllByTestId('ra-chip');
    expect(chips[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByTestId('ra-row')).toHaveLength(3);
  });

  it('clicking the sessions chip narrows the list to session.* rows', async () => {
    render(RecentActivityCard, { props: { rows: sample } });
    const chips = screen.getAllByTestId('ra-chip');
    const sessionsChip = chips.find((c) => c.getAttribute('data-value') === 'sessions')!;
    await fireEvent.click(sessionsChip);
    expect(sessionsChip.getAttribute('aria-pressed')).toBe('true');
    const rows = screen.getAllByTestId('ra-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent ?? '').toContain('session.created');
  });

  it('clicking the workplace chip narrows to concern/reprisal/refusal/s51', async () => {
    render(RecentActivityCard, { props: { rows: sample } });
    const chips = screen.getAllByTestId('ra-chip');
    const workplaceChip = chips.find((c) => c.getAttribute('data-value') === 'workplace')!;
    await fireEvent.click(workplaceChip);
    const rows = screen.getAllByTestId('ra-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent ?? '').toContain('concern.created');
  });

  it('renders a category-empty state when the active filter matches no rows', async () => {
    const onlySessions: DemoAuditRow[] = [sample[0]!];
    render(RecentActivityCard, { props: { rows: onlySessions } });
    const chips = screen.getAllByTestId('ra-chip');
    const workplaceChip = chips.find((c) => c.getAttribute('data-value') === 'workplace')!;
    await fireEvent.click(workplaceChip);
    expect(screen.getByTestId('ra-empty-filtered')).toBeDefined();
  });

  it('clicking back to the All chip restores every row', async () => {
    render(RecentActivityCard, { props: { rows: sample } });
    const chips = screen.getAllByTestId('ra-chip');
    await fireEvent.click(chips.find((c) => c.getAttribute('data-value') === 'sessions')!);
    await fireEvent.click(chips.find((c) => c.getAttribute('data-value') === '')!);
    expect(screen.getAllByTestId('ra-row')).toHaveLength(3);
  });

  it('does not render the chip nav when rows is empty', () => {
    render(RecentActivityCard, { props: { rows: [] } });
    expect(screen.queryByTestId('ra-chips')).toBeNull();
  });
});

describe('T19 — triggerCsvDownload prepends a UTF-8 BOM', () => {
  it('the Blob constructor receives the UTF-8 BOM as its first part', () => {
    const calls: BlobPart[][] = [];
    const OrigBlob = globalThis.Blob;
    // @ts-expect-error — wrap for inspection
    globalThis.Blob = class extends OrigBlob {
      constructor(parts: BlobPart[], opts?: BlobPropertyBag) {
        calls.push(parts);
        super(parts, opts);
      }
    };
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: () => 'blob:mock'
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: () => undefined
    });
    try {
      triggerCsvDownload({ csv: 'a,b\n1,2', filename: 'x.csv' });
    } finally {
      globalThis.Blob = OrigBlob;
    }
    expect(calls.length).toBe(1);
    const first = calls[0]![0];
    expect(typeof first).toBe('string');
    expect((first as string).charCodeAt(0)).toBe(0xfeff);
  });

  it('the csv module source declares the UTF-8 BOM constant', () => {
    const src = readFileSync(resolve(__dirname, '../../src/lib/ui/csv.ts'), 'utf8');
    expect(src).toMatch(/UTF8_BOM/);
    expect(src).toMatch(/new Blob\(\[UTF8_BOM,\s*opts\.csv\]/);
  });
});

describe('T19 — i18n keys for the new YoY suffix + recent chips', () => {
  const catalog = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
  );

  it('catalog carries the new home tile + recent chip strings', () => {
    expect(typeof catalog.home.dashboard.tile.yoy_suffix).toBe('string');
    expect(typeof catalog.home.recent.empty_filtered).toBe('string');
    expect(typeof catalog.home.recent.chips_aria).toBe('string');
  });
});
