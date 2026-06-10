/**
 * Demo reprisal-log provider for /reprisal.
 *
 * Same pattern as the other register-surface demo providers
 * (`demo-audit-rows.ts` / `demo-recommendations.ts` /
 * `demo-inspections.ts` / `demo-minutes.ts` / `demo-concerns.ts`):
 * deterministic synthetic data so the surface renders before the
 * T13.1 backend wire-up lands.
 *
 * Distinctive shape: each row carries the C4-tier reprisal-log
 * register attributes the viewer surfaces at a glance. Reprisal is
 * the highest sensitivity tier — every row is encrypted at rest
 * under a per-entry passphrase by default; the source identity
 * stays hidden behind a pseudonym unless the worker who filed it
 * has explicitly revealed it (a rare, deliberate event).
 *
 * The shape stays opaque on purpose — titles are workplace-agnostic
 * so the demo doesn't accidentally educate the reader into expecting
 * a particular reprisal scenario.
 *
 * Out of scope here (real backend handles):
 *   - Per-entry passphrase verification (the viewer never asks for
 *     the passphrase; it only surfaces whether one is required).
 *   - Server-side role gating on the read path.
 *   - Source-reveal consent ceremony.
 */

export type ReprisalStatus = 'filed' | 'investigating' | 'resolved' | 'archived';

export interface DemoReprisalRow {
  id: string;
  /** ISO 8601 timestamp the reprisal was filed. */
  filed_at: string;
  /** Short opaque title (real backend stores titles under the
   *  per-entry passphrase; this is what the worker sees after a
   *  successful passphrase unlock). */
  title: string;
  /** Current lifecycle status. */
  status: ReprisalStatus;
  /** True when the row's narrative is sealed under a per-entry
   *  passphrase (~95% of rows; the rare exception is a worker who
   *  opted out at intake — surfaced honestly so the viewer doesn't
   *  silently misrepresent the seal state). */
  per_entry_passphrase_required: boolean;
  /** True when the author has consented to being named (~5% — the
   *  default is anonymity). */
  source_revealed: boolean;
  /** Days elapsed since filed. */
  days_since_filed: number;
  /** Pseudonymized actor. */
  actor_pseudonym: string;
}

export interface DemoReprisalPage {
  rows: DemoReprisalRow[];
  total: number;
  page: number;
  page_size: number;
}

const DEMO_TITLES: readonly string[] = [
  'Schedule changed after raising a concern about lifting limits',
  'Removed from the safety committee rotation after a recent filing',
  'Verbal warning issued the day after the inspection walk-through',
  'Excluded from the training cohort after asking about WHMIS gaps',
  'Hours reduced after declining to operate the unguarded press',
  'Reassigned to a less-favourable shift after a refusal',
  'Performance plan opened the week after the joint inspection',
  'Discipline issued for "policy" violation never previously enforced',
  'Pattern of small disciplines after raising harassment concern',
  'Bonus withheld after committee filing'
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
 * Build N deterministic reprisal-log rows spanning the past 120 days.
 *
 * Status distribution:
 *   - ~30% filed         — newly filed, awaiting investigation
 *   - ~30% investigating — under review by an authorized member
 *   - ~30% resolved      — closed-out (vindicated / unresolved /
 *                          remedied — all collapse here for the demo)
 *   - ~10% archived      — superseded
 *
 * ~95% of rows require a per-entry passphrase; ~5% are source-revealed
 * with the author's consent.
 */
export function buildDemoReprisals(count: number, seed = 50): DemoReprisalRow[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const now = Date.now();
  const ONE_TWENTY_DAYS_MS = 120 * 24 * 60 * 60 * 1000;
  const rows: DemoReprisalRow[] = [];
  for (let i = 0; i < count; i++) {
    const title = DEMO_TITLES[Math.floor(rand() * DEMO_TITLES.length)]!;
    const actor = DEMO_ACTORS[Math.floor(rand() * DEMO_ACTORS.length)]!;
    const ageMs = Math.floor(rand() * ONE_TWENTY_DAYS_MS);
    const filed_at = new Date(now - ageMs).toISOString();
    const days_since_filed = Math.floor(ageMs / (24 * 60 * 60 * 1000));

    const rs = rand();
    let status: ReprisalStatus;
    if (rs < 0.3) status = 'filed';
    else if (rs < 0.6) status = 'investigating';
    else if (rs < 0.9) status = 'resolved';
    else status = 'archived';

    const per_entry_passphrase_required = rand() < 0.95;
    const source_revealed = rand() < 0.05;

    rows.push({
      id: 'rep-' + i.toString().padStart(6, '0'),
      filed_at,
      title,
      status,
      per_entry_passphrase_required,
      source_revealed,
      days_since_filed,
      actor_pseudonym: actor
    });
  }
  rows.sort((a, b) => (a.filed_at < b.filed_at ? 1 : -1));
  return rows;
}

/**
 * Page-based slicer — same contract as the other demo providers.
 * Optional predicate narrows the dataset before pagination (e.g. only
 * active investigations).
 */
export async function fetchDemoReprisalPage(
  page: number,
  page_size: number,
  all: DemoReprisalRow[],
  predicate?: (row: DemoReprisalRow) => boolean
): Promise<DemoReprisalPage> {
  const filtered = predicate ? all.filter(predicate) : all;
  const start = page * page_size;
  return {
    rows: filtered.slice(start, start + page_size),
    total: filtered.length,
    page,
    page_size
  };
}
