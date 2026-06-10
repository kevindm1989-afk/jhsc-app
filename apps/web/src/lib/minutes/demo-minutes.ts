/**
 * Demo minutes provider for /minutes.
 *
 * Same pattern as `demo-audit-rows.ts` / `demo-sensitive-feed.ts` /
 * `demo-recommendations.ts` / `demo-inspections.ts`: deterministic
 * synthetic data so the register surface renders before the real
 * minutes backend lands.
 *
 * Distinctive shape: each row carries the JHSC meeting-minutes
 * register attributes the viewer surfaces at a glance:
 *
 *   - Status: draft / approved / archived. Draft minutes are
 *     committee-key encrypted on this device and visible only to
 *     authorized worker members; approved minutes have crossed the
 *     four-eyes promotion ceremony with a documented quorum;
 *     archived minutes are superseded.
 *   - Quorum-met: only meaningful for approved minutes. Records the
 *     number of present members at the time of approval.
 *   - Revision count: append-only revision history per minute draft —
 *     no silent overwrites.
 *   - Quoted concern count: F-19 traceability. When minutes quote a
 *     filed concern the original author's consent is required before
 *     approval; the count surfaces in the register so the worker
 *     co-chair can see at a glance whether a draft has consent
 *     gates outstanding.
 *
 * Out of scope here (real backend handles):
 *   - Server-side consent enforcement.
 *   - Per-member role gating on the read path.
 *   - Real revision-history retrieval.
 */

export type MinutesStatus = 'draft' | 'approved' | 'archived';

export interface DemoMinutesRow {
  id: string;
  /** ISO date for the meeting these minutes cover. */
  meeting_date: string;
  /** Short opaque title (the real backend stores titles under the
   *  committee key; this is what the worker sees after decryption). */
  title: string;
  /** Current minutes status. */
  status: MinutesStatus;
  /** Number of revisions captured in the append-only history. */
  revision_count: number;
  /** Number of concerns quoted in the minutes (F-19 traceability). */
  quoted_concern_count: number;
  /** Members present at the time of approval. Only set when status
   *  is 'approved'. */
  quorum_present: number | null;
  /** Pseudonymized worker who drafted these minutes. */
  drafter_pseudonym: string;
}

export interface DemoMinutesPage {
  rows: DemoMinutesRow[];
  total: number;
  page: number;
  page_size: number;
}

/**
 * Pool of plausible minutes titles. Keeping the pool small +
 * intentionally generic means the demo doesn't accidentally educate
 * the reader into expecting a specific committee context.
 */
const DEMO_TITLES: readonly string[] = [
  'Monthly meeting — fall protection action plan',
  'Quarterly review — incident statistics',
  'Joint walkthrough debrief — receiving area',
  'Annual training plan refresh',
  'Recommendation status update — Q-cycle',
  'Special meeting — heat-stress response',
  'Workplace inspection follow-up — north bay',
  'Committee composition update',
  'Vendor safety briefing — new line gear',
  'Emergency procedure tabletop review',
  'Bilingual signage refresh planning',
  'Member training certification refresh'
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
 * Build N deterministic minutes rows spanning the past 90 days.
 *
 * Status distribution:
 *   - ~30% draft  — worker-side, awaiting approval
 *   - ~55% approved — quorum-met, published
 *   - ~15% archived — superseded
 *
 * Revision count: 1..6 (drafts tend higher than approved/archived in
 * the wild, but the demo keeps the sampling uniform — the visual
 * point is just "history exists").
 */
export function buildDemoMinutes(count: number, seed = 1789): DemoMinutesRow[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const now = Date.now();
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  const rows: DemoMinutesRow[] = [];
  for (let i = 0; i < count; i++) {
    const title = DEMO_TITLES[Math.floor(rand() * DEMO_TITLES.length)]!;
    const actor = DEMO_ACTORS[Math.floor(rand() * DEMO_ACTORS.length)]!;
    const ageMs = Math.floor(rand() * NINETY_DAYS_MS);
    const meeting_date = new Date(now - ageMs).toISOString();

    // Status sampling — see distribution above.
    const r = rand();
    let status: MinutesStatus;
    if (r < 0.3) status = 'draft';
    else if (r < 0.85) status = 'approved';
    else status = 'archived';

    const revision_count = 1 + Math.floor(rand() * 6); // 1..6
    const quoted_concern_count = Math.floor(rand() * 4); // 0..3
    // Quorum present only for approved. Real-world quorum is committee-
    // size-dependent; the demo samples 3..8 which spans the typical
    // small-employer JHSC committee size.
    const quorum_present = status === 'approved' ? 3 + Math.floor(rand() * 6) : null;

    rows.push({
      id: 'min-' + i.toString().padStart(6, '0'),
      meeting_date,
      title,
      status,
      revision_count,
      quoted_concern_count,
      quorum_present,
      drafter_pseudonym: actor
    });
  }
  rows.sort((a, b) => (a.meeting_date < b.meeting_date ? 1 : -1));
  return rows;
}

/**
 * Page-based slicer — same contract as the other demo providers.
 * Optional predicate narrows the dataset before pagination (e.g. only
 * drafts).
 */
export async function fetchDemoMinutesPage(
  page: number,
  page_size: number,
  all: DemoMinutesRow[],
  predicate?: (row: DemoMinutesRow) => boolean
): Promise<DemoMinutesPage> {
  const filtered = predicate ? all.filter(predicate) : all;
  const start = page * page_size;
  return {
    rows: filtered.slice(start, start + page_size),
    total: filtered.length,
    page,
    page_size
  };
}
