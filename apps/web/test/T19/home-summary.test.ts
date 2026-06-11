/**
 * T19.1 — buildHomeSummary (pure cross-register count function).
 */

import { describe, expect, it } from 'vitest';
import {
  buildHomeSummary,
  ZERO_SUMMARY,
  type HomeSummaryInputs
} from '../../src/lib/home/home-summary';
import { buildDemoConcerns } from '../../src/lib/concerns/demo-concerns';
import { buildDemoRecommendations } from '../../src/lib/recommendations/demo-recommendations';
import { buildDemoTraining } from '../../src/lib/training/demo-training';
import { buildDemoWorkRefusals } from '../../src/lib/work-refusal/demo-work-refusal';
import { buildDemoS51Evidence } from '../../src/lib/s51-evidence/demo-s51-evidence';

const EMPTY_INPUTS: HomeSummaryInputs = {
  concerns: [],
  recommendations: [],
  training: [],
  workRefusals: [],
  s51Evidence: []
};

describe('T19.1 — buildHomeSummary', () => {
  it('returns all zeros when every input is empty', () => {
    expect(buildHomeSummary(EMPTY_INPUTS)).toEqual(ZERO_SUMMARY);
  });

  it('counts open concerns only (ignores triaged/resolved/archived)', () => {
    const result = buildHomeSummary({
      ...EMPTY_INPUTS,
      concerns: [
        mkConcern('a', 'open'),
        mkConcern('b', 'open'),
        mkConcern('c', 'triaged'),
        mkConcern('d', 'resolved'),
        mkConcern('e', 'archived')
      ]
    });
    expect(result.openConcerns).toBe(2);
  });

  it('counts overdue recommendations only (ignores responded/pending/archived)', () => {
    const result = buildHomeSummary({
      ...EMPTY_INPUTS,
      recommendations: [
        mkRec('a', 'overdue'),
        mkRec('b', 'overdue'),
        mkRec('c', 'overdue'),
        mkRec('d', 'pending'),
        mkRec('e', 'responded')
      ]
    });
    expect(result.overdueRecommendations).toBe(3);
  });

  it('counts expired training only (ignores valid/expiring)', () => {
    const result = buildHomeSummary({
      ...EMPTY_INPUTS,
      training: [mkTrn('a', 'valid'), mkTrn('b', 'expiring'), mkTrn('c', 'expired')]
    });
    expect(result.expiredTraining).toBe(1);
  });

  it('counts active refusals as anything that is not resolved', () => {
    const result = buildHomeSummary({
      ...EMPTY_INPUTS,
      workRefusals: [
        mkRefusal('a', 'worker_refusal'),
        mkRefusal('b', 's43_4_investigation'),
        mkRefusal('c', 's43_8_mol'),
        mkRefusal('d', 'resolved')
      ]
    });
    expect(result.activeRefusals).toBe(3);
  });

  it('counts preserving s51 scenes only (ignores released/expired)', () => {
    const result = buildHomeSummary({
      ...EMPTY_INPUTS,
      s51Evidence: [
        mkS51('a', 'preserving'),
        mkS51('b', 'released_by_inspector'),
        mkS51('c', 'window_expired')
      ]
    });
    expect(result.preservingScenes).toBe(1);
  });

  it('currentMonthActivity defaults to 0 when not supplied (so the field is always defined)', () => {
    const result = buildHomeSummary(EMPTY_INPUTS);
    expect(result.currentMonthActivity).toBe(0);
  });

  it('currentMonthActivity passes through verbatim when supplied', () => {
    const result = buildHomeSummary({ ...EMPTY_INPUTS, currentMonthActivity: 42 });
    expect(result.currentMonthActivity).toBe(42);
  });

  it('produces a stable summary against the real demo providers (smoke test)', () => {
    const summary = buildHomeSummary({
      concerns: buildDemoConcerns(50),
      recommendations: buildDemoRecommendations(50),
      training: buildDemoTraining(50),
      workRefusals: buildDemoWorkRefusals(50),
      s51Evidence: buildDemoS51Evidence(30)
    });
    // None of the counts can be negative; at least one count should be
    // nonzero across this sample size (the demo distributions guarantee
    // a realistic mix of in-progress states).
    for (const value of Object.values(summary)) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
    const totalNonZero = Object.values(summary).reduce((acc, n) => acc + (n > 0 ? 1 : 0), 0);
    expect(totalNonZero).toBeGreaterThan(0);
  });
});

// --- factories (kept tiny — only the fields the summariser reads matter) ---

function mkConcern(
  id: string,
  status: 'open' | 'triaged' | 'resolved' | 'archived'
): import('../../src/lib/concerns/demo-concerns').DemoConcernRow {
  return {
    id,
    filed_at: '2026-06-01T00:00:00.000Z',
    title: 'x',
    status,
    severity: 'low',
    hazard_class: 'physical',
    source_protected: true,
    days_since_filed: 1,
    actor_pseudonym: 'a1b2c3d4e5f6'
  };
}

function mkRec(
  id: string,
  status: 'responded' | 'pending' | 'overdue' | 'archived'
): import('../../src/lib/recommendations/demo-recommendations').DemoRecommendationRow {
  return {
    id,
    title: 'x',
    filed_at: '2026-06-01T00:00:00.000Z',
    days_elapsed: 1,
    status,
    traceability_concern_id: 'con-1',
    traceability_inspection_id: null,
    actor_pseudonym: 'a1b2c3d4e5f6'
  };
}

function mkTrn(
  id: string,
  validity: 'valid' | 'expiring' | 'expired'
): import('../../src/lib/training/demo-training').DemoTrainingRow {
  return {
    id,
    certification: 'x',
    member_pseudonym: 'a1b2c3d4e5f6',
    completed_at: '2026-06-01T00:00:00.000Z',
    validity,
    days_to_expiry: 1,
    evidence_attached: true
  };
}

function mkRefusal(
  id: string,
  stage: 'worker_refusal' | 's43_4_investigation' | 's43_8_mol' | 'resolved'
): import('../../src/lib/work-refusal/demo-work-refusal').DemoWorkRefusalRow {
  return {
    id,
    filed_at: '2026-06-01T00:00:00.000Z',
    title: 'x',
    stage,
    resolved_at_stage: stage === 'resolved' ? 'worker_refusal' : null,
    alternative_work_assigned: false,
    days_since_filed: 1,
    actor_pseudonym: 'a1b2c3d4e5f6'
  };
}

function mkS51(
  id: string,
  scene_state: 'preserving' | 'released_by_inspector' | 'window_expired'
): import('../../src/lib/s51-evidence/demo-s51-evidence').DemoS51EvidenceRow {
  return {
    id,
    opened_at: '2026-06-01T00:00:00.000Z',
    title: 'x',
    scene_state,
    hours_remaining: scene_state === 'preserving' ? 24 : null,
    photo_count: 1,
    witness_statement_count: 0,
    per_entry_passphrase_required: true,
    worker_member_present: true,
    actor_pseudonym: 'a1b2c3d4e5f6'
  };
}
