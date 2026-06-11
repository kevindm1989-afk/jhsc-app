/**
 * Home dashboard summary — derives the cross-register "needs attention"
 * counts the worker sees on the signed-in landing page.
 *
 * The five tiles surface signals that benefit from a single front-door
 * view (rather than discovering each register one at a time):
 *
 *   - openConcerns         — `status === 'open'` concerns
 *   - overdueRecommendations — `status === 'overdue'` recommendations
 *                              (OHSA s. 50(7)(c) 21-day timer expired)
 *   - expiredTraining      — `validity === 'expired'` training records
 *   - activeRefusals       — work refusals where stage !== 'resolved'
 *   - preservingScenes     — s51-evidence where scene is still being
 *                            preserved (the 48-hour window is live)
 *
 * Keeping the summariser as a pure function over already-loaded row
 * arrays means the dashboard tests can hand it deterministic input;
 * the route page just stitches demo providers together to feed it.
 */

import type { DemoConcernRow } from '../concerns/demo-concerns';
import type { DemoRecommendationRow } from '../recommendations/demo-recommendations';
import type { DemoTrainingRow } from '../training/demo-training';
import type { DemoWorkRefusalRow } from '../work-refusal/demo-work-refusal';
import type { DemoS51EvidenceRow } from '../s51-evidence/demo-s51-evidence';

export interface HomeSummary {
  openConcerns: number;
  overdueRecommendations: number;
  expiredTraining: number;
  activeRefusals: number;
  preservingScenes: number;
  /**
   * Total rows across every register filed in the current calendar
   * month. Populated by the route page using
   * `buildMonthlyReport(toMonthString(new Date()))`. Powers the
   * "Monthly activity" tile that deep-links into /report.
   */
  currentMonthActivity: number;
  /**
   * Total for the same month a year earlier. Optional; when present
   * the dashboard tile renders a YoY delta indicator matching
   * /report's tile YoY pattern.
   */
  priorMonthActivity: number;
  /**
   * 12-month trailing activity series (oldest → newest). Empty
   * array suppresses the dashboard tile sparkline.
   */
  monthlyActivityTrailing: readonly number[];
}

export interface HomeSummaryInputs {
  concerns: readonly DemoConcernRow[];
  recommendations: readonly DemoRecommendationRow[];
  training: readonly DemoTrainingRow[];
  workRefusals: readonly DemoWorkRefusalRow[];
  s51Evidence: readonly DemoS51EvidenceRow[];
  /**
   * Optional pre-computed current-month activity total. Passed in
   * rather than computed here so this module stays free of the
   * cross-register `$lib/report/aggregate` import (which would pull
   * in all eight demo providers transitively).
   */
  currentMonthActivity?: number;
  /** Optional same-month-last-year total for the YoY indicator. */
  priorMonthActivity?: number;
  /**
   * Optional 12-month trailing activity series (oldest → newest)
   * ending at the current month. Powers a mini-sparkline on the
   * /report dashboard tile. Empty array suppresses the sparkline.
   */
  monthlyActivityTrailing?: readonly number[];
}

export function buildHomeSummary(inputs: HomeSummaryInputs): HomeSummary {
  return {
    openConcerns: inputs.concerns.filter((r) => r.status === 'open').length,
    overdueRecommendations: inputs.recommendations.filter((r) => r.status === 'overdue').length,
    expiredTraining: inputs.training.filter((r) => r.validity === 'expired').length,
    activeRefusals: inputs.workRefusals.filter((r) => r.stage !== 'resolved').length,
    preservingScenes: inputs.s51Evidence.filter((r) => r.scene_state === 'preserving').length,
    currentMonthActivity: inputs.currentMonthActivity ?? 0,
    priorMonthActivity: inputs.priorMonthActivity ?? 0,
    monthlyActivityTrailing: inputs.monthlyActivityTrailing ?? []
  };
}

/** Empty summary — used by tests + as a safe default. */
export const ZERO_SUMMARY: HomeSummary = {
  openConcerns: 0,
  overdueRecommendations: 0,
  expiredTraining: 0,
  activeRefusals: 0,
  preservingScenes: 0,
  currentMonthActivity: 0,
  priorMonthActivity: 0,
  monthlyActivityTrailing: []
};
