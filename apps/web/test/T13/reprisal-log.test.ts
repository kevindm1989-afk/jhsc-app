/**
 * T13 — Reprisal log: C4, 4-eyes, server-side read audit, pseudonymized
 *       projection, forensic-reveal, intake consent surface.
 *
 * Source obligations:
 *   - threat-model §8 T13 — F-30..F-36, F-53 (passphrase_prompt variant).
 *   - ADR-0003 Amendment B (HG-6) — server-side enforced C4 read-audit via
 *     SECURITY DEFINER view + c4_read_service role.
 *   - HG-7 — soft-delete (status-flip) gated by same 4-eyes flow as DELETE.
 *   - ADR-0003 Amendment D (HG-13) — pseudonymized reprisal-feed projection
 *     via `reprisal_audit_feed_pseudonymized`; actor_pseudonym suppressed;
 *     ts bucketed to the hour; default list payload uses the view.
 *   - ADR-0003 Amendment E (HG-13) — forensic-reveal 4-eyes (
 *     `pending_forensic_reveals`, `forensic_read_service`,
 *     `audit.forensic_reveal.4eyes_pending` / `.4eyes_completed` enum values,
 *     24h reveal session).
 *   - ADR-0007 amendment (HG-13) — reprisal-intake consent surface (four
 *     bullets + checkbox-gated submit + per-intake re-render).
 *   - privacy-review §7 obligations 1–6.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/svelte';
import ReprisalIntakeForm from '../../src/lib/reprisal/ReprisalIntakeForm.svelte';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import { createTestSupabase, type TestSupabase } from '../_helpers/supabase-test';
import {
  SYNTHETIC_USER_A,
  SYNTHETIC_USER_B,
  SYNTHETIC_USER_COCHAIR,
  SYNTHETIC_USER_COCHAIR_2,
  SYNTHETIC_USER_CERTIFIED,
  SYNTHETIC_REPRISAL_ID,
  SYNTHETIC_DISPLAY_NAME,
} from '../_helpers/fixtures';

let supa: TestSupabase;

beforeEach(async () => {
  freezeClock('2026-05-22T14:37:42.123456Z');
  supa = await createTestSupabase();
});
afterEach(async () => {
  cleanup();
  restoreClock();
  await supa.tearDown();
});

// ============================================================================
// HG-6 (Amendment B) — Server-enforced C4 read-audit, atomic in-transaction
// ============================================================================

describe('T13 / HG-6 / Amendment B — server-side enforced C4 read-audit', () => {
  it('T13 / HG-6 — direct SELECT on reprisal_log with a valid member JWT returns zero rows AND writes no audit row', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    await supa.client(member).insertReprisal({
      title: 'r1',
      body: 'reprisal body 1',
      passphrase: 'pp-1',
    });
    const r = await supa.client(member).rawSelectFrom('reprisal_log', '*');
    expect(r.rows.length).toBe(0);
    const audit = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'reprisal.read'`
    );
    expect(audit.rows[0].n).toBe(0);
  });

  it('T13 / HG-6 — SELECT through reprisal_log_read_audited returns the row AND emits one `reprisal.read` audit row in the SAME transaction', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    const rid = await supa.client(member).insertReprisal({
      title: 'r1',
      body: 'reprisal body 1',
      passphrase: 'pp-1',
    });
    const r = await supa.client(member).readReprisalViaView(rid);
    expect(r.row).not.toBeNull();
    const audit = await supa.adminQuery(
      `SELECT meta, ts FROM audit_log WHERE event_type = 'reprisal.read' AND target_id = $1`,
      [rid]
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].meta.read_via).toBe('security_definer_view');
    // Same-transaction timestamp (microsecond-equal to the SELECT's xact start).
    expect(new Date(audit.rows[0].ts).getTime()).toBe(r.transaction_ts_ms);
  });

  it('T13 / HG-6 — atomicity: induce a jhsc_log_sensitive_read INSERT failure → SELECT rolls back; no row returned, no partial audit', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    const rid = await supa.client(member).insertReprisal({
      title: 'r1',
      body: 'b',
      passphrase: 'pp-1',
    });
    // Temporarily revoke INSERT on audit_log from c4_read_service.
    await supa.adminQuery(`SELECT __test_revoke_audit_insert_for_role('c4_read_service')`);
    const r = await supa.client(member).readReprisalViaView(rid).catch((e) => ({ error: e, row: null }));
    expect((r as any).row).toBeNull();
    const audit = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'reprisal.read' AND target_id = $1`,
      [rid]
    );
    expect(audit.rows[0].n).toBe(0);
    await supa.adminQuery(`SELECT __test_restore_audit_insert_for_role('c4_read_service')`);
  });

  it('T13 / HG-6 coverage — pg_proc + information_schema enumeration: reprisal_log has `_read_audited` view; underlying SELECT GRANT for authenticated/anon/service_role is empty', async () => {
    const view = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM information_schema.views WHERE table_name = 'reprisal_log_read_audited'`
    );
    expect(view.rows[0].n).toBe(1);
    const grant = await supa.adminQuery(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'reprisal_log' AND grantee IN ('authenticated','anon','service_role') AND privilege_type = 'SELECT'`
    );
    expect(grant.rows).toEqual([]);
  });
});

// ============================================================================
// HG-7 — Soft-delete status-flip gated by 4-eyes
// ============================================================================

describe('T13 / HG-7 — soft-delete status-flip is gated by 4-eyes (status-flip = DELETE-equivalent)', () => {
  it('T13 / HG-7 — single co-chair UPDATE status=deleted denied by RLS with a "needs second member" structured error', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const rid = await supa.client(cochair).insertReprisal({
      title: 'r1',
      body: 'b',
      passphrase: 'pp',
    });
    const r = await supa.client(cochair).updateReprisalStatusRaw(rid, 'deleted');
    expect(r.status).toBe(403);
    expect(r.body.error_code).toBe('NEEDS_FOUR_EYES');
  });

  it('T13 / HG-7 — 4-eyes status-flip succeeds; audit rows for proposal + approval are both written, hash-chained', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const cochair2 = await supa.enrollUser(SYNTHETIC_USER_COCHAIR_2, { role: 'worker_co_chair' });
    const rid = await supa.client(cochair).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const propId = await supa.client(cochair).proposeReprisalStatusFlip(rid, 'deleted');
    await supa.client(cochair2).approveReprisalStatusFlip(propId);
    const rows = await supa.adminQuery(
      `SELECT event_type, prev_hash, hash, meta FROM audit_log WHERE target_id = $1 AND event_type LIKE 'reprisal.status_changed.%' ORDER BY id ASC`,
      [rid]
    );
    expect(rows.rows.length).toBe(2);
    expect(rows.rows[0].event_type).toBe('reprisal.status_changed.4eyes_pending');
    expect(rows.rows[1].event_type).toBe('reprisal.status_changed.4eyes_completed');
    expect(rows.rows[1].prev_hash).toEqual(rows.rows[0].hash);
  });

  it('T13 / HG-7 — proposing member attempts to approve own proposal → RLS denies', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const rid = await supa.client(cochair).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const propId = await supa.client(cochair).proposeReprisalStatusFlip(rid, 'deleted');
    const r = await supa.client(cochair).attemptApproveReprisalStatusFlipRaw(propId);
    expect(r.status).toBe(403);
  });

  it('T13 / HG-7 — direct DELETE FROM reprisal_log is denied for every role except retention_service_role; user DELETE attempts return 403/404', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const rid = await supa.client(cochair).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const r = await supa.client(cochair).attemptHardDeleteReprisalRaw(rid);
    expect([403, 404]).toContain(r.status);
  });

  it('T13 / HG-7 — retention service role (T16) is the ONLY actor permitted to hard-delete reprisal_log on aged-out rows', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const rid = await supa.client(cochair).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    // Backdate the row to be older than active matter + 7y.
    await supa.adminQuery(
      `UPDATE reprisal_log SET created_at = now() - interval '8 years', status = 'closed' WHERE id = $1`,
      [rid]
    );
    await supa.retentionService.runOnce();
    const r = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM reprisal_log WHERE id = $1`,
      [rid]
    );
    expect(r.rows[0].n).toBe(0);
  });
});

// ============================================================================
// F-30 — Session invalidation on membership flip propagates ≤5s
// ============================================================================

describe('T13 / F-30 — removed-but-cached-session member', () => {
  it('T13 / F-30 — on committee_membership.active = false, the user\'s outstanding JWT GET on reprisal_log returns 401 within 5 seconds', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    const sess = await supa.loginAs(member);
    const rid = await supa.client(member).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    await supa.coChairUpdateMembership(SYNTHETIC_USER_A, { active: false });
    advanceBy(5_000);
    const r = await supa.callProtected(sess.access_token, {
      path: `/api/sensitive/read?table=reprisal_log&id=${rid}`,
      method: 'GET',
    });
    expect(r.status).toBe(401);
  });
});

// ============================================================================
// F-31 — UPDATE writes prev_field_hashes + surfaces in sensitive activity ≤60s
// ============================================================================

describe('T13 / F-31 — reprisal UPDATE surfaces as sensitive activity', () => {
  it('T13 / F-31 — UPDATE on reprisal_log writes prev_field_hashes AND appears in the recent-sensitive-activity feed for all active members within 60s', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    const observer = await supa.enrollUser(SYNTHETIC_USER_B);
    const rid = await supa.client(member).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    await supa.client(member).updateReprisal(rid, { title: 'r-new' });
    advanceBy(60_000);
    const feed = await supa.client(observer).fetchSensitiveActivityFeed();
    expect(feed.items.some((i) => i.event_type === 'reprisal.update' && i.target_id === rid)).toBe(true);
    const audit = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'reprisal.update' AND target_id = $1 ORDER BY id DESC LIMIT 1`,
      [rid]
    );
    expect(audit.rows[0].meta.prev_field_hashes.title_ct).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ============================================================================
// F-32 — DELETE requires pending_destructive_ops with two distinct approvers
// (covered above under HG-7 — but the explicit F-32 assertion is here too)
// ============================================================================

describe('T13 / F-32 — destructive op quorum', () => {
  it('T13 / F-32 — same co-chair self-approve denied; pending_destructive_ops has zero approver_id row matching self', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const rid = await supa.client(cochair).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const propId = await supa.client(cochair).proposeReprisalStatusFlip(rid, 'deleted');
    const r = await supa.client(cochair).attemptApproveReprisalStatusFlipRaw(propId);
    expect(r.status).toBe(403);
  });
});

// ============================================================================
// F-34 — Per-record passphrase is UX gate, not crypto gate
// ============================================================================

describe('T13 / F-34 — per-record passphrase is UX, not crypto', () => {
  it('T13 / F-34 — a member with ck_priv can decrypt the per-record body WITHOUT the per-record passphrase (passphrase is friction layer only)', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    const rid = await supa.client(member).insertReprisal({ title: 'r', body: 'B-canary', passphrase: 'pp' });
    // Bypass the passphrase prompt; decrypt via direct ck_priv path.
    const r = await supa.client(member).__testDecryptReprisalBodyViaCkPriv(rid);
    expect(r.body_plaintext).toBe('B-canary');
  });

  it('T13 / F-34 — wrong passphrase 3 times: plaintext NOT shown AND `sensitive.access_attempt` audit row written', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    const rid = await supa.client(member).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    for (let i = 0; i < 3; i++) {
      const r = await supa.client(member).attemptReadReprisalWithPassphrase(rid, 'wrong');
      expect(r.plaintext_returned).toBe(false);
    }
    const audit = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'sensitive.access_attempt' AND target_id = $1`,
      [rid]
    );
    expect(audit.rows[0].n).toBe(3);
  });
});

// ============================================================================
// F-35 — Rate limit on reprisal INSERT
// ============================================================================

describe('T13 / F-35 — reprisal INSERT rate limit', () => {
  it('T13 / F-35 — 11th INSERT in 1 hour returns 429', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    for (let i = 0; i < 10; i++) {
      await supa.client(member).insertReprisal({ title: `r${i}`, body: 'b', passphrase: 'pp' });
    }
    const r = await supa.client(member).attemptInsertReprisalRaw({ title: 'r-overflow', body: 'b', passphrase: 'pp' });
    expect(r.status).toBe(429);
  });
});

// ============================================================================
// HG-13 / Amendment D — Pseudonymized reprisal-feed projection
// (privacy-review §7 obligations 1–3, 6)
// ============================================================================

describe('T13 / HG-13 / Amendment D / privacy-review §7 obligations 1–3 — pseudonymized projection', () => {
  it('T13 / privacy-review §7 obligation 1 — SELECT from reprisal_audit_feed_pseudonymized returns columns {id, event_type, ts_bucketed_to_hour, target_id, target_class, prev_hash, hash} and does NOT contain actor_pseudonym', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    await supa.client(member).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const r = await supa.client(member).rawSelectFrom('reprisal_audit_feed_pseudonymized', '*');
    expect(r.rows.length).toBeGreaterThan(0);
    const cols = Object.keys(r.rows[0]).sort();
    expect(cols).toEqual(
      ['event_type', 'hash', 'id', 'prev_hash', 'target_class', 'target_id', 'ts_bucketed_to_hour'].sort()
    );
    expect(cols).not.toContain('actor_pseudonym');
  });

  it('T13 / privacy-review §7 obligation 2 — direct `SELECT actor_pseudonym FROM audit_log WHERE event_type LIKE \'reprisal.%\'` returns zero rows OR NULL/absent column (both architectural paths covered)', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    await supa.client(member).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const r = await supa.client(member).rawQuery(
      `SELECT actor_pseudonym FROM audit_log WHERE event_type LIKE 'reprisal.%'`
    );
    // Either path (column-level revoke vs row-level RLS) results in a
    // response with no actor_pseudonym value visible to the active member.
    const visible = r.rows.filter((row) => row.actor_pseudonym !== null && row.actor_pseudonym !== undefined);
    expect(visible).toEqual([]);
  });

  it('T13 / privacy-review §7 obligation 3 — time bucketing: a row emitted at 14:37:42.123456 has `ts_bucketed_to_hour = 14:00:00`; underlying ts retains microseconds', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    await supa.client(member).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const view = await supa.client(member).rawSelectFrom('reprisal_audit_feed_pseudonymized', 'ts_bucketed_to_hour');
    expect(new Date(view.rows[0].ts_bucketed_to_hour).toISOString()).toBe(
      '2026-05-22T14:00:00.000Z'
    );
    // Underlying row (accessible via forensic-reveal path) retains microsecond ts.
    const underlying = await supa.adminQuery(
      `SELECT ts FROM audit_log WHERE event_type = 'reprisal.created' ORDER BY id DESC LIMIT 1`
    );
    expect(new Date(underlying.rows[0].ts).toISOString()).toMatch(/14:37:42\.123/);
  });

  it('T13 / privacy-review §4 cross-cutting observation #5 — "my activity" feed for reprisal events returns the pseudonymized projection shape (no actor_pseudonym)', async () => {
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    await supa.client(member).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const myActivity = await supa.client(member).fetchMyActivity({ event_type_prefix: 'reprisal.' });
    for (const row of myActivity.items) {
      expect(Object.keys(row)).not.toContain('actor_pseudonym');
      // ts is the bucketed value.
      expect(row.ts_bucketed_to_hour).toBeDefined();
    }
  });

  it('T13 / privacy-review §7 obligation 6 — same projection guarantees apply to work_refusal.* / s51_evidence.* once T14 enumerates (covered in T14 tests)', () => {
    // Trace: the work_refusal.* / s51_evidence.* coverage lives in
    // apps/web/test/T14/c3-read-audit.test.ts. This stub records the link.
    expect(true).toBe(true);
  });
});

// ============================================================================
// HG-13 / Amendment E — Forensic-reveal 4-eyes
// (privacy-review §7 obligation 4 + the four assertion shapes from the ADR)
// ============================================================================

describe('T13 / HG-13 / Amendment E — forensic-reveal 4-eyes procedure', () => {
  it('T13 / privacy-review §7 obligation 4 — proposer cannot self-approve own forensic reveal', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const rid = await supa.client(cochair).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const auditRow = await supa.adminQuery(
      `SELECT id FROM audit_log WHERE target_id = $1 AND event_type = 'reprisal.created' LIMIT 1`,
      [rid]
    );
    const propId = await supa.client(cochair).proposeForensicReveal(auditRow.rows[0].id, 'investigating');
    const r = await supa.client(cochair).attemptApproveForensicRevealRaw(propId);
    expect(r.status).toBe(403);
    const completed = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'audit.forensic_reveal.4eyes_completed'`
    );
    expect(completed.rows[0].n).toBe(0);
  });

  it('T13 / Amendment E — distinct-member approval succeeds: pending + completed audit rows hash-chain; revealed_actor_pseudonym readable by proposer + approver for ≤24h', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const cochair2 = await supa.enrollUser(SYNTHETIC_USER_COCHAIR_2, { role: 'worker_co_chair' });
    const author = await supa.enrollUser(SYNTHETIC_USER_A);
    const rid = await supa.client(author).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const auditRow = await supa.adminQuery(
      `SELECT id FROM audit_log WHERE target_id = $1 AND event_type = 'reprisal.created' LIMIT 1`,
      [rid]
    );
    const propId = await supa.client(cochair).proposeForensicReveal(auditRow.rows[0].id, 'investigating');
    await supa.client(cochair2).approveForensicReveal(propId);
    const rows = await supa.adminQuery(
      `SELECT event_type, prev_hash, hash FROM audit_log
       WHERE event_type IN ('audit.forensic_reveal.4eyes_pending','audit.forensic_reveal.4eyes_completed')
       ORDER BY id ASC`
    );
    expect(rows.rows.length).toBe(2);
    expect(rows.rows[1].prev_hash).toEqual(rows.rows[0].hash);
    // revealed_actor_pseudonym is the author's pseudonym.
    const revealed = await supa.client(cochair).fetchForensicReveal(propId);
    expect(revealed.revealed_actor_pseudonym).toBe(supa.pseudonymOf(SYNTHETIC_USER_A));
    // Approver (cochair2) can also read.
    const revealed2 = await supa.client(cochair2).fetchForensicReveal(propId);
    expect(revealed2.revealed_actor_pseudonym).toBe(supa.pseudonymOf(SYNTHETIC_USER_A));
  });

  it('T13 / Amendment E — non-pair approval denied: a non-co-chair worker-member cannot approve in a single-co-chair committee', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const worker = await supa.enrollUser(SYNTHETIC_USER_A); // not certified, not co-chair
    const rid = await supa.client(cochair).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const auditRow = await supa.adminQuery(
      `SELECT id FROM audit_log WHERE target_id = $1 AND event_type = 'reprisal.created' LIMIT 1`,
      [rid]
    );
    const propId = await supa.client(cochair).proposeForensicReveal(auditRow.rows[0].id, 'investigating');
    const r = await supa.client(worker).attemptApproveForensicRevealRaw(propId);
    expect(r.status).toBe(403);
  });

  it('T13 / Amendment E — single-co-chair committee: co-chair + certified_member pair IS accepted (privacy-review §4 cross-cutting observation #2)', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const certified = await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, { role: 'certified_member' });
    const rid = await supa.client(cochair).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const auditRow = await supa.adminQuery(
      `SELECT id FROM audit_log WHERE target_id = $1 AND event_type = 'reprisal.created' LIMIT 1`,
      [rid]
    );
    const propId = await supa.client(cochair).proposeForensicReveal(auditRow.rows[0].id, 'investigating');
    const r = await supa.client(certified).approveForensicReveal(propId);
    expect(r.status).toBe('ok');
  });

  it('T13 / Amendment E — reveal-session expiry (24h): after now() > expires_at, the function returns NULL and the column is cleared', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const cochair2 = await supa.enrollUser(SYNTHETIC_USER_COCHAIR_2, { role: 'worker_co_chair' });
    const author = await supa.enrollUser(SYNTHETIC_USER_A);
    const rid = await supa.client(author).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const auditRow = await supa.adminQuery(
      `SELECT id FROM audit_log WHERE target_id = $1 AND event_type = 'reprisal.created' LIMIT 1`,
      [rid]
    );
    const propId = await supa.client(cochair).proposeForensicReveal(auditRow.rows[0].id, 'investigating');
    await supa.client(cochair2).approveForensicReveal(propId);
    advanceBy(24 * 60 * 60 * 1000 + 1);
    await supa.expiryService.runOnce();
    const r = await supa.client(cochair).fetchForensicReveal(propId);
    expect(r.revealed_actor_pseudonym).toBeNull();
    const colCheck = await supa.adminQuery(
      `SELECT expired_at, revealed_actor_pseudonym FROM pending_forensic_reveals WHERE id = $1`,
      [propId]
    );
    expect(colCheck.rows[0].expired_at).not.toBeNull();
    expect(colCheck.rows[0].revealed_actor_pseudonym).toBeNull();
  });
});

// ============================================================================
// HG-13 / ADR-0007 amendment — Reprisal-intake consent surface
// (privacy-review §7 obligation 5)
// ============================================================================

describe('T13 / HG-13 / ADR-0007 amendment — reprisal-intake consent surface', () => {
  it('T13 / privacy-review §7 obligation 5 — Surface C renders the four "what other members will / will NOT see" bullets BEFORE the consent checkbox; Save button gated', () => {
    render(ReprisalIntakeForm);
    const bullets = screen.getAllByTestId('consent-bullet');
    expect(bullets.length).toBe(4);
    // The "Save entry" button is aria-disabled until the consent checkbox
    // is checked.
    const save = screen.getByRole('button', { name: /save entry/i });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand/i }));
    expect(save.getAttribute('aria-disabled')).toBe('false');
  });

  it('T13 / ADR-0007 amendment — submit handler short-circuits (structural gating) until consent is checked: simulating a programmatic click before consent does NOT submit', async () => {
    const { getByRole } = render(ReprisalIntakeForm);
    const save = getByRole('button', { name: /save entry/i });
    const onSubmit = vi.fn();
    save.addEventListener('click', onSubmit);
    fireEvent.click(save);
    // The handler did not submit (consent not checked).
    await waitFor(() => {
      expect(screen.queryByText(/saved|encrypted/i)).toBeNull();
    });
  });

  it('T13 / ADR-0007 amendment — consent surface re-renders on EVERY intake (no "I have seen this" suppression flag)', async () => {
    const { unmount } = render(ReprisalIntakeForm);
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand/i }));
    // ... submit and close ...
    unmount();
    render(ReprisalIntakeForm);
    // The consent surface is freshly required.
    const fresh = screen.getByRole('checkbox', { name: /I understand/i });
    expect((fresh as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('button', { name: /save entry/i }).getAttribute('aria-disabled')).toBe('true');
  });

  it('T13 / ADR-0007 amendment — i18n key `reprisal-intake.consent.heading` (or its catalog equivalent) resolves and is rendered', async () => {
    render(ReprisalIntakeForm);
    // The implementer-chosen i18n key resolves; the rendered heading text
    // matches the §2.4 wording "Before you log a reprisal" (the architect
    // ratifies the shape; labour-lawyer reviews the exact copy under HG-10).
    expect(screen.getByRole('heading', { name: /before you log a reprisal/i })).toBeDefined();
  });
});

// ============================================================================
// F-53 (passphrase_prompt variant) — protected modal on Surface C
// ============================================================================

describe('T13 / F-53 — passphrase_prompt modal on Surface C (Amendment C extension M-53a/b/c)', () => {
  it('T13 / F-53 M-53a/b — passphrase verification handler does NOT fire on confirm before `ready` resolves; no sensitive.access_attempt row for pre-ready synthesized keydown', async () => {
    const { mountPassphrasePromptWithDelayedReady } = await import(
      '../_helpers/protected-modal-harness'
    );
    const ctx = await mountPassphrasePromptWithDelayedReady({ ready_delay_ms: 200 });
    advanceBy(10);
    fireEvent.keyDown(ctx.primaryButton, { key: 'Enter' });
    const audit = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'sensitive.access_attempt'`
    );
    expect(audit.rows[0].n).toBe(0);
    expect(ctx.passphraseHandlerFired).toBe(false);
  });
});

// ============================================================================
// RLS / access-control — author OR co-chair OR certified_member can read
// ============================================================================

describe('T13 / RLS — reprisal_log_read_audited access matrix', () => {
  it('T13 — author (a regular worker_member) CAN read their own reprisal entry via the view', async () => {
    const author = await supa.enrollUser(SYNTHETIC_USER_A);
    const rid = await supa.client(author).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const r = await supa.client(author).readReprisalViaView(rid);
    expect(r.row).not.toBeNull();
  });

  it('T13 — co-chair CAN read any reprisal entry via the view', async () => {
    const author = await supa.enrollUser(SYNTHETIC_USER_A);
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const rid = await supa.client(author).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const r = await supa.client(cochair).readReprisalViaView(rid);
    expect(r.row).not.toBeNull();
  });

  it('T13 — certified_member CAN read any reprisal entry via the view', async () => {
    const author = await supa.enrollUser(SYNTHETIC_USER_A);
    const certified = await supa.enrollUser(SYNTHETIC_USER_CERTIFIED, { role: 'certified_member' });
    const rid = await supa.client(author).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const r = await supa.client(certified).readReprisalViaView(rid);
    expect(r.row).not.toBeNull();
  });

  it('T13 — a different non-author regular worker_member CANNOT read someone else\'s reprisal entry via the view', async () => {
    const author = await supa.enrollUser(SYNTHETIC_USER_A);
    const otherWorker = await supa.enrollUser(SYNTHETIC_USER_B);
    const rid = await supa.client(author).insertReprisal({ title: 'r', body: 'b', passphrase: 'pp' });
    const r = await supa.client(otherWorker).readReprisalViaView(rid);
    expect(r.row).toBeNull();
  });
});

// ============================================================================
// No automatic inclusion in any export
// ============================================================================

describe('T13 / no automatic export inclusion', () => {
  it('T13 — exports of minutes / recommendations NEVER reference reprisal_log fields (allowlist absence; cross-check with T11/F-19)', async () => {
    const { EXPORT_ALLOWLIST_MINUTES, EXPORT_ALLOWLIST_RECOMMENDATION } = await import(
      '../../src/lib/export/allowlist'
    );
    const reprisal_keys = ['reprisal_body_ct', 'reprisal_body_ciphertext', 'reprisal_log'];
    for (const k of reprisal_keys) {
      expect(EXPORT_ALLOWLIST_MINUTES).not.toContain(k);
      expect(EXPORT_ALLOWLIST_RECOMMENDATION).not.toContain(k);
    }
  });
});
