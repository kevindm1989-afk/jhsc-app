/**
 * T19.1 — RecentActivityCard component.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import RecentActivityCard from '../../src/lib/home/RecentActivityCard.svelte';
import type { DemoAuditRow } from '../../src/lib/audit/demo-audit-rows';
import { buildDemoAuditRows } from '../../src/lib/audit/demo-audit-rows';

afterEach(() => {
  cleanup();
});

describe('T19.1 — RecentActivityCard', () => {
  it('renders the heading + intro + see-all link on an empty dataset', () => {
    render(RecentActivityCard, { props: { rows: [] } });
    expect(screen.getByTestId('recent-activity')).toBeDefined();
    expect(screen.getByTestId('ra-empty')).toBeDefined();
    expect(screen.getByTestId('ra-see-all').getAttribute('href')).toBe('/audit');
  });

  it('renders one row per supplied audit row with timestamp + event + actor', () => {
    const sample: DemoAuditRow[] = [
      {
        id: 'row-001',
        ts: '2026-06-09T10:30:00.000Z',
        event_type: 'concern.created',
        actor_pseudonym: 'a1b2c3d4e5f6',
        meta: { hazard_class: 'physical' }
      },
      {
        id: 'row-002',
        ts: '2026-06-09T09:15:00.000Z',
        event_type: 'recommendation.created',
        actor_pseudonym: 'feedfacebeef',
        meta: { rec_id: 'rec-42' }
      }
    ];
    render(RecentActivityCard, { props: { rows: sample } });
    expect(screen.getAllByTestId('ra-row').length).toBe(2);
    const events = screen.getAllByTestId('ra-row-event').map((e) => e.textContent);
    expect(events).toEqual(['concern.created', 'recommendation.created']);
    const actors = screen.getAllByTestId('ra-row-actor').map((a) => a.textContent);
    expect(actors).toEqual(['a1b2c3d4e5f6', 'feedfacebeef']);
    // No empty banner when rows exist.
    expect(screen.queryByTestId('ra-empty')).toBeNull();
  });

  it('renders the timestamp without milliseconds, with the T flattened to a space', () => {
    const sample: DemoAuditRow[] = [
      {
        id: 'row-001',
        ts: '2026-06-09T10:30:00.000Z',
        event_type: 'session.created',
        actor_pseudonym: 'a1b2c3d4e5f6',
        meta: {}
      }
    ];
    render(RecentActivityCard, { props: { rows: sample } });
    const ts = screen.getByTestId('ra-row-ts').textContent ?? '';
    // "2026-06-09 10:30:00Z" — no T, no .000.
    expect(ts).toBe('2026-06-09 10:30:00Z');
  });

  it('takes a deterministic top-5 slice of buildDemoAuditRows without throwing', () => {
    const rows = buildDemoAuditRows(50).slice(0, 5);
    expect(rows.length).toBe(5);
    render(RecentActivityCard, { props: { rows } });
    expect(screen.getAllByTestId('ra-row').length).toBe(5);
  });
});
