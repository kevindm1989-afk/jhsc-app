/**
 * T18 — Audit-log integrity check job + sensitive-read notification +
 *       backup-diff secondary witness.
 *
 * Source obligations:
 *   - threat-model §8 T18 — F-50 (corruption alerts within 5 min of any of:
 *     scheduled, post-rotation, post-export), F-07/Invariant 8 enum,
 *     T11 sensitive-read notification visibility.
 *   - RA-2 (F-A) — v1 ships hash-only chain; T18 daily integrity job
 *     adds an "audit-log vs latest backup head diff" check that detects
 *     pivot-rewrites the chain-only check cannot catch.
 *   - ADR-0003 Amendment A extension — closed-enum coverage; volumetric
 *     auth.passkey.assert exclusion.
 *   - observability/audit-log.md §5 — 10 test obligations.
 *   - observability/alerts.md — A-AUDIT-001 (5-min detection), A-KEY-ROT-001.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import { createTestSupabase, type TestSupabase } from '../_helpers/supabase-test';
import {
  SYNTHETIC_USER_A,
  SYNTHETIC_USER_COCHAIR,
} from '../_helpers/fixtures';

let supa: TestSupabase;
beforeEach(async () => {
  freezeClock();
  supa = await createTestSupabase();
});
afterEach(async () => {
  restoreClock();
  await supa.tearDown();
});

// ============================================================================
// F-50 — Chain integrity break is detected within 5 minutes
// ============================================================================

describe('T18 / F-50 — chain-integrity break detection ≤5 min', () => {
  it('T18 / F-50 — daily scheduled run: corrupt one row\'s body_hash; assert A-AUDIT-001 fires within 5 minutes', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    // Seed 100 rows.
    for (let i = 0; i < 100; i++) {
      await supa.__emitAuditRowForTest('client.cache_policy_violation', {
        route: `/x${i}`,
        data_class: 'C3',
        allowlist_version: 'v1',
      });
    }
    // Corrupt one row via admin connection (simulating A5 with platform privileges).
    await supa.adminQuery(`SAVEPOINT s1; ALTER TABLE audit_log DISABLE TRIGGER ALL`);
    await supa.adminQuery(`UPDATE audit_log SET meta = jsonb_set(meta, '{route}', '"/forged"') WHERE id = (SELECT id FROM audit_log ORDER BY id ASC OFFSET 50 LIMIT 1)`);
    await supa.adminQuery(`ALTER TABLE audit_log ENABLE TRIGGER ALL; RELEASE SAVEPOINT s1`);
    // Run the integrity job.
    await supa.integrityService.runScheduled();
    advanceBy(5 * 60 * 1000);
    const alert = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'alert.fired' AND meta->>'alert_id' = 'A-AUDIT-001'`
    );
    expect(alert.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('T18 / F-50 — post-rotation trigger fires the integrity check (not just scheduled)', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const corruptionSpy = supa.spyIntegrityRuns();
    await supa.client(cochair).rotateCommitteeKeyTrigger();
    // The integrity service is invoked as a hook on rotation completion.
    expect(corruptionSpy.lastTrigger).toBe('post_rotation');
  });

  it('T18 / F-50 — post-export trigger fires the integrity check', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const minutesId = await supa.client(cochair).finalizeMinutes({ agenda_items: ['x'], decisions: [] });
    const corruptionSpy = supa.spyIntegrityRuns();
    await supa.client(cochair).exportMinutesEndToEnd(minutesId);
    expect(corruptionSpy.lastTrigger).toBe('post_export');
  });

  it('T18 / F-50 — sequential-id gap detection: a row deleted out-of-band breaks the chain at the next row\'s prev_hash', async () => {
    for (let i = 0; i < 5; i++) {
      await supa.__emitAuditRowForTest('client.cache_policy_violation', {
        route: `/x${i}`,
        data_class: 'C3',
        allowlist_version: 'v1',
      });
    }
    // Delete row #3 directly with admin (simulates corruption).
    await supa.adminQuery(`SAVEPOINT s; ALTER TABLE audit_log DISABLE TRIGGER ALL`);
    await supa.adminQuery(`DELETE FROM audit_log WHERE id = (SELECT id FROM audit_log ORDER BY id LIMIT 1 OFFSET 2)`);
    await supa.adminQuery(`ALTER TABLE audit_log ENABLE TRIGGER ALL; RELEASE SAVEPOINT s`);
    const r = await supa.integrityService.runScheduled();
    expect(r.ok).toBe(false);
    expect(r.first_bad_seq).toBeDefined();
  });
});

// ============================================================================
// RA-2 — Live-vs-backup secondary witness
// ============================================================================

describe('T18 / RA-2 / F-A — audit-log vs latest backup-diff secondary witness', () => {
  it('T18 / RA-2 — pivot-rewrite of a row older than the latest backup snapshot: live-vs-backup diff fires A-AUDIT-001 within 5 minutes', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    // Seed and take a backup snapshot.
    for (let i = 0; i < 50; i++) {
      await supa.__emitAuditRowForTest('client.cache_policy_violation', {
        route: `/x${i}`,
        data_class: 'C3',
        allowlist_version: 'v1',
      });
    }
    await supa.backupService.takeSnapshot();
    advanceBy(60 * 60 * 1000); // 1 hour ⇒ rows in the snapshot are >= 1h old now
    // Pivot-rewrite a row older than 1 hour: bypass UPDATE revocation via
    // admin SAVEPOINT and rewrite the chain forward from that row.
    await supa.adminQuery(`SAVEPOINT pv; ALTER TABLE audit_log DISABLE TRIGGER ALL`);
    await supa.adminQuery(
      `UPDATE audit_log SET meta = jsonb_set(meta, '{route}', '"/PIVOT"'), hash = '\\x00'::bytea WHERE id = (SELECT id FROM audit_log ORDER BY id ASC OFFSET 10 LIMIT 1)`
    );
    await supa.adminQuery(`ALTER TABLE audit_log ENABLE TRIGGER ALL; RELEASE SAVEPOINT pv`);
    // Run the live-vs-backup diff portion of the daily integrity job.
    await supa.integrityService.runWithBackupDiff();
    advanceBy(5 * 60 * 1000);
    const alert = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'alert.fired' AND meta->>'alert_id' = 'A-AUDIT-001' ORDER BY id DESC LIMIT 1`
    );
    expect(alert.rows.length).toBeGreaterThanOrEqual(1);
    expect(alert.rows[0].meta.detected_via).toBe('backup_diff');
  });

  it('T18 / RA-2 — no false positive on rows NEWER than the dump (diff only covers rows older by ≥1 hour)', async () => {
    await supa.backupService.takeSnapshot();
    // Insert new rows AFTER the snapshot.
    for (let i = 0; i < 5; i++) {
      await supa.__emitAuditRowForTest('client.cache_policy_violation', {
        route: `/new${i}`,
        data_class: 'C3',
        allowlist_version: 'v1',
      });
    }
    const r = await supa.integrityService.runWithBackupDiff();
    expect(r.alert_fired).toBe(false);
  });
});

// ============================================================================
// audit-log.md §5 obligations — RLS, GRANT, CHECK constraint, meta shape
// ============================================================================

describe('T18 / audit-log.md §5 — schema-level invariants', () => {
  it('T18 / audit-log §5.2 — UPDATE on audit_log fails for every role (authenticated/anon/service_role/audit_writer_role/c4_read_service/retention_service_role)', async () => {
    const roles = [
      'authenticated',
      'anon',
      'service_role',
      'audit_writer_role',
      'c4_read_service',
      'retention_service_role',
    ];
    for (const r of roles) {
      const result = await supa.adminQuery(`SELECT __test_can_role_update_audit_log($1) AS ok`, [r]);
      expect(result.rows[0].ok).toBe(false);
    }
  });

  it('T18 / audit-log §5.3 — DELETE on audit_log fails for every role except retention_service_role on aged rows', async () => {
    const roles = ['authenticated', 'anon', 'service_role', 'audit_writer_role', 'c4_read_service'];
    for (const r of roles) {
      const result = await supa.adminQuery(`SELECT __test_can_role_delete_audit_log($1) AS ok`, [r]);
      expect(result.rows[0].ok).toBe(false);
    }
    // retention_service_role on aged-out row: ALLOWED.
    const aged = await supa.__seedAuditRowAtAge('auth.passkey.enrolled', '91d');
    const r = await supa.adminQuery(
      `SELECT __test_retention_role_delete_specific($1) AS ok`,
      [aged.id]
    );
    expect(r.rows[0].ok).toBe(true);
    // retention_service_role on row newer than its retention: DENIED.
    const fresh = await supa.__seedAuditRowAtAge('auth.passkey.enrolled', '10d');
    const rFresh = await supa.adminQuery(
      `SELECT __test_retention_role_delete_specific($1) AS ok`,
      [fresh.id]
    );
    expect(rFresh.rows[0].ok).toBe(false);
  });

  it('T18 / audit-log §5.6 — CHECK constraint rejects a non-allowlisted event_type', async () => {
    const r = await supa.adminQuery(`SELECT __test_attempt_audit_emit($1)`, ['not.a.real.event']);
    expect(r.rows[0].__test_attempt_audit_emit).toMatch(/check.*violation|enum/i);
  });

  it('T18 / audit-log §5.7 — meta shape enforced: rotation.completed without members_rewrapped_count is rejected', async () => {
    const r = await supa.adminQuery(
      `SELECT __test_attempt_audit_emit_with_meta($1, $2::jsonb)`,
      ['committee_data_key.rotation.completed', '{"rotation_id":"r1","committee_key_id_prev":"a","committee_key_id_next":"b"}']
    );
    expect(r.rows[0].__test_attempt_audit_emit_with_meta).toMatch(/meta|required/i);
  });

  it('T18 / audit-log §5.8 — hash is computed server-side (caller-supplied hash is ignored / overwritten)', async () => {
    const r = await supa.adminQuery(
      `SELECT __test_emit_with_caller_supplied_hash($1, '\\xdeadbeef'::bytea) AS computed_hash`,
      ['client.cache_policy_violation']
    );
    expect(r.rows[0].computed_hash.toString('hex')).not.toContain('deadbeef');
    expect(r.rows[0].computed_hash.length).toBe(32);
  });

  it('T18 / audit-log §5.9 / A-KEY-ROT-001 — rotation.started without .completed within configured window fires A-KEY-ROT-001 (30s per alerts.md)', async () => {
    await supa.__emitAuditRowForTest('committee_data_key.rotation.started', {
      rotation_id: 'r-stalled',
      committee_key_id_prev: 'a',
      committee_key_id_next: 'b',
      trigger: 'scheduled',
    });
    advanceBy(31_000);
    await supa.integrityService.runScheduled();
    const alert = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'alert.fired' AND meta->>'alert_id' = 'A-KEY-ROT-001'`
    );
    expect(alert.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// ADR-0003 Amendment A extension — Closed-enum coverage + volumetric exclusion
// ============================================================================

describe('T18 / Amendment A extension — closed-enum coverage', () => {
  it('T18 — every code path calling audit_emit uses an event_type on the closed allowlist (CI grep test wrapped here)', async () => {
    const { execSync } = await import('node:child_process');
    const out = execSync('bash scripts/check-audit-enum-coverage.sh', {
      cwd: '/home/user/agent-os',
    }).toString();
    expect(out).toMatch(/OK|PASS|coverage complete/i);
  });

  it('T18 — 100 successful WebAuthn assertions produce zero audit rows with event_type=auth.passkey.assert AND 100 structured-log lines', async () => {
    const enrolled = await supa.enrollUser(SYNTHETIC_USER_A);
    supa.startLogCapture();
    for (let i = 0; i < 100; i++) {
      await supa.loginAs(enrolled);
    }
    const lines = supa.stopLogCapture();
    const auditRows = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'auth.passkey.assert'`
    );
    expect(auditRows.rows[0].n).toBe(0);
    const assertLines = lines.filter((l) => l.event === 'auth.passkey.assert' && l.level === 'INFO');
    expect(assertLines.length).toBe(100);
  });
});

// ============================================================================
// T11 sensitive-read notification surface
// ============================================================================

describe('T18 / T11 — sensitive-read notification surface', () => {
  it('T18 / T11 — a read of a reprisal_log row surfaces in every other active member\'s sensitive-activity feed within 60 seconds', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    const observer = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const rid = await supa.client(member).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    await supa.client(member).readReprisalViaView(rid);
    advanceBy(60_000);
    const feed = await supa.client(observer).fetchSensitiveActivityFeed();
    expect(
      feed.items.some(
        (i) => i.event_type === 'reprisal.read' && i.target_id === rid
      )
    ).toBe(true);
  });
});
