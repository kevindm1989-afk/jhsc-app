/**
 * Demo inspections provider for /inspections.
 *
 * Same pattern as `demo-audit-rows.ts` / `demo-sensitive-feed.ts` /
 * `demo-recommendations.ts`: deterministic synthetic data so the
 * register surface renders before the real inspection backend (T10.1)
 * lands.
 *
 * Distinctive shape: each row carries the OHSA s. 9(26)(b) "monthly
 * inspection" register attributes that the viewer surfaces at a
 * glance:
 *   - Area walked, conducted-on date, conducted-by (pseudonymized).
 *   - Per-entry HMAC integrity status (`verified` / `quarantined`).
 *     Quarantined rows mean the F-45 / ADR-0014 keyed-MAC check failed
 *     on drain — a rare-but-real event the worker needs to see.
 *   - Photo + checklist-item counts (the inspection's "size").
 *   - Whether the entry was offline-queued (showing how the
 *     offline-first capture surface distinguishes itself from a
 *     direct online submission).
 *
 * The shape stays opaque on purpose — area names are workplace-agnostic
 * so the demo doesn't accidentally educate the reader into expecting a
 * particular workplace.
 */

export type InspectionIntegrityStatus = 'verified' | 'quarantined';

export interface DemoInspectionRow {
  id: string;
  /** Workplace area covered by the walk. */
  area: string;
  /** ISO 8601 timestamp the inspection was conducted. */
  conducted_at: string;
  /** Number of checklist items captured for this inspection. */
  checklist_item_count: number;
  /** Number of photos attached. */
  photo_count: number;
  /** Per-entry HMAC integrity status (F-45 / ADR-0014). */
  integrity_status: InspectionIntegrityStatus;
  /** True when this entry was held in the offline queue before sync. */
  was_offline_queued: boolean;
  /** Short opaque preview line. */
  notes_preview: string;
  /** Pseudonymized actor who conducted the inspection. */
  actor_pseudonym: string;
}

export interface DemoInspectionsPage {
  rows: DemoInspectionRow[];
  total: number;
  page: number;
  page_size: number;
}

/**
 * Workplace area pool. Keeping the pool small + intentionally generic
 * means the demo reads as plausible for any shop / warehouse / clinic /
 * office context without leaking a specific workplace.
 */
const DEMO_AREAS: readonly string[] = [
  'Production floor — west bay',
  'Loading dock and receiving',
  'Cold storage area',
  'Chemical mixing room',
  'Welding booth row',
  'Maintenance shop',
  'Office mezzanine',
  'Stairwell and exit corridor',
  'Compressor and boiler room',
  'Lunch room and lockers',
  'Outdoor yard and trailer line',
  'Warehouse high-rack aisle'
];

/**
 * Opaque single-line preview pool — what a worker might jot under
 * "notes" after a walk. The real backend stores these encrypted; this
 * is what the worker would see after decryption.
 */
const DEMO_PREVIEWS: readonly string[] = [
  'All guards present and aligned; one signage refresh queued.',
  'Spill kit relocated to meet 3-metre rule; otherwise clean walk.',
  'Two trip hazards flagged for the maintenance follow-up.',
  'Eyewash station tested; one fixture flagged for replacement.',
  'Lockout-tagout audit completed; one procedure update requested.',
  'Fire-exit signage and egress paths clear; nothing actionable.',
  'PPE supply stations re-stocked during walk; one out-of-date kit.',
  'Lighting recheck; one fixture flickering in the cold-storage area.',
  'Floor markings refreshed where worn; pallet stacks within limits.',
  'WHMIS labels checked; one secondary container missing a label.'
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
 * Build N deterministic inspection rows spanning the past 60 days.
 *
 *   - ~95% verified, ~5% quarantined (a rare-but-real F-45 event the
 *     worker register surfaces honestly).
 *   - ~40% were offline-queued (so the register reads as a realistic
 *     mix of direct + offline-first capture).
 *   - 0-12 photos, 8-24 checklist items.
 */
export function buildDemoInspections(count: number, seed = 1066): DemoInspectionRow[] {
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
  const rows: DemoInspectionRow[] = [];
  for (let i = 0; i < count; i++) {
    const area = DEMO_AREAS[Math.floor(rand() * DEMO_AREAS.length)]!;
    const notes_preview = DEMO_PREVIEWS[Math.floor(rand() * DEMO_PREVIEWS.length)]!;
    const actor = DEMO_ACTORS[Math.floor(rand() * DEMO_ACTORS.length)]!;
    const ageMs = Math.floor(rand() * SIXTY_DAYS_MS);
    const conducted_at = new Date(now - ageMs).toISOString();
    const checklist_item_count = 8 + Math.floor(rand() * 17); // 8..24
    const photo_count = Math.floor(rand() * 13); // 0..12
    const integrity_status: InspectionIntegrityStatus = rand() < 0.05 ? 'quarantined' : 'verified';
    const was_offline_queued = rand() < 0.4;
    rows.push({
      id: 'ins-' + i.toString().padStart(6, '0'),
      area,
      conducted_at,
      checklist_item_count,
      photo_count,
      integrity_status,
      was_offline_queued,
      notes_preview,
      actor_pseudonym: actor
    });
  }
  rows.sort((a, b) => (a.conducted_at < b.conducted_at ? 1 : -1));
  return rows;
}

/** Page-based slicer — same contract as the other demo providers. */
export async function fetchDemoInspectionsPage(
  page: number,
  page_size: number,
  all: DemoInspectionRow[]
): Promise<DemoInspectionsPage> {
  const start = page * page_size;
  return {
    rows: all.slice(start, start + page_size),
    total: all.length,
    page,
    page_size
  };
}
