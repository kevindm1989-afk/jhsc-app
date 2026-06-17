/**
 * T14 / G-T14-14 residual — single-toggle shared-role atomicity.
 *
 * The three sensitive-read surfaces — `reprisal.read`,
 * `work_refusal.read`, `s51_evidence.read` — are all gated by the same
 * `c4_read_service` role at the SQL layer. The existing tests at
 *   - `test/T13/reprisal-log.test.ts:96`     (reprisal.read)
 *   - `test/T14/c3-read-audit.test.ts:122`   (work_refusal.read)
 *   - `test/T14/c3-read-audit.test.ts:139`   (s51_evidence.read)
 * each flip `__test_revoke_audit_insert_for_role('c4_read_service')`
 * INDEPENDENTLY and assert the matching SELECT rolls back. Closes the
 * structural property but not the shared-role invariant: a future
 * refactor that introduces a separate `c3_read_service` for one of
 * the three would fail those three tests INDEPENDENTLY, hiding the
 * fact that the SHARED-toggle property has been lost.
 *
 * G-T14-14's gap text asks for the converse: ONE toggle, asserted to
 * block ALL THREE in a single test. NEW file (existing T13/T14 tests
 * are read-only per test-plan.md §6).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { createTestSupabase, type TestSupabase } from '../_helpers/supabase-test';
import { SYNTHETIC_USER_CERTIFIED, SYNTHETIC_USER_A } from '../_helpers/fixtures';

let supa: TestSupabase;
beforeEach(async () => {
  freezeClock();
  supa = await createTestSupabase();
});
afterEach(async () => {
  restoreClock();
  await supa.tearDown();
});

describe('T14 / G-T14-14 residual — c4_read_service shared-role atomicity (ONE toggle blocks ALL THREE reads)', () => {
  it('a SINGLE __test_revoke_audit_insert_for_role(\'c4_read_service\') causes reprisal.read + work_refusal.read + s51_evidence.read to ALL abort with audit_failed in the same test', async () => {
    const certified = await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, { role: 'certified_member' });
    const member = await supa.enrollUser(SYNTHETIC_USER_A);

    // Insert one row of each kind BEFORE toggling, so the SELECT path
    // is real (not a not-found false-pass).
    const reprisalId = await supa
      .client(member)
      .insertReprisal({ title: 'r1', body: 'rb', passphrase: 'pp-1' });
    const workRefusalId = await supa
      .client(certified)
      .insertWorkRefusal({ title: 'wr1', body: 'wrb', passphrase: 'pp-2' });
    const s51Id = await supa
      .client(certified)
      .insertS51Evidence({ title: 's51-1', body: 's51b', passphrase: 'pp-3' });

    // ONE toggle.
    await supa.adminQuery(`SELECT __test_revoke_audit_insert_for_role('c4_read_service')`);

    // ALL THREE SELECTs roll back.
    const reprisalRead = await supa
      .client(member)
      .readReprisalViaView(reprisalId)
      .catch((e) => ({ error: e, row: null }));
    const workRefusalRead = await supa
      .client(certified)
      .readWorkRefusalViaView(workRefusalId)
      .catch((e) => ({ error: e, row: null }));
    const s51Read = await supa
      .client(certified)
      .readS51EvidenceViaView(s51Id)
      .catch((e) => ({ error: e, row: null }));

    expect((reprisalRead as { row: unknown }).row, 'reprisal.read MUST roll back under the shared toggle').toBeNull();
    expect((workRefusalRead as { row: unknown }).row, 'work_refusal.read MUST roll back under the shared toggle').toBeNull();
    expect((s51Read as { row: unknown }).row, 's51_evidence.read MUST roll back under the shared toggle').toBeNull();

    // And no audit row landed for ANY of the three reads.
    const reprisalAudit = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'reprisal.read' AND target_id = $1`,
      [reprisalId]
    );
    const workRefusalAudit = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'work_refusal.read' AND target_id = $1`,
      [workRefusalId]
    );
    const s51Audit = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 's51_evidence.read' AND target_id = $1`,
      [s51Id]
    );
    expect(reprisalAudit.rows[0].n).toBe(0);
    expect(workRefusalAudit.rows[0].n).toBe(0);
    expect(s51Audit.rows[0].n).toBe(0);

    // Restore so the afterEach() teardown doesn't see a still-revoked role.
    await supa.adminQuery(`SELECT __test_restore_audit_insert_for_role('c4_read_service')`);
  });
});
