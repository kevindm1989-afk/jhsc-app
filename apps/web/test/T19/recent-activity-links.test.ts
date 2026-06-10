/**
 * T19.1 — Recent Activity rows are now clickable deep links.
 *
 * Pins the pure event_type → href mapping plus the component-level
 * contract that each row is wrapped in an <a> tag.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { eventTypeToHref } from '../../src/lib/home/recent-activity-targets';
import RecentActivityCard from '../../src/lib/home/RecentActivityCard.svelte';
import type { DemoAuditRow } from '../../src/lib/audit/demo-audit-rows';

afterEach(() => {
  cleanup();
});

describe('T19.1 — eventTypeToHref', () => {
  it.each([
    ['concern.created', '/concerns'],
    ['concern.updated', '/concerns'],
    ['concern.source_revealed', '/concerns'],
    ['reprisal.created', '/reprisal'],
    ['reprisal.read', '/reprisal'],
    ['work_refusal.created', '/work-refusal'],
    ['work_refusal.stage_advanced', '/work-refusal'],
    ['s51_evidence.created', '/s51-evidence'],
    ['s51_evidence.scene_preserved', '/s51-evidence'],
    ['recommendation.created', '/recommendations'],
    ['recommendation.responded', '/recommendations'],
    ['inspection.submitted', '/inspections'],
    ['minutes.draft_created', '/minutes'],
    ['minutes.draft_updated', '/minutes']
  ])('maps %s → %s', (event, href) => {
    expect(eventTypeToHref(event)).toBe(href);
  });

  it.each([
    ['session.created', '/settings'],
    ['session.revoked', '/settings'],
    ['panic_wipe.invoked', '/settings'],
    ['recovery_blob.viewed', '/settings'],
    ['recovery_blob.stored', '/settings'],
    ['identity_keypair.created', '/settings']
  ])('routes account/security event %s to %s', (event, href) => {
    expect(eventTypeToHref(event)).toBe(href);
  });

  it.each([
    ['committee_member.added', '/audit'],
    ['committee_member.revoked', '/audit'],
    ['audit_log.read', '/audit'],
    ['retention.pass', '/audit'],
    ['rate_limit', '/audit'],
    ['queue.integrity_fail', '/audit'],
    ['client.identity_selftest_fail', '/audit'],
    ['unknown.event', '/audit']
  ])('falls back to /audit for %s', (event, href) => {
    expect(eventTypeToHref(event)).toBe(href);
  });
});

describe('T19.1 — RecentActivityCard rows render as links', () => {
  const sample: DemoAuditRow[] = [
    {
      id: 'row-001',
      ts: '2026-06-10T10:00:00.000Z',
      event_type: 'concern.created',
      actor_pseudonym: 'a1b2c3d4e5f6',
      meta: { hazard_class: 'physical' }
    },
    {
      id: 'row-002',
      ts: '2026-06-10T09:00:00.000Z',
      event_type: 'session.created',
      actor_pseudonym: 'feedfacebeef',
      meta: {}
    },
    {
      id: 'row-003',
      ts: '2026-06-10T08:00:00.000Z',
      event_type: 'audit_log.read',
      actor_pseudonym: '7890abcdef12',
      meta: {}
    }
  ];

  it('each row carries a link with the mapped href', () => {
    render(RecentActivityCard, { props: { rows: sample } });
    const links = screen.getAllByTestId('ra-row-link');
    expect(links.length).toBe(3);
    expect(links[0]!.getAttribute('href')).toBe('/concerns');
    expect(links[1]!.getAttribute('href')).toBe('/settings');
    expect(links[2]!.getAttribute('href')).toBe('/audit');
  });

  it('each link carries an aria-label describing the event', () => {
    render(RecentActivityCard, { props: { rows: sample } });
    const link = screen.getAllByTestId('ra-row-link')[0]!;
    const aria = link.getAttribute('aria-label') ?? '';
    expect(aria).toMatch(/concern\.created/);
    // The formatted timestamp (T flattened to space, ms stripped) is included.
    expect(aria).toMatch(/2026-06-10 10:00:00Z/);
  });

  it('an empty rows array renders the empty state and no row links', () => {
    render(RecentActivityCard, { props: { rows: [] } });
    expect(screen.getByTestId('ra-empty')).toBeDefined();
    expect(screen.queryAllByTestId('ra-row-link').length).toBe(0);
  });
});
