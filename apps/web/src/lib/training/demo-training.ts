/**
 * Demo training-records provider for /training.
 *
 * Same pattern as the other register-surface demo providers:
 * deterministic synthetic data so the surface renders before the
 * training-records-module backend lands.
 *
 * Distinctive shape: each row is one member's certification record.
 * The viewer surfaces:
 *
 *   - Certification name (Certification Part One / Part Two, WHMIS,
 *     First Aid, Working at Heights, JHSC orientation).
 *   - Validity state: valid / expiring (≤60 days left) / expired.
 *     The state pin colour-codes so the refresher backlog reads at a
 *     glance — this is the surface's whole job (OHSA s. 9(12)(d)
 *     certified-member tracking + refresher alerts).
 *   - Days-until-expiry counter for valid + expiring rows; days-
 *     overdue for expired rows.
 *   - Evidence-attached flag (certificate scan on file).
 *   - Pseudonymized member.
 */

export type TrainingValidity = 'valid' | 'expiring' | 'expired';

export interface DemoTrainingRow {
  id: string;
  /** Certification name. */
  certification: string;
  /** Pseudonymized member the record belongs to. */
  member_pseudonym: string;
  /** ISO 8601 completion date. */
  completed_at: string;
  /** Validity state derived from expiry. */
  validity: TrainingValidity;
  /** Days until expiry (valid/expiring) or days since expiry
   *  (expired — still positive; the validity field disambiguates). */
  days_to_expiry: number;
  /** True when a certificate scan is attached as evidence. */
  evidence_attached: boolean;
}

export interface DemoTrainingPage {
  rows: DemoTrainingRow[];
  total: number;
  page: number;
  page_size: number;
}

const CERTIFICATIONS: readonly string[] = [
  'Certification Part One (basic)',
  'Certification Part Two (workplace-specific)',
  'WHMIS 2015',
  'Standard First Aid + CPR-C',
  'Working at Heights',
  'JHSC member orientation'
];

const DEMO_MEMBERS: readonly string[] = [
  'a1b2c3d4e5f6',
  '7890abcdef12',
  '3456789abcde',
  'f0e1d2c3b4a5',
  '0987654321ab',
  'feedfacebeef'
];

/**
 * Build N deterministic training rows.
 *
 * Validity distribution:
 *   - ~60% valid    — days_to_expiry 61..720
 *   - ~25% expiring — days_to_expiry 1..60
 *   - ~15% expired  — days_to_expiry 1..180 (days SINCE expiry)
 *
 * Evidence attached ~85% of the time.
 * Completion dates span the past 2 years.
 */
export function buildDemoTraining(count: number, seed = 912): DemoTrainingRow[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const now = Date.now();
  const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;
  const rows: DemoTrainingRow[] = [];
  for (let i = 0; i < count; i++) {
    const certification = CERTIFICATIONS[Math.floor(rand() * CERTIFICATIONS.length)]!;
    const member = DEMO_MEMBERS[Math.floor(rand() * DEMO_MEMBERS.length)]!;
    const ageMs = Math.floor(rand() * TWO_YEARS_MS);
    const completed_at = new Date(now - ageMs).toISOString();

    const rv = rand();
    let validity: TrainingValidity;
    let days_to_expiry: number;
    if (rv < 0.6) {
      validity = 'valid';
      days_to_expiry = 61 + Math.floor(rand() * 660); // 61..720
    } else if (rv < 0.85) {
      validity = 'expiring';
      days_to_expiry = 1 + Math.floor(rand() * 60); // 1..60
    } else {
      validity = 'expired';
      days_to_expiry = 1 + Math.floor(rand() * 180); // days SINCE expiry
    }

    const evidence_attached = rand() < 0.85;

    rows.push({
      id: 'trn-' + i.toString().padStart(6, '0'),
      certification,
      member_pseudonym: member,
      completed_at,
      validity,
      days_to_expiry,
      evidence_attached
    });
  }
  rows.sort((a, b) => (a.completed_at < b.completed_at ? 1 : -1));
  return rows;
}

/** Page-based slicer — same contract as the other demo providers. */
export async function fetchDemoTrainingPage(
  page: number,
  page_size: number,
  all: DemoTrainingRow[]
): Promise<DemoTrainingPage> {
  const start = page * page_size;
  return {
    rows: all.slice(start, start + page_size),
    total: all.length,
    page,
    page_size
  };
}
