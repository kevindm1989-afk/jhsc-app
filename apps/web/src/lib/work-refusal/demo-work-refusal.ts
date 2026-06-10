/**
 * Demo work-refusal provider for /work-refusal.
 *
 * Same pattern as the other register-surface demo providers:
 * deterministic synthetic data so the surface renders before the
 * work-refusal-module backend lands.
 *
 * Distinctive shape: each row carries the OHSA s. 43 stage machine
 * the viewer surfaces as a three-step gauge:
 *
 *   - 'worker_refusal'      — stage 1: the worker has refused work
 *                             they believe is dangerous (s. 43(3)).
 *   - 's43_4_investigation' — stage 2: the joint investigation with
 *                             the employer + worker member (s. 43(4)).
 *   - 's43_8_mol'           — stage 3: unresolved after investigation;
 *                             a Ministry of Labour inspector is called
 *                             in (s. 43(8)).
 *   - 'resolved'            — terminal: the refusal was resolved at
 *                             whichever stage it reached.
 *
 * Work-refusal entries are sensitivity C4 — every row carries the
 * destructive accent in the viewer and the narrative stays sealed.
 */

export type WorkRefusalStage = 'worker_refusal' | 's43_4_investigation' | 's43_8_mol' | 'resolved';

export interface DemoWorkRefusalRow {
  id: string;
  /** ISO 8601 timestamp the refusal was filed. */
  filed_at: string;
  /** Short opaque title. */
  title: string;
  /** Current s. 43 stage. */
  stage: WorkRefusalStage;
  /** Highest stage the refusal reached before resolution. Only set
   *  when stage is 'resolved' — tells the reader whether it resolved
   *  at the worker stage, the joint investigation, or the MOL. */
  resolved_at_stage: Exclude<WorkRefusalStage, 'resolved'> | null;
  /** True while the worker remains on alternative work pending the
   *  investigation (s. 43(5)). */
  alternative_work_assigned: boolean;
  /** Days elapsed since filed. */
  days_since_filed: number;
  /** Pseudonymized actor. */
  actor_pseudonym: string;
}

export interface DemoWorkRefusalPage {
  rows: DemoWorkRefusalRow[];
  total: number;
  page: number;
  page_size: number;
}

const DEMO_TITLES: readonly string[] = [
  'Refused to operate press with bypassed light curtain',
  'Refused roof work without fall-arrest anchor points',
  'Refused confined-space entry without atmosphere test',
  'Refused forklift with failing brakes on the dock ramp',
  'Refused solo night shift after threat incident',
  'Refused chemical transfer without compatible gloves',
  'Refused scaffold work after missing inspection tag',
  'Refused energized panel work without arc-flash PPE'
];

const DEMO_ACTORS: readonly string[] = [
  'a1b2c3d4e5f6',
  '7890abcdef12',
  '3456789abcde',
  'f0e1d2c3b4a5',
  '0987654321ab',
  'feedfacebeef'
];

const NON_TERMINAL_STAGES: readonly Exclude<WorkRefusalStage, 'resolved'>[] = [
  'worker_refusal',
  's43_4_investigation',
  's43_8_mol'
];

/**
 * Build N deterministic work-refusal rows spanning the past 180 days.
 *
 * Stage distribution:
 *   - ~15% worker_refusal       — fresh, pre-investigation
 *   - ~20% s43_4_investigation  — joint investigation underway
 *   - ~10% s43_8_mol            — escalated to the Ministry
 *   - ~55% resolved             — terminal (refusals resolve fast in
 *                                 practice; the register is mostly
 *                                 history)
 *
 * Resolved rows carry resolved_at_stage; active rows have it null.
 * ~60% of active rows have alternative work assigned (s. 43(5)).
 */
export function buildDemoWorkRefusals(count: number, seed = 43): DemoWorkRefusalRow[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const now = Date.now();
  const ONE_EIGHTY_DAYS_MS = 180 * 24 * 60 * 60 * 1000;
  const rows: DemoWorkRefusalRow[] = [];
  for (let i = 0; i < count; i++) {
    const title = DEMO_TITLES[Math.floor(rand() * DEMO_TITLES.length)]!;
    const actor = DEMO_ACTORS[Math.floor(rand() * DEMO_ACTORS.length)]!;
    const ageMs = Math.floor(rand() * ONE_EIGHTY_DAYS_MS);
    const filed_at = new Date(now - ageMs).toISOString();
    const days_since_filed = Math.floor(ageMs / (24 * 60 * 60 * 1000));

    const rs = rand();
    let stage: WorkRefusalStage;
    if (rs < 0.15) stage = 'worker_refusal';
    else if (rs < 0.35) stage = 's43_4_investigation';
    else if (rs < 0.45) stage = 's43_8_mol';
    else stage = 'resolved';

    const resolved_at_stage =
      stage === 'resolved'
        ? NON_TERMINAL_STAGES[Math.floor(rand() * NON_TERMINAL_STAGES.length)]!
        : null;
    const alternative_work_assigned = stage !== 'resolved' && rand() < 0.6;

    rows.push({
      id: 'wr-' + i.toString().padStart(6, '0'),
      filed_at,
      title,
      stage,
      resolved_at_stage,
      alternative_work_assigned,
      days_since_filed,
      actor_pseudonym: actor
    });
  }
  rows.sort((a, b) => (a.filed_at < b.filed_at ? 1 : -1));
  return rows;
}

/** Page-based slicer — same contract as the other demo providers. */
export async function fetchDemoWorkRefusalPage(
  page: number,
  page_size: number,
  all: DemoWorkRefusalRow[]
): Promise<DemoWorkRefusalPage> {
  const start = page * page_size;
  return {
    rows: all.slice(start, start + page_size),
    total: all.length,
    page,
    page_size
  };
}
