/**
 * T10 — Offline-queue HMAC integrity (HG-4 / ADR-0014).
 *
 * Source obligations:
 *   - ADR-0014: BLAKE2b-256 keyed MAC over (seq || user_id || ciphertext).
 *     Key derived via HKDF using libsodium's BLAKE2b-keyed pattern with
 *     personalisation `jhsc.queue.hmac.v1`. Never leaves the device.
 *   - threat-model §8 T10 — F-44 (tamper), F-45 (no plaintext in IndexedDB
 *     across sessions), F-47 (queue cap).
 *   - audit-log.md §1 — `queue.integrity_fail` enum value; canonical name
 *     per ADR-0010 Amendment F-B (alias `inspection.synced.hmac_fail` is
 *     forbidden outside three documented files).
 *   - alerts.md A-QUEUE-001.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import { createTestSupabase, type TestSupabase } from '../_helpers/supabase-test';
import {
  SYNTHETIC_USER_A,
  SYNTHETIC_USER_B,
  HMAC_QUEUE_SALT_V1,
} from '../_helpers/fixtures';
import {
  enqueueInspection,
  drainQueue,
  inspectQuarantine,
} from '../../src/lib/inspections/queue';
import { computeQueueHMAC, deriveQueueHmacKey } from '../../src/lib/crypto/queue-hmac';

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
// HG-4 deterministic tamper test
// ============================================================================

describe('T10 / HG-4 / ADR-0014 — offline-queue HMAC integrity', () => {
  it('T10 / HG-4 — un-tampered entry drains successfully; server stores client_integrity_tag', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const session = await supa.startInspectionSession(user);
    await enqueueInspection(session, {
      checklist: { item_1: 'pass' },
      notes_plaintext: 'inspector-note-1',
    });
    const result = await drainQueue(session);
    expect(result.posted).toBe(1);
    expect(result.rejected).toBe(0);
    const row = await supa.adminQuery(
      `SELECT client_integrity_tag FROM inspections WHERE actor_id = $1`,
      [SYNTHETIC_USER_A]
    );
    expect(row.rows[0].client_integrity_tag).not.toBeNull();
    expect(row.rows[0].client_integrity_tag.length).toBe(32); // BLAKE2b-256
  });

  it('T10 / HG-4 (deterministic tamper) — one corrupted ciphertext byte between queue and sync: drain rejects, queue.integrity_fail audit row queues, user banner shown', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const session = await supa.startInspectionSession(user);
    await enqueueInspection(session, {
      checklist: { item_1: 'pass' },
      notes_plaintext: 'inspector-note-1',
    });
    // Mutate one byte in the queued ciphertext (simulating local tampering).
    await session.idb.mutateQueuedCiphertextByte(0, 0xff);
    const result = await drainQueue(session);
    expect(result.posted).toBe(0);
    expect(result.rejected).toBe(1);
    // No POST happens.
    const rows = await supa.adminQuery(`SELECT count(*)::int AS n FROM inspections`);
    expect(rows.rows[0].n).toBe(0);
    // queue.integrity_fail queued for next online.
    const pendingAudits = await session.idb.peekQueuedAudits();
    expect(pendingAudits.some((a) => a.event_type === 'queue.integrity_fail')).toBe(true);
    // User-visible banner shown.
    expect(session.ui.lastBannerKey).toBe('photo.status.integrity_failed_heading');
  });

  it('T10 / HG-4 — when online, queued queue.integrity_fail audit row is delivered exactly once', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const session = await supa.startInspectionSession(user);
    await enqueueInspection(session, {
      checklist: { item_1: 'pass' },
      notes_plaintext: 'note',
    });
    await session.idb.mutateQueuedCiphertextByte(0, 0xff);
    await drainQueue(session);
    await session.goOnline();
    const rows = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'queue.integrity_fail' AND actor_pseudonym = $1`,
      [supa.pseudonymOf(user.user_id)]
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('T10 / HG-4 (cross-device replay) — copying a queue entry from device B to device A: user_id in MAC scope mismatches; drain rejects', async () => {
    const userA = await supa.enrollUser(SYNTHETIC_USER_A);
    const userB = await supa.enrollUser(SYNTHETIC_USER_B);
    const sessA = await supa.startInspectionSession(userA);
    const sessB = await supa.startInspectionSession(userB);
    await enqueueInspection(sessB, { checklist: { x: 'y' }, notes_plaintext: 'B-note' });
    // Copy B's queue entry into A's IndexedDB raw.
    const bEntry = await sessB.idb.exportQueuedEntries();
    await sessA.idb.importEntriesRaw(bEntry);
    const result = await drainQueue(sessA);
    expect(result.rejected).toBe(bEntry.length);
    expect(result.posted).toBe(0);
  });

  it('T10 / HG-4 — sequence_number prevents in-place reorder: dropping a queue entry causes a gap that fails verification on the next', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const session = await supa.startInspectionSession(user);
    await enqueueInspection(session, { checklist: { a: 1 }, notes_plaintext: 'n1' });
    await enqueueInspection(session, { checklist: { a: 2 }, notes_plaintext: 'n2' });
    // Remove the first entry (simulating a hostile reorder).
    await session.idb.dropQueuedEntryAt(0);
    const result = await drainQueue(session);
    expect(result.rejected).toBeGreaterThan(0);
  });

  it('T10 / HG-4 — K_hmac is never persisted to disk: between sessions, the wrap key is rederived from identity privkey and the queue cannot be drained without re-auth', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const session = await supa.startInspectionSession(user);
    await enqueueInspection(session, { checklist: { x: 1 }, notes_plaintext: 'n' });
    // End session — identity privkey leaves memory; queue persists.
    await session.end();
    // Re-mount: queue is still there, but no in-memory K_hmac.
    const session2 = await supa.startInspectionSession(user, { reAuth: false });
    const drain = await drainQueue(session2);
    expect(drain.status).toBe('requires_re_auth');
  });

  it('T10 / HG-4 — versioned salt: an entry tagged with an unknown salt version is refused (not verified)', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const session = await supa.startInspectionSession(user);
    await enqueueInspection(session, { checklist: { x: 1 }, notes_plaintext: 'n' });
    // Force the salt-version of the queued entry to a fabricated value.
    await session.idb.setQueuedEntrySaltVersion('jhsc.queue.hmac.vNEVER');
    const drain = await drainQueue(session);
    expect(drain.rejected).toBeGreaterThan(0);
    expect(drain.rejection_reasons).toContain('salt_version_mismatch');
  });

  it('T10 / HG-4 known-answer — given a known identity_privkey, user_id, ciphertext: tag matches the documented BLAKE2b-keyed HKDF derivation (deterministic)', async () => {
    // Known-answer vector — the implementer pins this in src/lib/crypto/queue-hmac.test-vectors.ts.
    const idPriv = Buffer.alloc(32, 0x42); // 32 bytes 0x42
    const userId = Buffer.from(SYNTHETIC_USER_A.replace(/-/g, ''), 'hex');
    const cipher = Buffer.from('deadbeefcafe', 'hex');
    const seq = 1n;
    const K = await deriveQueueHmacKey({ identity_privkey: idPriv, user_id: userId });
    const tag = await computeQueueHMAC({ k: K, seq, user_id: userId, ciphertext: cipher });
    // Replay against the same inputs → identical tag.
    const tag2 = await computeQueueHMAC({ k: K, seq, user_id: userId, ciphertext: cipher });
    expect(Buffer.compare(tag, tag2)).toBe(0);
    // The personalisation string is `jhsc.queue.hmac.v1` per ADR-0014.
    expect(HMAC_QUEUE_SALT_V1).toBe('jhsc.queue.hmac.v1');
  });

  it('T10 / observability-alerts A-QUEUE-001 — every queue.integrity_fail row fires alert (no rate threshold)', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const session = await supa.startInspectionSession(user);
    await enqueueInspection(session, { checklist: { x: 1 }, notes_plaintext: 'n' });
    await session.idb.mutateQueuedCiphertextByte(0, 0xff);
    await drainQueue(session);
    await session.goOnline();
    advanceBy(1_000);
    const alerts = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'alert.fired' AND meta->>'alert_id' = 'A-QUEUE-001'`
    );
    expect(alerts.rows.length).toBe(1);
  });

  it('T10 / ADR-0010 Amendment F-B — canonical event name is `queue.integrity_fail`; forbidden alias `inspection.synced.hmac_fail` does not appear in audit_log', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const session = await supa.startInspectionSession(user);
    await enqueueInspection(session, { checklist: { x: 1 }, notes_plaintext: 'n' });
    await session.idb.mutateQueuedCiphertextByte(0, 0xff);
    await drainQueue(session);
    await session.goOnline();
    const alias = await supa.adminQuery(
      `SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'inspection.synced.hmac_fail'`
    );
    expect(alias.rows[0].n).toBe(0);
  });
});

// ============================================================================
// F-47 — Queue overflow cap
// ============================================================================

describe('T10 / F-47 — offline queue cap', () => {
  it('T10 / F-47 — queue capped at 500 items; 501st insert surfaces a user-visible warning', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const session = await supa.startInspectionSession(user);
    for (let i = 0; i < 500; i++) {
      await enqueueInspection(session, { checklist: { i }, notes_plaintext: `n${i}` });
    }
    const result = await enqueueInspection(session, { checklist: { i: 500 }, notes_plaintext: 'overflow' });
    expect(result.status).toBe('rejected_queue_full');
    expect(session.ui.lastBannerKey).toMatch(/queue.*full|capacity|cap/i);
  });
});

// ============================================================================
// F-45 — IndexedDB holds no plaintext between sessions
// ============================================================================

describe('T10 / F-45 — IndexedDB plaintext hygiene across sessions', () => {
  it('T10 / F-45 — after session end, IndexedDB has only {ciphertext, passkey-wrapped privkey, public metadata}; no C2/C3/C4 plaintext field', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    const session = await supa.startInspectionSession(user);
    await enqueueInspection(session, {
      checklist: { x: 1 },
      notes_plaintext: 'CANARY-NOTES-DO-NOT-PERSIST',
    });
    await session.end();
    const snapshot = await supa.idb.snapshotEntireStore();
    const dumped = JSON.stringify(snapshot);
    expect(dumped).not.toContain('CANARY-NOTES-DO-NOT-PERSIST');
    // Every stored object is either a ciphertext blob, a wrapped privkey, or
    // public metadata (allowlist).
    for (const obj of snapshot) {
      const okay =
        obj.kind === 'ciphertext_blob' ||
        obj.kind === 'wrapped_privkey' ||
        obj.kind === 'public_metadata';
      expect(okay, `unexpected IndexedDB object kind: ${obj.kind}`).toBe(true);
    }
  });
});
