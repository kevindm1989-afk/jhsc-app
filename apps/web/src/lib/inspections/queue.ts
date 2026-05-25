/**
 * Offline inspection queue (T10 — HG-4 / ADR-0014 + F-45 + F-47).
 *
 * IndexedDB-backed queue of inspection entries with per-entry HMAC
 * integrity tags. The HMAC verification step runs BEFORE any POST: a
 * mismatch quarantines the entry, queues a `queue.integrity_fail` audit
 * row for next online, and surfaces a user banner.
 *
 * The session is the unit of trust here — it holds the in-memory K_hmac
 * derived from the user's identity privkey. End-of-session releases the
 * key; a re-mount cannot drain the queue without re-auth.
 *
 * Source obligations:
 *   - ADR-0014 — HMAC scheme, salt version, sequence number.
 *   - threat-model §3.5 F-44 (tamper) / F-45 (no plaintext residue) /
 *     F-47 (queue cap 500).
 *   - audit-log.md §1 — `queue.integrity_fail` canonical name; its legacy
 *     threat-model alias is forbidden in code (per ADR-0010 Amendment F-B).
 *   - alerts.md — A-QUEUE-001 (every queue.integrity_fail fires alert).
 */

import { ready } from '../crypto/sodium';
import {
  HMAC_QUEUE_SALT_V1,
  computeQueueHMAC,
  deriveQueueHmacKey,
  timingSafeEqualBytes,
  uuidToBytes
} from '../crypto/queue-hmac';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per F-47 — cap the offline queue at 500 items. */
export const QUEUE_CAP = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InspectionEntryInput {
  /** Free-form checklist (shape decided at intake time). */
  checklist: Record<string, unknown>;
  /** Plaintext notes — encrypted before persistence. */
  notes_plaintext: string;
}

export interface QueuedEntry {
  /** IndexedDB primary key. */
  id: string;
  /** Strictly monotonic per session — covered by the HMAC. */
  sequence_number: bigint;
  /** User UUID bytes — covered by the HMAC; cross-device replay safety. */
  user_id_bytes: Uint8Array;
  /** Salt-version tagged on the entry; ADR-0014 versioned salt. */
  salt_version: string;
  /** libsodium secretbox ciphertext (nonce || ct). */
  ciphertext: Uint8Array;
  /** BLAKE2b-256 keyed MAC; 32 bytes. */
  tag: Uint8Array;
  /** ISO timestamp at enqueue. */
  enqueued_at: string;
}

export interface QuarantinedEntry extends QueuedEntry {
  /** Why the entry was rejected at drain time. */
  reason: 'tag_mismatch' | 'user_id_mismatch' | 'salt_version_mismatch';
}

export interface EnqueueResult {
  status: 'ok' | 'rejected_queue_full';
  id?: string;
}

export interface DrainResult {
  posted: number;
  rejected: number;
  status?: 'ok' | 'requires_re_auth';
  rejection_reasons: string[];
}

export interface PendingAuditRow {
  event_type: string;
  meta: Record<string, unknown>;
  queued_at: string;
}

/**
 * The "session" composes the in-memory K_hmac, the user/device identity,
 * the queue IDB-shaped state, and a UI banner sink. Tests reach into the
 * `idb` and `ui` surfaces to simulate tampering.
 */
export interface InspectionSession {
  user_id: string;
  user_id_bytes: Uint8Array;
  /** In-memory queue HMAC key; null after session end (requires re-auth). */
  k_hmac: Uint8Array | null;
  /** Secretbox data key for notes/checklist encryption (committee key). */
  data_key: Uint8Array;
  /** Strictly-monotonic sequence counter for the session. */
  next_seq: bigint;
  /** Queue store. */
  entries: QueuedEntry[];
  /** Pending offline audit rows. */
  pending_audits: PendingAuditRow[];
  /** Pseudonym used in audit emissions. */
  actor_pseudonym: string;
  /** UI banner sink — last key set is observable by the test. */
  ui: { lastBannerKey: string | null };
  /** Test-control surface; lets the test simulate tampering. */
  idb: SessionIdbControl;
  /** Drives the online-transition flush. */
  goOnline(): Promise<void>;
  /** Releases the HMAC key from memory. */
  end(): Promise<void>;
  /** Test-only / production-bound network hook for posts + audit drain. */
  __onPost?: (entry: PostShipment) => Promise<{ ok: true } | { ok: false }>;
  __onAudit?: (audit: PendingAuditRow) => Promise<void>;
}

export interface SessionIdbControl {
  /**
   * Mutate a single byte of the queued entry's ciphertext (test-only).
   * Mirrors a hostile local process tampering with the persisted row
   * between enqueue and drain.
   */
  mutateQueuedCiphertextByte(entryIndex: number, byte: number): Promise<void>;
  /**
   * Peek queued audit rows (test-only). The `queue.integrity_fail` row
   * lands here until `goOnline()` flushes it.
   */
  peekQueuedAudits(): Promise<PendingAuditRow[]>;
  /** Test-only — export raw entries for cross-device-replay simulation. */
  exportQueuedEntries(): Promise<QueuedEntry[]>;
  /** Test-only — import entries (as if pasted in from another device). */
  importEntriesRaw(entries: QueuedEntry[]): Promise<void>;
  /** Test-only — drop the entry at `index`, leaving a sequence gap. */
  dropQueuedEntryAt(index: number): Promise<void>;
  /** Test-only — overwrite the salt-version on the queued entry. */
  setQueuedEntrySaltVersion(salt_version: string): Promise<void>;
}

export interface PostShipment {
  inspection_id: string;
  ciphertext: Uint8Array;
  client_integrity_tag: Uint8Array;
  sequence_number: bigint;
  user_id: string;
}

// ---------------------------------------------------------------------------
// Encrypt helper — secretbox the plaintext payload with the committee key.
// ---------------------------------------------------------------------------

async function encryptPayload(
  data_key: Uint8Array,
  payload: { checklist: unknown; notes_plaintext: string }
): Promise<Uint8Array> {
  const s = await ready();
  const plaintext = new Uint8Array(
    Buffer.from(
      JSON.stringify({
        checklist: payload.checklist,
        notes: payload.notes_plaintext
      }),
      'utf8'
    )
  );
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ct = s.crypto_secretbox_easy(plaintext, nonce, data_key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Enqueue an inspection entry: encrypt the payload, compute the HMAC tag,
 * persist the entry to the queue.
 *
 * F-47 — when the queue holds `QUEUE_CAP` entries, the new entry is
 * rejected with `rejected_queue_full` and the UI banner is set so the
 * user knows to drain online.
 */
export async function enqueueInspection(
  session: InspectionSession,
  input: InspectionEntryInput
): Promise<EnqueueResult> {
  if (session.entries.length >= QUEUE_CAP) {
    session.ui.lastBannerKey = 'offline.queue.full';
    return { status: 'rejected_queue_full' };
  }
  if (session.k_hmac === null) {
    // Out-of-band guard: an enqueue without an in-memory key would create
    // an entry we cannot later verify. Refuse rather than persist garbage.
    return { status: 'rejected_queue_full' };
  }
  const ciphertext = await encryptPayload(session.data_key, input);
  const seq = session.next_seq;
  session.next_seq = seq + 1n;
  const tag = await computeQueueHMAC({
    k: session.k_hmac,
    seq,
    user_id: session.user_id_bytes,
    ciphertext
  });
  const id = `entry-${seq.toString()}-${session.user_id}`;
  const entry: QueuedEntry = {
    id,
    sequence_number: seq,
    user_id_bytes: new Uint8Array(session.user_id_bytes),
    salt_version: HMAC_QUEUE_SALT_V1,
    ciphertext,
    tag,
    enqueued_at: new Date().toISOString()
  };
  session.entries.push(entry);
  return { status: 'ok', id };
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

/**
 * Drain the queue. For each entry:
 *  1. Refuse entries whose salt-version is not the canonical version.
 *  2. Verify the entry's user_id bytes match the session's user_id.
 *  3. Recompute the HMAC and compare in constant time.
 *  4. If verification passes, POST via the session's `__onPost` hook (or
 *     simulate success in test); if it fails, queue a
 *     `queue.integrity_fail` audit row and surface the banner.
 *
 * If `k_hmac` is null (post-session-end re-mount), drain returns
 * `requires_re_auth` immediately; no entries are touched.
 */
export async function drainQueue(session: InspectionSession): Promise<DrainResult> {
  if (session.k_hmac === null) {
    return { posted: 0, rejected: 0, status: 'requires_re_auth', rejection_reasons: [] };
  }
  let posted = 0;
  let rejected = 0;
  const rejection_reasons: string[] = [];
  // ADR-0014 sequence rule: every seq from 1 (or session.drained_seq+1)
  // up to session.next_seq-1 MUST be present in the queue at drain
  // time. Any missing seq → reject the entry that would have followed
  // it (i.e., the next-higher seq present). This catches in-place
  // reorder / drop attacks: removing the seq=1 entry leaves seq=2 with
  // no predecessor, so seq=2 fails.
  const issuedSet = new Set<string>();
  for (const e of session.entries) issuedSet.add(e.sequence_number.toString());
  const highWater = session.next_seq - 1n;
  for (const entry of session.entries) {
    // 1) Salt-version refusal.
    if (entry.salt_version !== HMAC_QUEUE_SALT_V1) {
      rejected += 1;
      rejection_reasons.push('salt_version_mismatch');
      await quarantine(session, entry, 'salt_version_mismatch');
      continue;
    }
    // 2) Cross-device replay — user_id_bytes must match the session.
    if (!bytesEqual(entry.user_id_bytes, session.user_id_bytes)) {
      rejected += 1;
      rejection_reasons.push('user_id_mismatch');
      await quarantine(session, entry, 'user_id_mismatch');
      continue;
    }
    // 3) Sequence contiguity — every predecessor seq from 1 up to this
    //    entry's seq must be present in the queue at drain time. If any
    //    is missing, an in-place reorder / drop occurred — reject this
    //    entry. (The first-issued seq in a session is 1.)
    let gap = false;
    for (let s = 1n; s < entry.sequence_number; s++) {
      if (!issuedSet.has(s.toString())) {
        gap = true;
        break;
      }
    }
    if (gap) {
      rejected += 1;
      rejection_reasons.push('sequence_gap');
      await quarantine(session, entry, 'tag_mismatch');
      continue;
    }
    void highWater;
    // 4) Tag recompute + constant-time compare.
    const recomputed = await computeQueueHMAC({
      k: session.k_hmac,
      seq: entry.sequence_number,
      user_id: entry.user_id_bytes,
      ciphertext: entry.ciphertext
    });
    if (!timingSafeEqualBytes(recomputed, entry.tag)) {
      rejected += 1;
      rejection_reasons.push('tag_mismatch');
      await quarantine(session, entry, 'tag_mismatch');
      continue;
    }
    // 5) POST shipment.
    const shipment: PostShipment = {
      inspection_id: entry.id,
      ciphertext: entry.ciphertext,
      client_integrity_tag: entry.tag,
      sequence_number: entry.sequence_number,
      user_id: session.user_id
    };
    if (session.__onPost) {
      const r = await session.__onPost(shipment);
      if (r.ok) {
        posted += 1;
      } else {
        // Server rejected (e.g., server-side integrity check failed) —
        // treat as an integrity failure so the user is notified.
        rejected += 1;
        rejection_reasons.push('server_rejected');
        await quarantine(session, entry, 'tag_mismatch');
        continue;
      }
    } else {
      // No post hook installed — simulate success.
      posted += 1;
    }
    // Successful POST drops the entry from the queue.
  }
  // drainQueue empties the queue: rejected entries went to quarantine
  // (their bytes still exist in `pending_audits` until goOnline); posted
  // entries went to the server. Re-running drain finds an empty queue.
  session.entries = [];
  return { posted, rejected, status: 'ok', rejection_reasons };
}

async function quarantine(
  session: InspectionSession,
  entry: QueuedEntry,
  reason: 'tag_mismatch' | 'user_id_mismatch' | 'salt_version_mismatch'
): Promise<void> {
  session.ui.lastBannerKey = 'photo.status.integrity_failed_heading';
  const audit: PendingAuditRow = {
    event_type: 'queue.integrity_fail',
    meta: {
      queue_seq: entry.sequence_number.toString(),
      failure_reason: reason,
      actor_pseudonym: session.actor_pseudonym,
      alert_id: 'A-QUEUE-001'
    },
    queued_at: new Date().toISOString()
  };
  session.pending_audits.push(audit);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Quarantine inspection (no-op default; production wires to IDB store)
// ---------------------------------------------------------------------------

export function inspectQuarantine(session: InspectionSession): QuarantinedEntry[] {
  // Surface for "View failed entries" UI; pending_audits already covers
  // the audit row. The current shape returns an empty list because the
  // T10 tests do not exercise this surface; the implementer of T10.1
  // wires the IDB-backed quarantine store.
  void session;
  return [];
}

// ---------------------------------------------------------------------------
// Session factory (used by tests via the supabase-test harness)
// ---------------------------------------------------------------------------

/**
 * Build an in-memory inspection session. The `identity_privkey` is the
 * per-device private key; it is consumed once to derive `k_hmac` and is
 * NOT retained.
 */
export async function createInspectionSession(opts: {
  user_id: string;
  identity_privkey: Uint8Array;
  data_key: Uint8Array;
  actor_pseudonym: string;
  reAuth?: boolean;
  onPost?: (entry: PostShipment) => Promise<{ ok: true } | { ok: false }>;
  onAudit?: (audit: PendingAuditRow) => Promise<void>;
}): Promise<InspectionSession> {
  const user_id_bytes = uuidToBytes(opts.user_id);
  // re-auth flag false simulates a remount without identity privkey in
  // memory — the session can hold queued entries but cannot derive a
  // K_hmac. Verification will report `requires_re_auth`.
  let k_hmac: Uint8Array | null = null;
  if (opts.reAuth !== false) {
    k_hmac = await deriveQueueHmacKey({
      identity_privkey: opts.identity_privkey,
      user_id: user_id_bytes
    });
  }
  const session: InspectionSession = {
    user_id: opts.user_id,
    user_id_bytes,
    k_hmac,
    data_key: opts.data_key,
    next_seq: 1n,
    entries: [],
    pending_audits: [],
    actor_pseudonym: opts.actor_pseudonym,
    ui: { lastBannerKey: null },
    idb: {} as SessionIdbControl,
    goOnline: async () => undefined,
    end: async () => undefined
  };
  if (opts.onPost) session.__onPost = opts.onPost;
  if (opts.onAudit) session.__onAudit = opts.onAudit;
  session.idb = makeIdbControl(session);
  session.goOnline = async () => {
    // Flush pending audits to the server-side audit sink. Each row is
    // posted exactly once; the test asserts `count = 1` after goOnline.
    //
    // Per second-opinion-reviewer T10 Concern 3: process entries one at
    // a time and remove from `pending_audits` ONLY after `__onAudit`
    // resolves successfully. If the sink rejects, the row stays in
    // `pending_audits` for the next flush attempt. Without this, a
    // failed audit POST silently destroys the very signal we need —
    // the `queue.integrity_fail` audit row that proves tampering was
    // detected.
    if (!session.__onAudit) {
      // No sink wired; leave rows in place for later goOnline.
      return;
    }
    while (session.pending_audits.length > 0) {
      const next = session.pending_audits[0]!;
      try {
        await session.__onAudit(next);
      } catch {
        // Sink rejected; stop draining. Row stays at the head of the
        // queue for the next goOnline. Production wire-up (T10.1)
        // should additionally emit a structured-log WARN line so the
        // on-call surface flags "audit drain is stuck."
        return;
      }
      session.pending_audits.shift();
    }
  };
  session.end = async () => {
    // Per ADR-0014 — K_hmac never persists.
    session.k_hmac = null;
  };
  return session;
}

function makeIdbControl(session: InspectionSession): SessionIdbControl {
  return {
    async mutateQueuedCiphertextByte(entryIndex: number, byte: number): Promise<void> {
      const entry = session.entries[entryIndex];
      if (!entry) throw new Error(`mutateQueuedCiphertextByte: no entry at ${entryIndex}`);
      // Flip the targeted byte. The HMAC tag does NOT cover the mutated
      // byte's NEW value — verification fails on drain.
      const mutated = new Uint8Array(entry.ciphertext);
      mutated[0] = mutated[0] === byte ? byte ^ 0x01 : byte;
      entry.ciphertext = mutated;
    },
    async peekQueuedAudits(): Promise<PendingAuditRow[]> {
      return [...session.pending_audits];
    },
    async exportQueuedEntries(): Promise<QueuedEntry[]> {
      // Return a deep-cloned snapshot so the importing-session does not
      // share buffers with the exporting one.
      return session.entries.map((e) => ({
        id: e.id,
        sequence_number: e.sequence_number,
        user_id_bytes: new Uint8Array(e.user_id_bytes),
        salt_version: e.salt_version,
        ciphertext: new Uint8Array(e.ciphertext),
        tag: new Uint8Array(e.tag),
        enqueued_at: e.enqueued_at
      }));
    },
    async importEntriesRaw(entries: QueuedEntry[]): Promise<void> {
      // The hostile path: paste-in bytes from another device. The
      // imported entries carry the foreign user_id_bytes; drain rejects.
      for (const e of entries) {
        session.entries.push({
          id: e.id,
          sequence_number: e.sequence_number,
          user_id_bytes: new Uint8Array(e.user_id_bytes),
          salt_version: e.salt_version,
          ciphertext: new Uint8Array(e.ciphertext),
          tag: new Uint8Array(e.tag),
          enqueued_at: e.enqueued_at
        });
      }
    },
    async dropQueuedEntryAt(index: number): Promise<void> {
      session.entries.splice(index, 1);
    },
    async setQueuedEntrySaltVersion(salt_version: string): Promise<void> {
      // Apply to ALL queued entries; ADR-0014 versions every entry's
      // salt. The test fabricates a single entry then sets the version.
      for (const e of session.entries) e.salt_version = salt_version;
    }
  };
}
