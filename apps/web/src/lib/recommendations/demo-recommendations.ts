/**
 * Demo recommendations provider for /recommendations.
 *
 * Same pattern as `demo-audit-rows.ts` / `demo-sensitive-feed.ts`:
 * deterministic synthetic data so the surface renders before the real
 * recommendations backend (T12) lands.
 *
 * Distinctive shape: each row carries the 21-day OHSA s. 50(7)(c)
 * employer-response timer state. The viewer renders different chips
 * for:
 *   - 'responded' → green (employer responded within 21 days)
 *   - 'pending'   → amber (within the 21-day window, no response yet)
 *   - 'overdue'   → red   (>21 days since filing, no response, auto-
 *                          escalated to the next meeting)
 *   - 'archived'  → neutral (decided / withdrawn / superseded)
 *
 * The traceability_concern_id link is rendered as a chip so the worker
 * can see "this recommendation traces back to concern #123". The real
 * backend joins on the concerns table for the display label.
 */

import type { DemoAuditPage } from '../audit/demo-audit-rows';

export type RecommendationStatus = 'responded' | 'pending' | 'overdue' | 'archived';

export interface DemoRecommendationRow {
  id: string;
  /** Short worker-readable title (the demo synthesizes them; the real
   *  backend stores them under the committee key). */
  title: string;
  /** Filed-at timestamp (ISO 8601). */
  filed_at: string;
  /** Days elapsed since filing — the viewer uses this to render the
   *  21-day timer chip. */
  days_elapsed: number;
  /** Current employer-response status. */
  status: RecommendationStatus;
  /** Optional concern this recommendation traces back to (F-19 /
   *  recommendation traceability requirement). */
  traceability_concern_id: string | null;
  /** Optional inspection this recommendation traces back to. */
  traceability_inspection_id: string | null;
  /** Pseudonymized actor who filed it. */
  actor_pseudonym: string;
}

export interface DemoRecommendationsPage {
  rows: DemoRecommendationRow[];
  total: number;
  page: number;
  page_size: number;
}

/**
 * Pool of plausible recommendation titles. The real backend stores
 * these under the committee key; this is what the worker would see
 * after decryption. Keeping the pool small + opaque means the demo
 * doesn't accidentally educate the reader into expecting a specific
 * workplace context.
 */
const DEMO_TITLES: readonly string[] = [
  'Replace worn fall-arrest anchor on the upper catwalk',
  'Resurface the loading-dock approach to fix the trip hazard',
  'Install machine guarding on the rotary press, station 4',
  'Refresh the bilingual safety signage in the cold-storage area',
  'Schedule WHMIS refresher for the second-shift maintenance crew',
  'Repair eyewash station nearest the chem-mix area',
  'Move the spill kit so it is within 3 metres of the dye tanks',
  'Add a lockout-tagout step to the conveyor changeover procedure',
  'Replace the cracked safety glass on the welding booth',
  'Lower the dust-collection lid on grinder cell 7',
  'Add anti-slip coating to the ramp at receiving',
  'Replace the broken kick-plate guard on press 2'
];

const DEMO_ACTORS: readonly string[] = [
  'a1b2c3d4e5f6',
  '7890abcdef12',
  '3456789abcde',
  'f0e1d2c3b4a5',
  '0987654321ab',
  'feedfacebeef'
];

/**
 * Build N deterministic recommendation rows spanning the past 60
 * days. The status distribution is:
 *   - ~35% responded
 *   - ~35% pending (filed within 21 days, no response yet)
 *   - ~20% overdue (filed >21 days ago, no response — auto-escalated)
 *   - ~10% archived
 * Days-elapsed is sampled from a 60-day window so the viewer shows
 * a realistic mix of timer states.
 */
export function buildDemoRecommendations(count: number, seed = 1789): DemoRecommendationRow[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const now = Date.now();
  const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
  const rows: DemoRecommendationRow[] = [];
  for (let i = 0; i < count; i++) {
    const title = DEMO_TITLES[Math.floor(rand() * DEMO_TITLES.length)]!;
    const actor = DEMO_ACTORS[Math.floor(rand() * DEMO_ACTORS.length)]!;
    const ageMs = Math.floor(rand() * SIXTY_DAYS_MS);
    const filed_at = new Date(now - ageMs).toISOString();
    const days_elapsed = Math.floor(ageMs / (24 * 60 * 60 * 1000));

    // Status sampling — see header docstring for the distribution.
    const r = rand();
    /** @type {RecommendationStatus} */
    let status: RecommendationStatus;
    if (r < 0.1) status = 'archived';
    else if (days_elapsed > 21 && r < 0.55) status = 'overdue';
    else if (days_elapsed <= 21 && r < 0.55) status = 'pending';
    else status = 'responded';

    // Traceability — ~70% link to a concern, ~30% to an inspection.
    const traceabilityIsConcern = rand() < 0.7;
    const traceabilityIdx = Math.floor(rand() * 999);
    rows.push({
      id: 'rec-' + i.toString().padStart(6, '0'),
      title,
      filed_at,
      days_elapsed,
      status,
      traceability_concern_id: traceabilityIsConcern ? 'con-' + traceabilityIdx : null,
      traceability_inspection_id: traceabilityIsConcern ? null : 'ins-' + traceabilityIdx,
      actor_pseudonym: actor
    });
  }
  rows.sort((a, b) => (a.filed_at < b.filed_at ? 1 : -1));
  return rows;
}

/**
 * Page-based slicer — same contract as the other demo providers.
 * Optional predicate narrows the dataset before pagination (e.g. only
 * overdue rows).
 */
export async function fetchDemoRecommendationsPage(
  page: number,
  page_size: number,
  all: DemoRecommendationRow[],
  predicate?: (row: DemoRecommendationRow) => boolean
): Promise<DemoRecommendationsPage> {
  const filtered = predicate ? all.filter(predicate) : all;
  const start = page * page_size;
  return {
    rows: filtered.slice(start, start + page_size),
    total: filtered.length,
    page,
    page_size
  };
}

/** Re-export DemoAuditPage so a consumer can type-share the page shape. */
export type { DemoAuditPage };
