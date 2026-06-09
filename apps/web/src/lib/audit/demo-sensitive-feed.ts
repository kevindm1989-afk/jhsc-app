/**
 * Demo sensitive-feed provider for /sensitive-feed's worker co-chair +
 * worker certified member viewer.
 *
 * Same posture as `demo-audit-rows.ts` but scoped to **C3/C4 sensitivity
 * tier events only**. The real backend (server-side aggregation of
 * sensitive-tier audit rows + role-gating + Merkle proofs) ships as a
 * separate, larger PR; until then this provider supplies deterministic
 * synthetic rows so a worker can see what the surface will look like.
 *
 * Sensitivity tiers covered:
 *   - C3 (committee-encrypted): concerns, minutes drafts, inspections,
 *     recommendations.
 *   - C4 (highest sensitivity): reprisal log, work refusal (s.43),
 *     critical injury (s.51), source identity.
 *
 * Out of scope here (handled by the real provider later):
 *   - Server-side role gating (the worker co-chair + worker certified
 *     member see this; an ordinary member sees only their own actions).
 *   - Real Merkle proofs.
 *   - Cursor-based pagination.
 *
 * The shape is intentionally close to DemoAuditRow so the viewer
 * components share a row-renderer; the only addition is `sensitivity`
 * (C3 / C4 tier marker), which the viewer uses to color-band the row.
 */

import type { DemoAuditRow, DemoAuditPage } from './demo-audit-rows';

/** A sensitive-feed row — the audit-row shape plus a sensitivity tier. */
export interface DemoSensitiveRow extends DemoAuditRow {
  sensitivity: 'c3' | 'c4';
}

export interface DemoSensitivePage {
  rows: DemoSensitiveRow[];
  total: number;
  page: number;
  page_size: number;
}

/**
 * C3 events — committee-encrypted content. Audit rows from these
 * surfaces never include the encrypted body, only metadata about the
 * action (e.g. "a concern was filed", "minutes draft updated").
 */
const C3_EVENTS: readonly string[] = [
  'concern.created',
  'concern.updated',
  'minutes.draft_created',
  'minutes.draft_updated',
  'inspection.submitted',
  'recommendation.created',
  'recommendation.responded'
];

/**
 * C4 events — the highest sensitivity tier. The audit row carries the
 * pseudonymized actor + the event type ONLY; the narrative content
 * stays encrypted with a per-entry passphrase.
 */
const C4_EVENTS: readonly string[] = [
  'reprisal.created',
  'reprisal.updated',
  'reprisal.source_revealed',
  'work_refusal.created',
  'work_refusal.stage_advanced',
  's51_evidence.created',
  's51_evidence.scene_preserved'
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
 * Per-event meta sketches — keys short + values opaque, mirroring the
 * audit-log demo. The real backend's response shape is the same; the
 * viewer's chip-row layout works for any small object.
 */
const META_BY_EVENT: Record<string, () => Record<string, string | number | boolean | null>> = {
  'concern.created': () => ({ hazard_class: 'physical', severity: 'medium' }),
  'concern.updated': () => ({ concern_id: 'con-' + Math.floor(Math.random() * 999) }),
  'minutes.draft_created': () => ({ draft_id: 'min-' + Math.floor(Math.random() * 99) }),
  'minutes.draft_updated': () => ({ draft_id: 'min-' + Math.floor(Math.random() * 99) }),
  'inspection.submitted': () => ({ inspection_id: 'ins-' + Math.floor(Math.random() * 99) }),
  'recommendation.created': () => ({ rec_id: 'rec-' + Math.floor(Math.random() * 99) }),
  'recommendation.responded': () => ({
    rec_id: 'rec-' + Math.floor(Math.random() * 99),
    days_to_respond: Math.floor(Math.random() * 21)
  }),
  'reprisal.created': () => ({
    reprisal_id: 'rep-' + Math.floor(Math.random() * 99),
    consent_kept: true
  }),
  'reprisal.updated': () => ({ reprisal_id: 'rep-' + Math.floor(Math.random() * 99) }),
  'reprisal.source_revealed': () => ({ reprisal_id: 'rep-' + Math.floor(Math.random() * 99) }),
  'work_refusal.created': () => ({ stage: 'worker_refusal', section: 's43' }),
  'work_refusal.stage_advanced': () => ({ stage: 's43_4_investigation', section: 's43' }),
  's51_evidence.created': () => ({ photo_count: Math.floor(Math.random() * 4) }),
  's51_evidence.scene_preserved': () => ({ hours_remaining: 48 })
};

/**
 * Build a deterministic synthetic dataset of N sensitive-feed rows
 * spanning the past N days. The seed defaults to a fixed value so the
 * surface is stable across renders; tests vary the seed to assert
 * deterministic content.
 */
export function buildDemoSensitiveRows(count: number, seed = 1066): DemoSensitiveRow[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const now = Date.now();
  const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
  const rows: DemoSensitiveRow[] = [];
  for (let i = 0; i < count; i++) {
    // ~35% C4 events; the rest C3. Mirrors real-world: most committee
    // activity is concerns/inspections, with reprisal/s43/s51 being
    // the rarer (and graver) end of the tail.
    const isC4 = rand() < 0.35;
    const pool = isC4 ? C4_EVENTS : C3_EVENTS;
    const ev = pool[Math.floor(rand() * pool.length)]!;
    const actor = DEMO_ACTORS[Math.floor(rand() * DEMO_ACTORS.length)]!;
    const ago = Math.floor(rand() * FOURTEEN_DAYS_MS);
    const ts = new Date(now - ago).toISOString();
    rows.push({
      id: 'srow-' + i.toString().padStart(6, '0'),
      ts,
      event_type: ev,
      actor_pseudonym: actor,
      meta: META_BY_EVENT[ev]!(),
      sensitivity: isC4 ? 'c4' : 'c3'
    });
  }
  rows.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return rows;
}

/** Page-based slicer — same contract as fetchDemoAuditPage. */
export async function fetchDemoSensitivePage(
  page: number,
  page_size: number,
  all: DemoSensitiveRow[]
): Promise<DemoSensitivePage> {
  const start = page * page_size;
  return {
    rows: all.slice(start, start + page_size),
    total: all.length,
    page,
    page_size
  };
}

/** Re-export DemoAuditPage in case a consumer wants the audit shape. */
export type { DemoAuditPage };
