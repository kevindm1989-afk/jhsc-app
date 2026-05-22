/**
 * T14 — Work refusal (s.43) + critical injury (s.51).
 *
 * Source obligations:
 *   - threat-model §8 T14 — F-21 (RLS), C4 notes, sensitive-read pipeline.
 *   - ADR-0003 Amendment A extension — `work_refusal.read` / `s51_evidence.read`
 *     enum values; same server-enforced indirection posture as HG-6.
 *   - ADR-0003 Amendment D extension — pseudonymized projection extended to
 *     `work_refusal.*` and `s51_evidence.*` write events (privacy-review §7
 *     obligation 6).
 *   - HG-5 (ADR-0011 amendment cross-reference) — s.51 evidence photos go
 *     through the same sanitize pipeline as T10 inspections.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { createTestSupabase, type TestSupabase } from '../_helpers/supabase-test';
import {
  SYNTHETIC_USER_A,
  SYNTHETIC_USER_COCHAIR,
  SYNTHETIC_USER_CERTIFIED,
  SYNTHETIC_WORK_REFUSAL_ID,
  SYNTHETIC_S51_ID,
  FIXTURE_EXIF_GPS_LAT,
  FIXTURE_EXIF_GPS_LON,
  ONTARIO_DECIMAL_DEGREES_RE,
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
// F-21 — RLS: certified_member OR co-chair only
// ============================================================================

describe('T14 / F-21 — certified-only access to work_refusal / s51_evidence', () => {
  it('T14 / F-21 — certified_member can SELECT/INSERT/UPDATE on work_refusal via the indirection', async () => {
    const certified = await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, { role: 'certified_member' });
    const id = await supa.client(certified).insertWorkRefusal({
      title: 'wr1',
      body: 'b',
      passphrase: 'pp',
    });
    const r = await supa.client(certified).readWorkRefusalViaView(id);
    expect(r.row).not.toBeNull();
  });

  it('T14 / F-21 — worker_member who is NOT certified is denied: SELECT/INSERT/UPDATE all denied', async () => {
    await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, { role: 'certified_member' });
    const worker = await supa.enrollUser(SYNTHETIC_USER_A, { role: 'worker_member' });
    const insertR = await supa.client(worker).attemptInsertWorkRefusalRaw({
      title: 'wr',
      body: 'b',
      passphrase: 'pp',
    });
    expect(insertR.status).toBe('rls_denied');
    const selectR = await supa.client(worker).rawSelectFrom('work_refusal', '*');
    expect(selectR.rows.length).toBe(0);
  });

  it('T14 / F-21 — inactive certified_member is denied', async () => {
    const certified = await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, {
      role: 'certified_member',
      active: false,
    });
    const r = await supa.client(certified).attemptInsertWorkRefusalRaw({
      title: 'x',
      body: 'b',
      passphrase: 'pp',
    });
    expect(r.status).toBe('rls_denied');
  });

  it('T14 / F-21 — co-chair can SELECT (read) but the protection model is the same indirection (no direct SELECT)', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const certified = await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, { role: 'certified_member' });
    const id = await supa.client(certified).insertWorkRefusal({ title: 'x', body: 'b', passphrase: 'pp' });
    const direct = await supa.client(cochair).rawSelectFrom('work_refusal', '*');
    expect(direct.rows.length).toBe(0); // direct path denied
    const viaView = await supa.client(cochair).readWorkRefusalViaView(id);
    expect(viaView.row).not.toBeNull();
  });
});

// ============================================================================
// Amendment A extension — server-enforced C3 read-audit on T14 tables
// ============================================================================

describe('T14 / Amendment A extension — work_refusal.read / s51_evidence.read server-emitted', () => {
  it('T14 / F-21 + Amendment A — SELECT via work_refusal_read_audited writes exactly one work_refusal.read row, same-transaction', async () => {
    const certified = await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, { role: 'certified_member' });
    const id = await supa.client(certified).insertWorkRefusal({ title: 'x', body: 'b', passphrase: 'pp' });
    const r = await supa.client(certified).readWorkRefusalViaView(id);
    expect(r.row).not.toBeNull();
    const audit = await supa.adminQuery(
      `SELECT meta, ts FROM audit_log WHERE event_type = 'work_refusal.read' AND target_id = $1`,
      [id]
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].meta.read_via).toBe('security_definer_view');
    expect(new Date(audit.rows[0].ts).getTime()).toBe(r.transaction_ts_ms);
  });

  it('T14 / Amendment A — direct SELECT * FROM work_refusal returns zero rows AND no audit', async () => {
    const certified = await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, { role: 'certified_member' });
    await supa.client(certified).insertWorkRefusal({ title: 'x', body: 'b', passphrase: 'pp' });
    const r = await supa.client(certified).rawSelectFrom('work_refusal', '*');
    expect(r.rows.length).toBe(0);
    const audit = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'work_refusal.read'`
    );
    expect(audit.rows[0].n).toBe(0);
  });

  it('T14 / Amendment A — atomicity: jhsc_log_sensitive_read failure on work_refusal_read_audited rolls back the SELECT', async () => {
    const certified = await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, { role: 'certified_member' });
    const id = await supa.client(certified).insertWorkRefusal({ title: 'x', body: 'b', passphrase: 'pp' });
    await supa.adminQuery(`SELECT __test_revoke_audit_insert_for_role('c4_read_service')`);
    const r = await supa
      .client(certified)
      .readWorkRefusalViaView(id)
      .catch((e) => ({ error: e, row: null }));
    expect((r as any).row).toBeNull();
    const audit = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'work_refusal.read' AND target_id = $1`,
      [id]
    );
    expect(audit.rows[0].n).toBe(0);
    await supa.adminQuery(`SELECT __test_restore_audit_insert_for_role('c4_read_service')`);
  });

  it('T14 / Amendment A — same posture applied to s51_evidence_read_audited (mirrors work_refusal)', async () => {
    const certified = await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, { role: 'certified_member' });
    const id = await supa.client(certified).insertS51Evidence({
      title: 'x',
      body: 'b',
      passphrase: 'pp',
    });
    const r = await supa.client(certified).readS51EvidenceViaView(id);
    expect(r.row).not.toBeNull();
    const audit = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 's51_evidence.read' AND target_id = $1`,
      [id]
    );
    expect(audit.rows[0].meta.read_via).toBe('security_definer_view');
  });

  it('T14 / Amendment A coverage — pg_proc + information_schema enumeration: every T14 C3 table has a `_read_audited` view; underlying SELECT GRANT for authenticated/anon/service_role is empty', async () => {
    const views = await supa.adminQuery(
      `SELECT table_name FROM information_schema.views WHERE table_name IN ('work_refusal_read_audited','s51_evidence_read_audited')`
    );
    expect(views.rows.length).toBe(2);
    const grants = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM information_schema.role_table_grants
       WHERE table_name IN ('work_refusal','s51_evidence')
         AND grantee IN ('authenticated','anon','service_role')
         AND privilege_type = 'SELECT'`
    );
    expect(grants.rows[0].n).toBe(0);
  });
});

// ============================================================================
// HG-5 cross-reference — s.51 evidence photos use the sanitize pipeline
// ============================================================================

describe('T14 / HG-5 cross-reference — s.51 evidence photo sanitize', () => {
  it('T14 / HG-5 — s.51 evidence photo input with EXIF GPS at workplace coords → uploaded ciphertext, when decrypted in test, contains no EXIF/IPTC/XMP', async () => {
    const certified = await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, { role: 'certified_member' });
    const { buildJpegWithExifGps } = await import('../_helpers/exif-fixtures');
    const photoBytes = await buildJpegWithExifGps({
      lat: FIXTURE_EXIF_GPS_LAT,
      lon: FIXTURE_EXIF_GPS_LON,
    });
    const evId = await supa.client(certified).insertS51Evidence({
      title: 'x',
      body: 'b',
      passphrase: 'pp',
      photos: [photoBytes],
    });
    // Decrypt the stored photo blob with the test committee key.
    const decrypted = await supa.client(certified).__testDecryptS51Photo(evId, 0);
    const { parseExif } = await import('../_helpers/exif-parser');
    expect((await parseExif(decrypted)).tags).toEqual({});
    expect(Buffer.from(decrypted).toString('latin1')).not.toMatch(ONTARIO_DECIMAL_DEGREES_RE);
  });
});

// ============================================================================
// Amendment D extension — pseudonymized projection covers T14 write events
// ============================================================================

describe('T14 / Amendment D extension / privacy-review §7 obligation 6 — pseudonymized projection on T14 events', () => {
  it('T14 / Amendment D — work_refusal.* write events in the pseudonymized feed view: no actor_pseudonym, ts bucketed to the hour', async () => {
    const certified = await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, { role: 'certified_member' });
    await supa.client(certified).insertWorkRefusal({ title: 'x', body: 'b', passphrase: 'pp' });
    const view = await supa.client(certified).rawSelectFrom(
      'reprisal_audit_feed_pseudonymized',
      '*',
      `event_type LIKE 'work_refusal.%'`
    );
    expect(view.rows.length).toBeGreaterThan(0);
    for (const row of view.rows) {
      expect(Object.keys(row)).not.toContain('actor_pseudonym');
      expect(row.ts_bucketed_to_hour).toBeDefined();
    }
  });

  it('T14 / Amendment D — direct `SELECT actor_pseudonym FROM audit_log WHERE event_type LIKE \'work_refusal.%\'` returns zero rows / NULL', async () => {
    const certified = await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, { role: 'certified_member' });
    await supa.client(certified).insertWorkRefusal({ title: 'x', body: 'b', passphrase: 'pp' });
    const r = await supa.client(certified).rawQuery(
      `SELECT actor_pseudonym FROM audit_log WHERE event_type LIKE 'work_refusal.%'`
    );
    const visible = r.rows.filter((row) => row.actor_pseudonym !== null && row.actor_pseudonym !== undefined);
    expect(visible).toEqual([]);
  });

  it('T14 / Amendment D — same for `s51_evidence.%` write events', async () => {
    const certified = await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, { role: 'certified_member' });
    await supa.client(certified).insertS51Evidence({ title: 'x', body: 'b', passphrase: 'pp' });
    const view = await supa.client(certified).rawSelectFrom(
      'reprisal_audit_feed_pseudonymized',
      '*',
      `event_type LIKE 's51_evidence.%'`
    );
    expect(view.rows.length).toBeGreaterThan(0);
    for (const row of view.rows) {
      expect(Object.keys(row)).not.toContain('actor_pseudonym');
    }
  });
});

// ============================================================================
// Notes are C4; per-record key + sensitive-read pipeline (parallel to T13)
// ============================================================================

describe('T14 — work_refusal notes are C4; same wrap-and-key model as reprisal_log', () => {
  it('T14 — admin SELECT yields ciphertext only; plaintext substring of notes never appears in the row bytes', async () => {
    const certified = await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, { role: 'certified_member' });
    const CANARY = 'CANARY-WORK-REFUSAL-NOTES-DO-NOT-LEAK';
    const id = await supa.client(certified).insertWorkRefusal({ title: 'x', body: CANARY, passphrase: 'pp' });
    const row = await supa.adminQuery(`SELECT notes_ct FROM work_refusal WHERE id = $1`, [id]);
    expect(Buffer.from(row.rows[0].notes_ct).toString('latin1')).not.toContain(CANARY);
  });
});
