/**
 * T11 / G-T11-31 + G-T11-32 — drift-detector tests.
 *
 * Two pure-library/test-only hygiene closures from the second-opinion
 * review. NEW file (existing T11/T12 tests are read-only per
 * test-plan.md §6).
 *
 * G-T11-31 (second-opinion CF-8): per-kind narrowing assertions for
 * `concernDerivedFieldsForKind`. Today only the union (the export
 * pipeline tests at lines 211+ in export-pipeline.test.ts) is
 * exercised; a future drift in the canonical per-kind lists would not
 * be caught.
 *
 * G-T11-32 (second-opinion CF-9): F-25 inventory test tightening. The
 * existing assertion at `export-pipeline.test.ts:188-194` says "no
 * route declares application/pdf". Future reviewers maintaining the
 * inventory might be tempted to relax that check when unrelated
 * `application/octet-stream` etc. responses get added. This test
 * tightens to an EXPLICIT allowlist of acceptable response content
 * types per route entry — a stricter shape that fails the moment an
 * unrecognised content type appears, forcing the reviewer to either
 * extend the allowlist or remove the surprise.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestSupabase, type TestSupabase } from '../_helpers/supabase-test';
import {
  CONCERN_DERIVED_FIELD_ANNOTATIONS,
  concernDerivedFieldsForKind
} from '../../src/lib/export';

let supa: TestSupabase;
beforeEach(async () => {
  supa = await createTestSupabase();
});
afterEach(async () => {
  await supa.tearDown();
});

describe('T11 / G-T11-31 — concernDerivedFieldsForKind per-kind drift detector', () => {
  it("'minutes.final' returns the canonical pinned list (drift fails this test)", () => {
    expect(concernDerivedFieldsForKind('minutes.final')).toEqual([
      'agenda_items',
      'decisions',
      'recommendations_summary'
    ]);
  });

  it("'recommendation' returns the canonical pinned list (drift fails this test)", () => {
    expect(concernDerivedFieldsForKind('recommendation')).toEqual([
      'title',
      'body',
      'rationale'
    ]);
  });

  it('the function output matches the source CONCERN_DERIVED_FIELD_ANNOTATIONS map (no projection drift)', () => {
    expect(concernDerivedFieldsForKind('minutes.final')).toEqual(
      CONCERN_DERIVED_FIELD_ANNOTATIONS['minutes.final']
    );
    expect(concernDerivedFieldsForKind('recommendation')).toEqual(
      CONCERN_DERIVED_FIELD_ANNOTATIONS.recommendation
    );
  });

  it('per-kind output is disjoint between minutes.final and recommendation (no field overlap)', () => {
    // Defends the privacy property that the two kinds derive from
    // structurally-different concern fields. A future regression that
    // accidentally added a shared field would silently change which
    // concern data flows into which export.
    const minutes = new Set(concernDerivedFieldsForKind('minutes.final'));
    for (const f of concernDerivedFieldsForKind('recommendation')) {
      expect(minutes.has(f), `unexpected overlap field: ${f}`).toBe(false);
    }
  });
});

describe('T11 / G-T11-32 — F-25 route-inventory content-type explicit allowlist', () => {
  /**
   * Allowlist of content types ANY route in the inventory may declare.
   * Adding a new route that returns a not-yet-allowlisted content type
   * fails this test — forcing the reviewer to extend the allowlist
   * deliberately (and prove the new type is not `application/pdf` or
   * any other server-rendered binary that would re-open F-25).
   */
  const ALLOWED_RESPONSE_CONTENT_TYPES = new Set<string>([
    'application/json',
    'application/jose',
    'text/plain'
  ]);

  it('every route in the inventory declares only allowlisted content types (and never application/pdf)', () => {
    const inventory = supa.getRouteInventory();
    const violations: string[] = [];
    for (const route of inventory) {
      for (const resp of route.responses ?? []) {
        if (resp.content_type === 'application/pdf') {
          violations.push(`${route.path} declares application/pdf (F-25 violation)`);
        } else if (!ALLOWED_RESPONSE_CONTENT_TYPES.has(resp.content_type)) {
          violations.push(
            `${route.path} declares ${resp.content_type} (not on G-T11-32 allowlist; extend deliberately if intended)`
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
