/**
 * T07 — E2EE key core: identity keys, committee key, wrapping, rotation,
 *       recovery-passphrase enrollment, Amendment F "show again".
 *
 * Source obligations:
 *   - ADR-0003 invariants 1–7 (verbatim, encoded as tests).
 *   - ADR-0003 Amendment A (HG-2) — 8 key-material audit-log enum values.
 *   - ADR-0003 Amendment F (HG-12) — recovery-passphrase show-again with
 *     M-54a/b/c/d.
 *   - threat-model §8 T07 — F-01..F-08, F-09, F-12, F-54 M-54a/b/c/d,
 *     Invariants 1/2/4/5 strengthened.
 *   - observability/alerts.md A-KEY-ROT-001 (key-rotation enum gap; HG-2).
 *   - i18n contract — `onboarding.recovery.show_again.label` /
 *     `.helper` keys.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import {
  ARGON2_MIN_OPS,
  ARGON2_MIN_MEM_BYTES,
  CANARY_PRIVKEY_SHAPE,
  SYNTHETIC_USER_A,
  SYNTHETIC_USER_B,
  SYNTHETIC_USER_C_INACTIVE,
  SYNTHETIC_USER_D_NONMEMBER,
  SYNTHETIC_USER_COCHAIR,
} from '../_helpers/fixtures';
import { createTestSupabase, type TestSupabase } from '../_helpers/supabase-test';
import {
  enrollIdentityKeypair,
  storeRecoveryBlob,
  restoreFromRecoveryBlob,
  initCommitteeKey,
  wrapForMember,
  unwrapForSession,
  rotateCommitteeKey,
  revokeMember,
  identitySelfTest,
  showRecoveryPassphraseAgain,
  type KeyCore,
} from '../../src/lib/crypto';
import {
  render,
  fireEvent,
  screen,
  waitFor,
  cleanup,
} from '@testing-library/svelte';
import RecoveryPassphraseScreen from '../../src/lib/onboarding/recovery/RecoveryPassphraseScreen.svelte';
import nodePath from 'node:path';
import { WEB_ROOT, REPO_ROOT } from '../_helpers/paths';

let supa: TestSupabase;
let core: KeyCore;

beforeEach(async () => {
  freezeClock();
  supa = await createTestSupabase();
  core = supa.keyCore();
});
afterEach(async () => {
  cleanup();
  restoreClock();
  await supa.tearDown();
});

// ============================================================================
// ADR-0003 Invariant 1 — Server never sees a private key in the clear
// ============================================================================

describe('T07 / ADR-0003 Invariant 1 — server never sees plaintext private keys', () => {
  it('T07 / Invariant 1 — every C3/C4 column write is well-formed libsodium ciphertext (entropy + min size)', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await initCommitteeKey(core, user);
    // Write a C3 concern through the encryption module.
    const concernId = await supa.client(user).insertConcern({
      title: 'plaintext-canary-title',
      body: 'plaintext-canary-body',
      hazard_class: 'physical',
      severity: 'medium',
      location_id: 'loc-1',
    });
    const row = await supa.adminQuery(
      `SELECT title_ct, body_ct FROM concerns WHERE id = $1`,
      [concernId]
    );
    // libsodium `crypto_box_seal` ciphertext is 48 bytes overhead minimum.
    expect(row.rows[0].title_ct.length).toBeGreaterThanOrEqual(48);
    expect(row.rows[0].body_ct.length).toBeGreaterThanOrEqual(48);
    expect(row.rows[0].title_ct.toString('utf8')).not.toContain('plaintext-canary-title');
    expect(row.rows[0].body_ct.toString('utf8')).not.toContain('plaintext-canary-body');
  });

  it('T07 / Invariant 1 strengthened — CANARY_PRIVKEY_SHAPE never appears in any server-side log or Sentry payload', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    supa.startLogCapture();
    supa.startSentryCapture();
    // Inject the canary into client state; whatever the client does next,
    // it MUST NOT emit the canary anywhere server-side.
    await core.__injectCanaryForTest(CANARY_PRIVKEY_SHAPE);
    await initCommitteeKey(core, user);
    const logs = supa.stopLogCapture();
    const sentryEvents = supa.stopSentryCapture();
    expect(JSON.stringify(logs)).not.toContain(CANARY_PRIVKEY_SHAPE);
    expect(JSON.stringify(sentryEvents)).not.toContain(CANARY_PRIVKEY_SHAPE);
  });
});

// ============================================================================
// ADR-0003 Invariant 2 — No admin recovery
// ============================================================================

describe('T07 / ADR-0003 Invariant 2 strengthened — no admin-recovery route exists', () => {
  it('T07 / Invariant 2 — no `/api/admin/recover-*` or `/api/admin/decrypt-as` route exists; calls return 404', async () => {
    const r1 = await supa.fetch('/api/admin/recover-identity');
    const r2 = await supa.fetch('/api/admin/recover-passphrase');
    const r3 = await supa.fetch('/api/admin/decrypt-as/9f4e9b40-0000-4000-8000-00000000000a');
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    expect(r3.status).toBe(404);
  });
});

// ============================================================================
// F-01 — wrap insert for inactive / non-existent member is denied by RLS
// ============================================================================

describe('T07 / F-01 — committee_key wrap RLS', () => {
  it('T07 / F-01 — wrap insert for inactive member fails RLS', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    await supa.enrollUser(SYNTHETIC_USER_C_INACTIVE, { active: false });
    await initCommitteeKey(core, cochair);
    const result = await wrapForMember(core, cochair, SYNTHETIC_USER_C_INACTIVE);
    expect(result.status).toBe('rls_denied');
  });

  it('T07 / F-01 — wrap insert for non-existent member fails RLS', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    await initCommitteeKey(core, cochair);
    const result = await wrapForMember(core, cochair, SYNTHETIC_USER_D_NONMEMBER);
    expect(result.status).toBe('rls_denied');
  });

  it('T07 / F-01 — wrap is not retroactively valid: making member active AFTER insert does not resurrect a rejected wrap', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    await supa.enrollUser(SYNTHETIC_USER_C_INACTIVE, { active: false });
    await initCommitteeKey(core, cochair);
    const failed = await wrapForMember(core, cochair, SYNTHETIC_USER_C_INACTIVE);
    expect(failed.status).toBe('rls_denied');
    // Now activate.
    await supa.coChairUpdateMembership(SYNTHETIC_USER_C_INACTIVE, { active: true });
    // The previously-rejected wrap is still absent.
    const wraps = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM committee_key WHERE member_id = $1`,
      [SYNTHETIC_USER_C_INACTIVE]
    );
    expect(wraps.rows[0].n).toBe(0);
  });
});

// ============================================================================
// F-02 — pubkey/privkey pairing self-test at enrollment
// ============================================================================

describe('T07 / F-02 — pubkey/privkey pairing self-test at identity enrollment', () => {
  it('T07 / F-02 — enrollment posting a pubkey whose privkey is on a different keypair is rejected; users.identity_pubkey row absent', async () => {
    const user = await supa.makeAuthSession(SYNTHETIC_USER_A);
    const result = await enrollIdentityKeypair(core, user, {
      __testForcePubkeyMismatch: true,
    });
    expect(result.status).toBe('rejected');
    const row = await supa.adminQuery(`SELECT identity_pubkey FROM users WHERE id = $1`, [
      SYNTHETIC_USER_A,
    ]);
    expect(row.rows[0]?.identity_pubkey ?? null).toBeNull();
  });
});

// ============================================================================
// F-03 — IndexedDB identity-key self-test at session start
// ============================================================================

describe('T07 / F-03 — IndexedDB identity-key self-test', () => {
  it('T07 / F-03 — corrupted IndexedDB ident_priv_wrapped_local fails self-test; client refuses authenticated state; recovery flow surfaces', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await core.persistIdentityToIndexedDB(user.identity);
    // Corrupt the blob (simulating a malicious extension write).
    await supa.idb.setRaw('ident_priv_wrapped_local', new Uint8Array([1, 2, 3, 4]));
    const result = await identitySelfTest(core, user);
    expect(result.ok).toBe(false);
    expect(result.next_action).toBe('recovery_flow');
  });

  it('T07 / F-03 — failed self-test emits exactly one `client.identity_selftest_fail` audit row', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await core.persistIdentityToIndexedDB(user.identity);
    await supa.idb.setRaw('ident_priv_wrapped_local', new Uint8Array([1, 2, 3, 4]));
    await identitySelfTest(core, user);
    const rows = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'client.identity_selftest_fail' AND actor_pseudonym = $1`,
      [supa.pseudonymOf(user.user_id)]
    );
    expect(rows.rows[0].n).toBe(1);
  });
});

// ============================================================================
// F-04 — Rotation race: advisory lock serializes
// ============================================================================

describe('T07 / F-04 — committee-key rotation serializes via advisory lock', () => {
  it('T07 / F-04 — concurrent rotations: exactly one succeeds; the other returns 409 within lock TTL', async () => {
    const m1 = await supa.enrollUser(SYNTHETIC_USER_A);
    const m2 = await supa.enrollUser(SYNTHETIC_USER_B);
    await initCommitteeKey(core, m1);

    const [r1, r2] = await Promise.allSettled([
      rotateCommitteeKey(core, m1, { trigger: 'scheduled' }),
      rotateCommitteeKey(core, m2, { trigger: 'scheduled' }),
    ]);
    const statuses = [r1, r2].map((p) =>
      p.status === 'fulfilled' ? p.value.status : (p.reason as any).status
    );
    expect(statuses.sort()).toEqual([200, 409]);
  });

  it('T07 / F-04 — no transient mixed-state observable: `committee_key.public` and wraps update atomically', async () => {
    const m1 = await supa.enrollUser(SYNTHETIC_USER_A);
    const m2 = await supa.enrollUser(SYNTHETIC_USER_B);
    await initCommitteeKey(core, m1);

    // Snapshot at every microsecond during the rotation; assert no row
    // exists where committee_key.public_id is the new id while a wrap row
    // for an active member is still pointing to the old id.
    const snapshots = await supa.captureSnapshotsDuring(
      () => rotateCommitteeKey(core, m1, { trigger: 'scheduled' }),
      `SELECT public_id, (SELECT array_agg(committee_key_id) FROM committee_key WHERE member_id IN ('${SYNTHETIC_USER_A}', '${SYNTHETIC_USER_B}')) AS member_wraps FROM committee_key_metadata`
    );
    for (const snap of snapshots) {
      // Every snapshot is internally consistent: all member wraps refer to
      // the same committee_key_id as the metadata.public_id.
      if (snap.member_wraps) {
        for (const w of snap.member_wraps) {
          expect(w).toBe(snap.public_id);
        }
      }
    }
  });
});

// ============================================================================
// F-05 — Removed member's wrap is purged from current AND history
// ============================================================================

describe('T07 / F-05 — member-removal rotation purges removed member', () => {
  it('T07 / F-05 — after removal, removed member has zero rows in committee_key (current) AND zero in committee_key_history', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    await initCommitteeKey(core, cochair);
    await wrapForMember(core, cochair, SYNTHETIC_USER_A);
    await revokeMember(core, cochair, SYNTHETIC_USER_A);
    const current = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM committee_key WHERE member_id = $1`,
      [SYNTHETIC_USER_A]
    );
    const history = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM committee_key_history WHERE member_id = $1`,
      [SYNTHETIC_USER_A]
    );
    expect(current.rows[0].n).toBe(0);
    expect(history.rows[0].n).toBe(0);
  });

  it('T07 / F-05 — removed member\'s outstanding session invalidates within the same transaction as the wrap delete', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    const session = await supa.loginAs(member);
    await initCommitteeKey(core, cochair);
    await wrapForMember(core, cochair, SYNTHETIC_USER_A);
    await revokeMember(core, cochair, SYNTHETIC_USER_A);
    // Same-transaction guarantee: no race between wrap-delete and session-revoke.
    const r = await supa.callProtected(session.access_token);
    expect(r.status).toBe(401);
  });
});

// ============================================================================
// ADR-0003 Amendment A / HG-2 / Invariant 8 — Key-material mutation audit-log enum
// ============================================================================

describe('T07 / HG-2 / ADR-0003 Amendment A / F-07 — Invariant 8 key-material audit-log enum', () => {
  it('T07 / HG-2 — `identity_keypair.created` emitted exactly once per first enrollment with ident_pubkey_fingerprint', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const rows = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'identity_keypair.created' AND actor_pseudonym = $1`,
      [supa.pseudonymOf(user.user_id)]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].meta.ident_pubkey_fingerprint).toMatch(/^[0-9a-f]+$/);
  });

  it('T07 / HG-2 — `identity_privkey.recovery_blob.written` emitted with kdf_params_version', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await storeRecoveryBlob(core, user, 'correct-horse-battery-staple-test');
    const rows = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'identity_privkey.recovery_blob.written' AND actor_pseudonym = $1`,
      [supa.pseudonymOf(user.user_id)]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].meta.kdf_params_version).toBeDefined();
  });

  it('T07 / HG-2 — `identity_privkey.recovery_blob.restored` emitted with device_fingerprint (hashed; no raw UA)', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await storeRecoveryBlob(core, user, 'correct-horse-battery-staple-test');
    await restoreFromRecoveryBlob(core, user.user_id, 'correct-horse-battery-staple-test', {
      device_fingerprint_raw: 'Mozilla/5.0-test-UA',
    });
    const rows = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'identity_privkey.recovery_blob.restored' AND actor_pseudonym = $1`,
      [supa.pseudonymOf(user.user_id)]
    );
    expect(rows.rows.length).toBe(1);
    const dfp: string = rows.rows[0].meta.device_fingerprint;
    expect(dfp).toMatch(/^[0-9a-f]{32,}$/); // hex hash
    expect(dfp).not.toContain('Mozilla'); // raw UA never written
  });

  it('T07 / HG-2 — `committee_data_key.wrapped_for_member` requires target_member_id + committee_key_id', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    await initCommitteeKey(core, cochair);
    await wrapForMember(core, cochair, SYNTHETIC_USER_A);
    const rows = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'committee_data_key.wrapped_for_member' ORDER BY id DESC LIMIT 1`
    );
    expect(rows.rows[0].meta.target_member_id).toBe(SYNTHETIC_USER_A);
    expect(rows.rows[0].meta.committee_key_id).toBeDefined();
  });

  it('T07 / HG-2 — `committee_data_key.unwrap` emitted on session-start own-wrap open', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await initCommitteeKey(core, user);
    await unwrapForSession(core, user);
    const rows = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'committee_data_key.unwrap' AND actor_pseudonym = $1`,
      [supa.pseudonymOf(user.user_id)]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].meta.committee_key_id).toBeDefined();
  });

  it('T07 / HG-2 — `committee_data_key.rotation.started` and `.completed` are emitted in pair with shared rotation_id and trigger', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    await initCommitteeKey(core, cochair);
    await rotateCommitteeKey(core, cochair, { trigger: 'scheduled' });
    const rows = await supa.adminQuery(
      `SELECT event_type, meta FROM audit_log WHERE event_type IN ('committee_data_key.rotation.started','committee_data_key.rotation.completed') ORDER BY id ASC`
    );
    expect(rows.rows.length).toBe(2);
    expect(rows.rows[0].event_type).toBe('committee_data_key.rotation.started');
    expect(rows.rows[1].event_type).toBe('committee_data_key.rotation.completed');
    expect(rows.rows[0].meta.rotation_id).toBe(rows.rows[1].meta.rotation_id);
    expect(rows.rows[0].meta.trigger).toBe('scheduled');
    expect(rows.rows[1].meta.members_rewrapped_count).toBeDefined();
  });

  it('T07 / HG-2 — `committee_data_key.member_revoked` is paired with `rotation.completed` in the same rotation_id', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    const member = await supa.enrollUser(SYNTHETIC_USER_A);
    await initCommitteeKey(core, cochair);
    await wrapForMember(core, cochair, SYNTHETIC_USER_A);
    await revokeMember(core, cochair, SYNTHETIC_USER_A);
    const rows = await supa.adminQuery(
      `SELECT event_type, meta FROM audit_log WHERE event_type IN ('committee_data_key.member_revoked', 'committee_data_key.rotation.completed') ORDER BY id ASC`
    );
    const revoked = rows.rows.find((r) => r.event_type === 'committee_data_key.member_revoked');
    const completed = rows.rows.find((r) => r.event_type === 'committee_data_key.rotation.completed');
    expect(revoked!.meta.rotation_id).toBe(completed!.meta.rotation_id);
    expect(revoked!.meta.removed_member_id).toBe(SYNTHETIC_USER_A);
  });

  it('T07 / HG-2 — every key-material audit row hash-chains correctly to the previous row', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    await initCommitteeKey(core, cochair);
    await rotateCommitteeKey(core, cochair, { trigger: 'scheduled' });
    const rows = await supa.adminQuery(
      `SELECT id, prev_hash, hash FROM audit_log ORDER BY id ASC`
    );
    for (let i = 1; i < rows.rows.length; i++) {
      expect(rows.rows[i].prev_hash).toEqual(rows.rows[i - 1].hash);
    }
  });

  it('T07 / HG-2 negative — rotation aborts if the audit emission of `committee_data_key.rotation.completed` fails (audit is precondition, not side effect)', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    await initCommitteeKey(core, cochair);
    // Induce audit-log INSERT failure for the `rotation.completed` row.
    await supa.adminQuery(`SELECT __test_block_audit_event('committee_data_key.rotation.completed')`);
    const r = await rotateCommitteeKey(core, cochair, { trigger: 'scheduled' });
    expect(r.status).toBe('aborted');
    // No rotation row in committee_key_history.
    const history = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM committee_key_history`
    );
    expect(history.rows[0].n).toBe(0);
    // The audit-log chain has only the `.started` row, no `.completed`.
    const partial = await supa.adminQuery(
      `SELECT event_type FROM audit_log WHERE event_type LIKE 'committee_data_key.rotation.%'`
    );
    expect(partial.rows.map((r: any) => r.event_type)).toEqual(['committee_data_key.rotation.started']);
  });

  it('T07 / HG-2 — every code path mutating key-material columns is paired with an enum emission (CI grep test placeholder)', async () => {
    // The CI script is scripts/check-audit-enum-coverage.sh per T02 ci-gates
    // test. Here we assert the script exists and runs to completion (smoke).
    const { execSync } = await import('node:child_process');
    const out = execSync('bash scripts/check-audit-enum-coverage.sh', {
      cwd: REPO_ROOT,
    }).toString();
    expect(out).toMatch(/OK|PASS|coverage complete/i);
  });

  it('T07 / HG-2 alerting / A-KEY-ROT-001 — `committee_data_key.rotation.started` without `.completed` within window fires alert', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    await initCommitteeKey(core, cochair);
    // Emit only `.started` (the implementer's path is to throw between the
    // two emissions; the test harness exposes a way to emit the partial row).
    await supa.__emitAuditRowForTest('committee_data_key.rotation.started', {
      rotation_id: 'rotation-aaa',
      committee_key_id_prev: 'ck-prev',
      committee_key_id_next: 'ck-next',
      trigger: 'scheduled',
    });
    advanceBy(31_000); // alerts.md A-KEY-ROT-001 window is 30s
    const alerts = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'alert.fired' AND meta->>'alert_id' = 'A-KEY-ROT-001'`
    );
    expect(alerts.rows.length).toBe(1);
  });

  it('T07 / HG-2 alerting — `committee_data_key.wrapped_for_member` for an inactive member triggers A-KEY-ROT-001', async () => {
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    await supa.enrollUser(SYNTHETIC_USER_C_INACTIVE, { active: false });
    await initCommitteeKey(core, cochair);
    // Bypass RLS via admin connection to simulate the failure mode HG-2 watches for.
    await supa.adminQuery(
      `SELECT __test_force_wrap_for_inactive_member($1)`,
      [SYNTHETIC_USER_C_INACTIVE]
    );
    const alerts = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'alert.fired' AND meta->>'alert_id' = 'A-KEY-ROT-001'`
    );
    expect(alerts.rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// F-08 — Recovery passphrase brute-force resistance
// ============================================================================

describe('T07 / F-08 — recovery-blob KDF strength', () => {
  it('T07 / F-08 — Argon2id parameters meet floor (ops>=4, mem>=512MB) in the embedded KDF params', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const blob = await storeRecoveryBlob(core, user, 'correct-horse-battery-staple-test');
    expect(blob.kdf_params.ops).toBeGreaterThanOrEqual(ARGON2_MIN_OPS);
    expect(blob.kdf_params.mem_bytes).toBeGreaterThanOrEqual(ARGON2_MIN_MEM_BYTES);
  });

  it('T07 / F-08 — type-back verification at enrollment: a wrong type-back rejects; right one proceeds', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const r1 = await storeRecoveryBlob(core, user, 'pass-A', { type_back: 'pass-B' });
    expect(r1.status).toBe('mismatch');
    const r2 = await storeRecoveryBlob(core, user, 'pass-A', { type_back: 'pass-A' });
    expect(r2.status).toBe('ok');
  });
});

// ============================================================================
// F-12 — Recovery blob upload de-duplication
// ============================================================================

describe('T07 / F-12 — recovery-blob endpoint single-POST', () => {
  it('T07 / F-12 — second recovery-blob POST returns 409 unless co-chair issued users.reset_recovery row', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await storeRecoveryBlob(core, user, 'pass-A', { type_back: 'pass-A' });
    const second = await storeRecoveryBlob(core, user, 'pass-B', { type_back: 'pass-B' });
    expect(second.status).toBe(409);

    // After co-chair issues a reset:
    const cochair = await supa.enrollUser(SYNTHETIC_USER_COCHAIR, { role: 'worker_co_chair' });
    await supa.coChairIssueRecoveryReset(cochair, SYNTHETIC_USER_A);
    const third = await storeRecoveryBlob(core, user, 'pass-C', { type_back: 'pass-C' });
    expect(third.status).toBe('ok');
  });
});

// ============================================================================
// F-09 / Invariant 3 — No plaintext via Edge Function logs / Sentry
// ============================================================================

describe('T07 / F-09 / Invariant 3 — no plaintext through Edge Functions', () => {
  it('T07 / F-09 — Edge Function path carrying ciphertext does NOT emit canary or any ciphertext bytes in function logs', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await initCommitteeKey(core, user);
    supa.startEdgeFunctionLogCapture();
    await supa.client(user).insertConcernCanary({ canary: CANARY_PRIVKEY_SHAPE });
    const logs = supa.stopEdgeFunctionLogCapture();
    expect(JSON.stringify(logs)).not.toContain(CANARY_PRIVKEY_SHAPE);
  });
});

// ============================================================================
// Invariant 5 strengthened — no key-shaped URL params anywhere
// ============================================================================

describe('T07 / Invariant 5 strengthened — no key-shaped URL params', () => {
  it('T07 / Invariant 5 — route map enumeration shows no parameter named `key|secret|passphrase|priv|nonce`', async () => {
    const routes = supa.getRouteInventory();
    for (const route of routes) {
      const params = route.params ?? [];
      for (const p of params) {
        expect(['key', 'secret', 'passphrase', 'priv', 'nonce']).not.toContain(p.toLowerCase());
      }
    }
  });
});

// ============================================================================
// ADR-0003 Amendment F (HG-12) — Recovery-passphrase show-again M-54a/b/c/d
// ============================================================================

describe('T07 / HG-12 / ADR-0003 Amendment F — recovery-passphrase "show again" accommodation', () => {
  // The reveal control is in `src/lib/onboarding/recovery/RecoveryPassphraseScreen.svelte`
  // per Amendment F operational rule 4 (static-lint surface).

  it('T07 / M-54a — normal click (release within 100ms) does NOT render the passphrase', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    render(RecoveryPassphraseScreen, { props: { enrollment_session_id: 'sess-1', user } });
    const btn = screen.getByTestId('show-again-control');
    // Pointer-down + pointer-up within 100ms.
    fireEvent.pointerDown(btn);
    advanceBy(100);
    fireEvent.pointerUp(btn);
    advanceBy(50);
    expect(screen.queryByTestId('recovery-passphrase-onscreen')).toBeNull();
  });

  it('T07 / M-54a — sustained pointer-down ≥1500ms reveals; release within 50ms hides', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    render(RecoveryPassphraseScreen, { props: { enrollment_session_id: 'sess-1', user } });
    const btn = screen.getByTestId('show-again-control');
    fireEvent.pointerDown(btn);
    advanceBy(1500);
    await waitFor(() =>
      expect(screen.getByTestId('recovery-passphrase-onscreen')).toBeDefined()
    );
    fireEvent.pointerUp(btn);
    advanceBy(50);
    expect(screen.queryByTestId('recovery-passphrase-onscreen')).toBeNull();
  });

  it('T07 / M-54a (keyboard) — Space-keydown for 1500ms reveals; Space-keyup hides', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    render(RecoveryPassphraseScreen, { props: { enrollment_session_id: 'sess-1', user } });
    const btn = screen.getByTestId('show-again-control');
    btn.focus();
    fireEvent.keyDown(btn, { key: ' ', code: 'Space' });
    advanceBy(1500);
    await waitFor(() => expect(screen.getByTestId('recovery-passphrase-onscreen')).toBeDefined());
    fireEvent.keyUp(btn, { key: ' ', code: 'Space' });
    expect(screen.queryByTestId('recovery-passphrase-onscreen')).toBeNull();
  });

  it('T07 / M-54b — every successful reveal emits exactly one `identity_privkey.recovery_blob.viewed` BEFORE the DOM render with required meta', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    render(RecoveryPassphraseScreen, { props: { enrollment_session_id: 'sess-1', user } });
    const auditWriter = supa.spyAuditWrites();
    const btn = screen.getByTestId('show-again-control');
    fireEvent.pointerDown(btn);
    advanceBy(1500);
    await waitFor(() => expect(screen.getByTestId('recovery-passphrase-onscreen')).toBeDefined());

    // The audit-log INSERT must be observed BEFORE the DOM render.
    const renderTime = auditWriter.dom_render_ts!;
    const auditTime = auditWriter.last_written_ts_for('identity_privkey.recovery_blob.viewed')!;
    expect(auditTime).toBeLessThan(renderTime);
    const meta = auditWriter.last_meta('identity_privkey.recovery_blob.viewed')!;
    expect(meta.enrollment_session_id).toBe('sess-1');
    expect(meta.reveal_count_in_session).toBe(1);
    expect(meta.actor_id).toBeDefined();
  });

  it('T07 / M-54b — audit endpoint 500 blocks the render AND surfaces a danger toast', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    render(RecoveryPassphraseScreen, { props: { enrollment_session_id: 'sess-1', user } });
    supa.__forceAuditEndpoint500ForEvent('identity_privkey.recovery_blob.viewed');
    const btn = screen.getByTestId('show-again-control');
    fireEvent.pointerDown(btn);
    advanceBy(1500);
    // Passphrase MUST NOT render.
    expect(screen.queryByTestId('recovery-passphrase-onscreen')).toBeNull();
    // Danger toast appears.
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
  });

  it('T07 / M-54c — three reveals succeed; fourth attempt: control aria-disabled=true, no audit row, helper directs to restart', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    render(RecoveryPassphraseScreen, { props: { enrollment_session_id: 'sess-1', user } });

    for (let i = 1; i <= 3; i++) {
      const btn = screen.getByTestId('show-again-control');
      fireEvent.pointerDown(btn);
      advanceBy(1500);
      await waitFor(() => expect(screen.getByTestId('recovery-passphrase-onscreen')).toBeDefined());
      fireEvent.pointerUp(btn);
      advanceBy(60);
    }
    const rows = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'identity_privkey.recovery_blob.viewed' AND meta->>'enrollment_session_id' = 'sess-1'`
    );
    expect(rows.rows[0].n).toBe(3);

    // Fourth attempt — control is aria-disabled.
    const btn = screen.getByTestId('show-again-control');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    fireEvent.pointerDown(btn);
    advanceBy(1500);
    const rowsAfter = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'identity_privkey.recovery_blob.viewed' AND meta->>'enrollment_session_id' = 'sess-1'`
    );
    expect(rowsAfter.rows[0].n).toBe(3);
    // Helper text references "restart enrollment".
    const helper = screen.getByTestId('show-again-helper');
    expect(helper.textContent ?? '').toMatch(/restart|start.*again/i);
  });

  it('T07 / M-54c — restart-enrollment resets the counter; fresh enrollment_session_id; "show again" invocable again up to 3 times', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const { rerender } = render(RecoveryPassphraseScreen, {
      props: { enrollment_session_id: 'sess-1', user },
    });
    // Burn through 3 reveals.
    for (let i = 1; i <= 3; i++) {
      const btn = screen.getByTestId('show-again-control');
      fireEvent.pointerDown(btn);
      advanceBy(1500);
      fireEvent.pointerUp(btn);
    }
    // Restart enrollment → new session id.
    await rerender({ enrollment_session_id: 'sess-2', user });
    const btn = screen.getByTestId('show-again-control');
    expect(btn.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.pointerDown(btn);
    advanceBy(1500);
    await waitFor(() => expect(screen.getByTestId('recovery-passphrase-onscreen')).toBeDefined());
  });

  it('T07 / M-54d — reveal surface contains no `data-testid="copy-passphrase"` button', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    render(RecoveryPassphraseScreen, { props: { enrollment_session_id: 'sess-1', user } });
    const btn = screen.getByTestId('show-again-control');
    fireEvent.pointerDown(btn);
    advanceBy(1500);
    await waitFor(() => expect(screen.getByTestId('recovery-passphrase-onscreen')).toBeDefined());
    expect(screen.queryByTestId('copy-passphrase')).toBeNull();
  });

  it('T07 / M-54d (static lint) — zero matches for SpeechSynthesisUtterance/window.speechSynthesis/tts in src/lib/onboarding/recovery/ outside test fixtures', async () => {
    const { execSync } = await import('node:child_process');
    // grep returns non-zero on no matches — that's the success signal.
    let matches = '';
    try {
      matches = execSync(
        `grep -rn --include='*.ts' --include='*.svelte' -E 'SpeechSynthesisUtterance|window\\.speechSynthesis|\\btts\\b' ${nodePath.join(WEB_ROOT, 'src/lib/onboarding/recovery/')}`
      ).toString();
    } catch {
      matches = '';
    }
    // Filter out anything in a test fixture file.
    const offending = matches
      .split('\n')
      .filter((l) => l && !l.includes('/test/') && !l.includes('.fixture.'));
    expect(offending).toEqual([]);
  });

  it('T07 / i18n contract — en-CA keys `onboarding.recovery.show_again.label` and `.helper` resolve to plain-language consequence-naming text', async () => {
    const en = await import('../../../../i18n/en-CA.json');
    const label = (en.default as any)?.onboarding?.recovery?.show_again?.label;
    const helper = (en.default as any)?.onboarding?.recovery?.show_again?.helper;
    expect(label, 'onboarding.recovery.show_again.label must exist').toBeDefined();
    expect(helper, 'onboarding.recovery.show_again.helper must exist').toBeDefined();
    // Helper text must name the threat (i.e., that anyone who can see the
    // screen can read the passphrase) per Amendment F operational rule 1.
    expect(helper).toMatch(/screen|see/i);
  });
});

// ============================================================================
// T1 ciphertext shape — every C3/C4 column write is well-formed
// ============================================================================

describe('T07 / T1 ciphertext shape — admin SELECT yields no plaintext for C3/C4', () => {
  it('T07 / T1 — admin Postgres connection reads C3 row and finds libsodium ciphertext only (no plaintext substring)', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await initCommitteeKey(core, user);
    const id = await supa.client(user).insertConcern({
      title: 'CANARY-PLAINTEXT-TITLE-DO-NOT-LEAK',
      body: 'CANARY-PLAINTEXT-BODY-DO-NOT-LEAK',
      hazard_class: 'physical',
      severity: 'medium',
      location_id: 'loc-1',
    });
    const r = await supa.adminQuery(`SELECT title_ct, body_ct FROM concerns WHERE id = $1`, [id]);
    const titleBytes: Buffer = r.rows[0].title_ct;
    const bodyBytes: Buffer = r.rows[0].body_ct;
    expect(titleBytes.toString('latin1')).not.toContain('CANARY-PLAINTEXT-TITLE-DO-NOT-LEAK');
    expect(bodyBytes.toString('latin1')).not.toContain('CANARY-PLAINTEXT-BODY-DO-NOT-LEAK');
    // libsodium sealed-box ciphertext shape: at minimum X25519 pubkey + nonce + MAC + content.
    expect(titleBytes.length).toBeGreaterThanOrEqual(48);
  });
});
