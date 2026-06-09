/**
 * Demo concerns provider for /concerns.
 *
 * Same pattern as `demo-audit-rows.ts` / `demo-recommendations.ts` /
 * `demo-inspections.ts` / `demo-minutes.ts`: deterministic synthetic
 * data so the register surface renders before the T08.1 backend wire-
 * up lands.
 *
 * Distinctive shape: each row carries the concerns-register attributes
 * the viewer surfaces at a glance:
 *
 *   - Status: open / triaged / resolved / archived. Status pin colour-
 *     codes the lifecycle stage.
 *   - Severity: low / medium / high / critical. Independent of status —
 *     a "critical, resolved" row reads honestly as both severe and
 *     closed-out.
 *   - Hazard class: the OHSA-flavoured category (physical / chemical /
 *     biological / ergonomic / psychosocial).
 *   - Source protection: F-17 anonymous-by-default. ~70% of rows
 *     carry source_protected=true, meaning the source identity is
 *     hidden behind the actor pseudonym even from authorized worker
 *     members. The remaining ~30% are author-revealed with consent.
 *   - Days-since-filed: surfaces age at a glance.
 */

export type ConcernStatus = 'open' | 'triaged' | 'resolved' | 'archived';
export type ConcernSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ConcernHazardClass =
  | 'physical'
  | 'chemical'
  | 'biological'
  | 'ergonomic'
  | 'psychosocial';

export interface DemoConcernRow {
  id: string;
  /** ISO 8601 timestamp the concern was filed. */
  filed_at: string;
  /** Short opaque title (the real backend stores titles under the
   *  committee key; this is what the worker sees after decryption). */
  title: string;
  /** Current lifecycle status. */
  status: ConcernStatus;
  /** Severity tier — independent of status. */
  severity: ConcernSeverity;
  /** OHSA-flavoured hazard category. */
  hazard_class: ConcernHazardClass;
  /** True when the source identity is hidden behind the actor
   *  pseudonym (F-17 anonymous-by-default). False when the author
   *  has consented to being named. */
  source_protected: boolean;
  /** Days elapsed since filed. */
  days_since_filed: number;
  /** Pseudonymized actor. */
  actor_pseudonym: string;
}

export interface DemoConcernsPage {
  rows: DemoConcernRow[];
  total: number;
  page: number;
  page_size: number;
}

const DEMO_TITLES: readonly string[] = [
  'Slip hazard near the loading-dock ramp after rain',
  'WHMIS labelling missing on the dye-transfer caddy',
  'Repetitive-strain risk on the packing-line carousel',
  'Forklift visibility blocked at the mezzanine turn',
  'Eyewash station inoperable on the chem-mix wall',
  'Verbal harassment incident pattern on the night shift',
  'Confined-space entry without standby attendant',
  'Welding fume capture insufficient at booth 3',
  'Stair handrail loose on the second landing',
  'Heat exposure in the powder-coat oven area',
  'Lockout-tagout step missing from the press changeover',
  'Trip hazard from extension cord across the receiving aisle'
];

const DEMO_ACTORS: readonly string[] = [
  'a1b2c3d4e5f6',
  '7890abcdef12',
  '3456789abcde',
  'f0e1d2c3b4a5',
  '0987654321ab',
  'feedfacebeef'
];

const HAZARD_CLASSES: readonly ConcernHazardClass[] = [
  'physical',
  'chemical',
  'biological',
  'ergonomic',
  'psychosocial'
];

/**
 * Build N deterministic concerns rows spanning the past 90 days.
 *
 * Status distribution:
 *   - ~25% open       — newly filed, awaiting triage
 *   - ~30% triaged    — assigned to a member for follow-up
 *   - ~30% resolved   — closed out
 *   - ~15% archived   — superseded / withdrawn
 *
 * Severity distribution:
 *   - ~35% low / ~35% medium / ~20% high / ~10% critical
 *
 * Source-protection: ~70% true (anonymous default), ~30% revealed.
 */
export function buildDemoConcerns(count: number, seed = 2024): DemoConcernRow[] {
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
  const rows: DemoConcernRow[] = [];
  for (let i = 0; i < count; i++) {
    const title = DEMO_TITLES[Math.floor(rand() * DEMO_TITLES.length)]!;
    const actor = DEMO_ACTORS[Math.floor(rand() * DEMO_ACTORS.length)]!;
    const ageMs = Math.floor(rand() * NINETY_DAYS_MS);
    const filed_at = new Date(now - ageMs).toISOString();
    const days_since_filed = Math.floor(ageMs / (24 * 60 * 60 * 1000));

    const rs = rand();
    let status: ConcernStatus;
    if (rs < 0.25) status = 'open';
    else if (rs < 0.55) status = 'triaged';
    else if (rs < 0.85) status = 'resolved';
    else status = 'archived';

    const rv = rand();
    let severity: ConcernSeverity;
    if (rv < 0.35) severity = 'low';
    else if (rv < 0.7) severity = 'medium';
    else if (rv < 0.9) severity = 'high';
    else severity = 'critical';

    const hazard_class = HAZARD_CLASSES[Math.floor(rand() * HAZARD_CLASSES.length)]!;
    const source_protected = rand() < 0.7;

    rows.push({
      id: 'con-' + i.toString().padStart(6, '0'),
      filed_at,
      title,
      status,
      severity,
      hazard_class,
      source_protected,
      days_since_filed,
      actor_pseudonym: actor
    });
  }
  rows.sort((a, b) => (a.filed_at < b.filed_at ? 1 : -1));
  return rows;
}

/** Page-based slicer — same contract as the other demo providers. */
export async function fetchDemoConcernsPage(
  page: number,
  page_size: number,
  all: DemoConcernRow[]
): Promise<DemoConcernsPage> {
  const start = page * page_size;
  return {
    rows: all.slice(start, start + page_size),
    total: all.length,
    page,
    page_size
  };
}
