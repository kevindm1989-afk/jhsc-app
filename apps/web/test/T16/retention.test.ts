/**
 * T16 — Retention job + per-event-type audit-log retention schedule.
 *
 * Source obligations:
 *   - ADR-0015 (HG-14) — per-event-type retention schedule (the verbatim
 *     table); schedule lives in `audit_log_retention_schedule`;
 *     `audit_log.retention_class` column populated by `audit_emit` at write;
 *     CHECK constraint references the schedule; CI drift assertion.
 *   - Underlying-record-ceiling rule (privacy-review §3.5): audit-log rows
 *     linked via target_id MUST NOT outlive the linked record by more than
 *     30 days. `retention.deleted` summary rows are exempt (no target_id;
 *     independent 7y retention).
 *   - privacy-review §7 obligations 7–11 (highest-priority for T16):
 *     7  per-event retention schedule honored
 *     8  audit-row-cannot-outlive-target rule
 *     9  retention.deleted summary at 7y
 *     10 schedule table vs enum drift
 *     11 retention.deleted per-event-type counts
 *   - threat-model §8 T16 — F-51 (dry-run + alert on >N rows), F-52 (one
 *     summary row per pass, hash-chained).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freezeClock, advanceTo, restoreClock } from '../_helpers/clock';
import { createTestSupabase, type TestSupabase } from '../_helpers/supabase-test';
import { SYNTHETIC_USER_A, SYNTHETIC_CONCERN_ID } from '../_helpers/fixtures';

let supa: TestSupabase;

beforeEach(async () => {
  freezeClock('2026-05-22T14:00:00.000Z');
  supa = await createTestSupabase();
});
afterEach(async () => {
  restoreClock();
  await supa.tearDown();
});

// ============================================================================
// privacy-review §7 obligation 7 — per-event retention schedule honored
// ============================================================================

describe('T16 / HG-14 / ADR-0015 / privacy-review §7 obligation 7 — per-event retention schedule', () => {
  // Fixtures cover ages 89d, 91d, 23mo, 25mo, 6y 11mo, 7y 1mo across the
  // event-type vocabulary, mapped to ADR-0015's authoritative table.
  const SCENARIOS: Array<{
    event_type: string;
    expect_deleted_at_age: string;
    keep_at_age: string[];
    deleted_at_age: string[];
  }> = [
    // 90d retentions (auth.passkey.enrolled, auth.passkey.revoked, session.revoked,
    // client.cache_policy_violation, client.identity_selftest_fail):
    { event_type: 'auth.passkey.enrolled', expect_deleted_at_age: '91d', keep_at_age: ['89d'], deleted_at_age: ['91d', '23mo', '25mo', '6y 11mo', '7y 1mo'] },
    { event_type: 'auth.passkey.revoked', expect_deleted_at_age: '91d', keep_at_age: ['89d'], deleted_at_age: ['91d'] },
    { event_type: 'session.revoked', expect_deleted_at_age: '91d', keep_at_age: ['89d'], deleted_at_age: ['91d'] },
    { event_type: 'client.cache_policy_violation', expect_deleted_at_age: '91d', keep_at_age: ['89d'], deleted_at_age: ['91d'] },
    { event_type: 'client.identity_selftest_fail', expect_deleted_at_age: '91d', keep_at_age: ['89d'], deleted_at_age: ['91d'] },
    // 24mo retentions (committee_data_key.unwrap, alert.fired,
    // identity_privkey.recovery_blob.* including .viewed):
    { event_type: 'committee_data_key.unwrap', expect_deleted_at_age: '25mo', keep_at_age: ['89d', '23mo'], deleted_at_age: ['25mo', '6y 11mo'] },
    { event_type: 'alert.fired', expect_deleted_at_age: '25mo', keep_at_age: ['89d', '23mo'], deleted_at_age: ['25mo'] },
    { event_type: 'identity_privkey.recovery_blob.viewed', expect_deleted_at_age: '25mo', keep_at_age: ['89d', '23mo'], deleted_at_age: ['25mo'] },
    { event_type: 'identity_privkey.recovery_blob.written', expect_deleted_at_age: '25mo', keep_at_age: ['89d', '23mo'], deleted_at_age: ['25mo'] },
    { event_type: 'identity_privkey.recovery_blob.restored', expect_deleted_at_age: '25mo', keep_at_age: ['89d', '23mo'], deleted_at_age: ['25mo'] },
    // 7y retentions (rotation, key-history, member-events, exports,
    // audit.forensic_reveal.4eyes_*, retention.deleted, identity_keypair.created):
    { event_type: 'identity_keypair.created', expect_deleted_at_age: '7y 1mo', keep_at_age: ['89d', '23mo', '6y 11mo'], deleted_at_age: ['7y 1mo'] },
    { event_type: 'committee_data_key.wrapped_for_member', expect_deleted_at_age: '7y 1mo', keep_at_age: ['89d', '6y 11mo'], deleted_at_age: ['7y 1mo'] },
    { event_type: 'committee_data_key.rotation.started', expect_deleted_at_age: '7y 1mo', keep_at_age: ['6y 11mo'], deleted_at_age: ['7y 1mo'] },
    { event_type: 'committee_data_key.rotation.completed', expect_deleted_at_age: '7y 1mo', keep_at_age: ['6y 11mo'], deleted_at_age: ['7y 1mo'] },
    { event_type: 'committee_data_key.member_revoked', expect_deleted_at_age: '7y 1mo', keep_at_age: ['6y 11mo'], deleted_at_age: ['7y 1mo'] },
    { event_type: 'export.generated', expect_deleted_at_age: '7y 1mo', keep_at_age: ['6y 11mo'], deleted_at_age: ['7y 1mo'] },
    { event_type: 'export.contained_concern_derived_items', expect_deleted_at_age: '7y 1mo', keep_at_age: ['6y 11mo'], deleted_at_age: ['7y 1mo'] },
    { event_type: 'audit.forensic_reveal.4eyes_pending', expect_deleted_at_age: '7y 1mo', keep_at_age: ['6y 11mo'], deleted_at_age: ['7y 1mo'] },
    { event_type: 'audit.forensic_reveal.4eyes_completed', expect_deleted_at_age: '7y 1mo', keep_at_age: ['6y 11mo'], deleted_at_age: ['7y 1mo'] },
  ];

  it.each(SCENARIOS)(
    'T16 / privacy-review §7 obligation 7 — event_type `$event_type` is retained at expected ages and deleted at expected ages',
    async ({ event_type, keep_at_age, deleted_at_age }) => {
      // Fixture: seed one audit row of this event_type at each age.
      const ages = [...keep_at_age, ...deleted_at_age];
      for (const age of ages) {
        await supa.__seedAuditRowAtAge(event_type, age);
      }
      // Dry run.
      const dry = await supa.retentionService.runDryRun();
      const dryDeleted = dry.deletion_set.filter((r) => r.event_type === event_type);
      const dryDeletedAges = dryDeleted.map((r) => r.age).sort();
      expect(dryDeletedAges).toEqual([...deleted_at_age].sort());
      // Live run.
      await supa.retentionService.runOnce();
      const remaining = await supa.adminQuery(
        `SELECT age_label FROM audit_log_test_view WHERE event_type = $1`,
        [event_type]
      );
      expect(remaining.rows.map((r: any) => r.age_label).sort()).toEqual(
        [...keep_at_age].sort()
      );
    }
  );

  it('T16 / ADR-0015 — match-underlying-record rule: a concern.created audit row with target_id=X is retained while concern X exists', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    const concernId = await supa.client(member).insertConcern({
      title: 'x',
      body: 'b',
      anonymous: true,
      hazard_class: 'physical',
      severity: 'medium',
      location_id: 'loc-1',
    });
    // Backdate the audit row + concern by 2 years (well past the simple
    // 24mo filter; should NOT be deleted because the underlying record lives).
    await supa.adminQuery(
      `UPDATE audit_log SET ts = now() - interval '2 years' WHERE event_type = 'concern.created' AND target_id = $1`,
      [concernId]
    );
    await supa.adminQuery(`UPDATE concerns SET created_at = now() - interval '2 years' WHERE id = $1`, [
      concernId,
    ]);
    await supa.retentionService.runOnce();
    const r = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'concern.created' AND target_id = $1`,
      [concernId]
    );
    expect(r.rows[0].n).toBe(1);
  });
});

// ============================================================================
// privacy-review §7 obligation 8 — audit-row-cannot-outlive-target rule
// ============================================================================

describe('T16 / privacy-review §7 obligation 8 — underlying-record-ceiling (30-day buffer)', () => {
  it('T16 / §3.5 ceiling — orphaned audit row whose target concern was hard-deleted >30d ago is queued for deletion on next pass', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    const concernId = await supa.client(member).insertConcern({
      title: 'x',
      body: 'b',
      anonymous: true,
      hazard_class: 'physical',
      severity: 'medium',
      location_id: 'loc-1',
    });
    // Delete the underlying concern row 31 days ago (via retention).
    await supa.adminQuery(`DELETE FROM concerns WHERE id = $1`, [concernId]);
    await supa.adminQuery(
      `UPDATE audit_log SET ts = now() - interval '30 days' WHERE event_type = 'concern.created' AND target_id = $1`,
      [concernId]
    );
    advanceTo(Date.parse('2026-05-22T14:00:00.000Z') + 31 * 24 * 3600 * 1000);
    await supa.retentionService.runOnce();
    const r = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE target_id = $1`,
      [concernId]
    );
    expect(r.rows[0].n).toBe(0);
  });

  it('T16 / §3.5 ceiling — within the 30-day buffer, the orphaned audit row is NOT yet deleted', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    const concernId = await supa.client(member).insertConcern({
      title: 'x',
      body: 'b',
      anonymous: true,
      hazard_class: 'physical',
      severity: 'medium',
      location_id: 'loc-1',
    });
    await supa.adminQuery(`DELETE FROM concerns WHERE id = $1`, [concernId]);
    // 25 days < 30-day buffer.
    advanceTo(Date.parse('2026-05-22T14:00:00.000Z') + 25 * 24 * 3600 * 1000);
    await supa.retentionService.runOnce();
    const r = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE target_id = $1`,
      [concernId]
    );
    expect(r.rows[0].n).toBe(1);
  });
});

// ============================================================================
// privacy-review §7 obligation 9 — retention.deleted summary retention
// ============================================================================

describe('T16 / privacy-review §7 obligation 9 — retention.deleted summary retention is 7y AND carve-out from ceiling', () => {
  it('T16 / ADR-0015 carve-out — a retention.deleted row from 6 years ago is NOT deleted (7y retention applies; no target_id ⇒ ceiling rule N/A)', async () => {
    await supa.__seedAuditRowAtAge('retention.deleted', '6y 11mo');
    await supa.retentionService.runOnce();
    const r = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'retention.deleted' AND age_label = '6y 11mo'`
    );
    expect(r.rows[0].n).toBe(1);
  });

  it('T16 / ADR-0015 — a retention.deleted row from 7y 1mo IS deleted', async () => {
    await supa.__seedAuditRowAtAge('retention.deleted', '7y 1mo');
    await supa.retentionService.runOnce();
    const r = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'retention.deleted' AND age_label = '7y 1mo'`
    );
    expect(r.rows[0].n).toBe(0);
  });
});

// ============================================================================
// privacy-review §7 obligation 10 — schedule table vs enum drift
// ============================================================================

describe('T16 / privacy-review §7 obligation 10 — schedule-table vs enum drift CI assertion', () => {
  it('T16 / ADR-0015 — every value in event_type CHECK has exactly one row in audit_log_retention_schedule, and vice versa', async () => {
    const enumValues = await supa.adminQuery(
      `SELECT __test_get_audit_event_type_enum_values() AS values`
    );
    const scheduleRows = await supa.adminQuery(
      `SELECT event_type FROM audit_log_retention_schedule`
    );
    const enumSet = new Set<string>(enumValues.rows[0].values);
    const scheduleSet = new Set<string>(scheduleRows.rows.map((r: any) => r.event_type));
    expect([...scheduleSet].sort()).toEqual([...enumSet].sort());
  });

  it('T16 / ADR-0015 — adding a phantom enum value without a corresponding schedule row fails CI drift check', async () => {
    await supa.adminQuery(`SELECT __test_add_phantom_enum_value('not.a.real.event')`);
    const driftCheck = await supa.retentionService.runDriftCheck();
    expect(driftCheck.ok).toBe(false);
    expect(driftCheck.missing_schedule_for).toContain('not.a.real.event');
    await supa.adminQuery(`SELECT __test_drop_phantom_enum_value('not.a.real.event')`);
  });

  it('T16 / ADR-0015 — adding a phantom schedule row without an enum value fails drift check', async () => {
    await supa.adminQuery(
      `SELECT __test_add_phantom_schedule_row('not.a.real.event', '30 days'::interval)`
    );
    const driftCheck = await supa.retentionService.runDriftCheck();
    expect(driftCheck.ok).toBe(false);
    expect(driftCheck.orphan_schedule_rows).toContain('not.a.real.event');
    await supa.adminQuery(
      `SELECT __test_drop_phantom_schedule_row('not.a.real.event')`
    );
  });
});

// ============================================================================
// privacy-review §7 obligation 11 — retention.deleted per-event-type counts
// ============================================================================

describe('T16 / privacy-review §7 obligation 11 — retention.deleted jsonb per-event-type counts', () => {
  it('T16 / ADR-0015 — running a pass that deletes 3 distinct event-types writes a retention.deleted row with `meta.deleted_per_table.audit_log_per_event_type = {evt: count}`', async () => {
    await supa.__seedAuditRowAtAge('auth.passkey.enrolled', '91d');
    await supa.__seedAuditRowAtAge('auth.passkey.enrolled', '91d');
    await supa.__seedAuditRowAtAge('session.revoked', '91d');
    await supa.__seedAuditRowAtAge('alert.fired', '25mo');
    await supa.retentionService.runOnce();
    const rows = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'retention.deleted' ORDER BY id DESC LIMIT 1`
    );
    const summary = rows.rows[0].meta.deleted_per_table.audit_log_per_event_type;
    expect(summary).toEqual({
      'auth.passkey.enrolled': 2,
      'session.revoked': 1,
      'alert.fired': 1,
    });
  });
});

// ============================================================================
// F-51 — Dry-run is the default; live run alerts if >N rows would delete
// ============================================================================

describe('T16 / F-51 — dry-run default + volume alert', () => {
  it('T16 / F-51 — retention-job dry-run is the default in CI tests; assert no rows actually deleted', async () => {
    await supa.__seedAuditRowAtAge('auth.passkey.enrolled', '91d');
    await supa.__seedAuditRowAtAge('auth.passkey.enrolled', '91d');
    const dry = await supa.retentionService.runDryRun();
    expect(dry.deletion_set.length).toBe(2);
    const after = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'auth.passkey.enrolled'`
    );
    expect(after.rows[0].n).toBe(2);
  });

  it('T16 / F-51 — live run alerts if would-delete > 20 rows (configurable threshold; default 20)', async () => {
    for (let i = 0; i < 25; i++) {
      await supa.__seedAuditRowAtAge('auth.passkey.enrolled', '91d');
    }
    const r = await supa.retentionService.runOnce({ live: true });
    expect(r.alert_fired).toBe(true);
    expect(r.alert_id).toMatch(/A-RETENTION|retention/);
  });
});

// ============================================================================
// F-52 — Each retention pass writes exactly one summary row, hash-chained
// ============================================================================

describe('T16 / F-52 — retention.deleted single summary row per pass, hash-chained', () => {
  it('T16 / F-52 — one summary row per pass; no per-deleted-row audit rows', async () => {
    await supa.__seedAuditRowAtAge('auth.passkey.enrolled', '91d');
    await supa.__seedAuditRowAtAge('auth.passkey.enrolled', '91d');
    const before = await supa.adminQuery(`SELECT count(*)::int AS n FROM audit_log`);
    await supa.retentionService.runOnce();
    const after = await supa.adminQuery(`SELECT count(*)::int AS n FROM audit_log`);
    // before - 2 deleted + 1 summary = before - 1
    expect(after.rows[0].n).toBe(before.rows[0].n - 1);
    const summaries = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'retention.deleted'`
    );
    expect(summaries.rows[0].n).toBe(1);
  });

  it('T16 / F-52 — summary row hash-chains to the prior tail of audit_log', async () => {
    await supa.__seedAuditRowAtAge('auth.passkey.enrolled', '91d');
    const priorTail = await supa.adminQuery(
      `SELECT hash FROM audit_log WHERE event_type != 'retention.deleted' ORDER BY id DESC LIMIT 1`
    );
    await supa.retentionService.runOnce();
    const summary = await supa.adminQuery(
      `SELECT prev_hash FROM audit_log WHERE event_type = 'retention.deleted' ORDER BY id DESC LIMIT 1`
    );
    expect(summary.rows[0].prev_hash).toEqual(priorTail.rows[0].hash);
  });
});
