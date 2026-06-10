/**
 * Demo s51-evidence provider for /s51-evidence.
 *
 * Same pattern as the other register-surface demo providers:
 * deterministic synthetic data so the surface renders before the T14
 * backend wire-up lands.
 *
 * Distinctive shape: each row carries the OHSA s. 51 critical-injury
 * evidence attributes the viewer surfaces at a glance:
 *
 *   - Scene-preservation state: s. 51(2) requires the scene be
 *     preserved (nothing disturbed) until an inspector releases it
 *     or 48 hours pass. Active rows carry `hours_remaining` on the
 *     48-hour window; released/expired rows read terminal.
 *   - Photo + witness-statement counts — the "size" of the evidence
 *     bundle.
 *   - Per-entry passphrase seal — s51 evidence is sensitivity C4,
 *     same posture as the reprisal log.
 *   - Worker-member-present flag — s. 51 requires a worker member of
 *     the JHSC be present at the investigation; the register records
 *     whether that happened.
 */

export type ScenePreservationState = 'preserving' | 'released_by_inspector' | 'window_expired';

export interface DemoS51EvidenceRow {
  id: string;
  /** ISO 8601 timestamp the evidence bundle was opened. */
  opened_at: string;
  /** Short opaque title. */
  title: string;
  /** Scene-preservation state per s. 51(2). */
  scene_state: ScenePreservationState;
  /** Hours remaining on the 48-hour preservation window. Only set
   *  while scene_state is 'preserving'; null on terminal states. */
  hours_remaining: number | null;
  /** Number of sanitized photos in the bundle. */
  photo_count: number;
  /** Number of witness statements captured. */
  witness_statement_count: number;
  /** True when the bundle is sealed under a per-entry passphrase
   *  (C4 default — always true in the demo; the field exists so the
   *  real backend can surface a legacy unsealed bundle honestly). */
  per_entry_passphrase_required: boolean;
  /** s. 51 requires a worker member be present at the investigation. */
  worker_member_present: boolean;
  /** Pseudonymized actor who opened the bundle. */
  actor_pseudonym: string;
}

export interface DemoS51EvidencePage {
  rows: DemoS51EvidenceRow[];
  total: number;
  page: number;
  page_size: number;
}

const DEMO_TITLES: readonly string[] = [
  'Crush injury at the palletizer cell',
  'Fall from height at the mezzanine edge',
  'Entanglement at the conveyor transfer point',
  'Struck-by incident in the yard trailer lane',
  'Electrical contact at the distribution panel',
  'Chemical exposure at the mix station'
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
 * Build N deterministic s51-evidence rows spanning the past 365 days.
 * Critical injuries are rare; a year-long window keeps the demo
 * register honest about cadence.
 *
 * Scene-state distribution:
 *   - ~15% preserving             — active 48-hour window, hours_remaining 1..47
 *   - ~55% released_by_inspector  — inspector released the scene
 *   - ~30% window_expired         — 48 hours elapsed without release
 *
 * worker_member_present is true ~90% of the time — the ~10% false
 * case is surfaced honestly (it is itself a compliance gap worth
 * seeing in the register).
 */
export function buildDemoS51Evidence(count: number, seed = 51): DemoS51EvidenceRow[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const now = Date.now();
  const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  const rows: DemoS51EvidenceRow[] = [];
  for (let i = 0; i < count; i++) {
    const title = DEMO_TITLES[Math.floor(rand() * DEMO_TITLES.length)]!;
    const actor = DEMO_ACTORS[Math.floor(rand() * DEMO_ACTORS.length)]!;
    const ageMs = Math.floor(rand() * YEAR_MS);
    const opened_at = new Date(now - ageMs).toISOString();

    const rs = rand();
    let scene_state: ScenePreservationState;
    if (rs < 0.15) scene_state = 'preserving';
    else if (rs < 0.7) scene_state = 'released_by_inspector';
    else scene_state = 'window_expired';

    const hours_remaining = scene_state === 'preserving' ? 1 + Math.floor(rand() * 47) : null;
    const photo_count = 2 + Math.floor(rand() * 15); // 2..16
    const witness_statement_count = Math.floor(rand() * 6); // 0..5
    const worker_member_present = rand() < 0.9;

    rows.push({
      id: 's51-' + i.toString().padStart(6, '0'),
      opened_at,
      title,
      scene_state,
      hours_remaining,
      photo_count,
      witness_statement_count,
      per_entry_passphrase_required: true,
      worker_member_present,
      actor_pseudonym: actor
    });
  }
  rows.sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1));
  return rows;
}

/** Page-based slicer — same contract as the other demo providers. */
export async function fetchDemoS51EvidencePage(
  page: number,
  page_size: number,
  all: DemoS51EvidenceRow[]
): Promise<DemoS51EvidencePage> {
  const start = page * page_size;
  return {
    rows: all.slice(start, start + page_size),
    total: all.length,
    page,
    page_size
  };
}
