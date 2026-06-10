/**
 * Demo audit-row provider for /audit's worker-side viewer.
 *
 * The real audit-op Edge Function + Merkle integrity chain is a
 * separate, larger PR (T18). Until that ships, /audit needs SOMETHING
 * realistic to render so a worker can see what the surface looks like
 * — empty placeholder copy is honest but not informative.
 *
 * Strategy:
 *   - Generate a deterministic-but-realistic-looking set of audit
 *     rows spanning the past N days.
 *   - Event types are drawn from the canonical audit-enum (audit-log
 *     enum coverage gate at scripts/check-audit-enum-coverage.sh
 *     enforces the catalog). Picking from the live enum keeps the
 *     demo aligned with the real surface — when the real provider
 *     swaps in, the column rendering doesn't change.
 *   - Pseudonymized actor strings (no PI). Mirrors ADR-0016
 *     HMAC-pseudonymization shape but uses a deterministic hash so
 *     the demo data is reproducible across renders.
 *
 * Out of scope here (handled by the real audit-op provider later):
 *   - Server-side Merkle proofs.
 *   - Cursor-based pagination against a real database.
 *   - Role-aware filtering (the worker co-chair sees more than an
 *     ordinary member; the demo provider returns the same rows to
 *     everyone for the purposes of UI verification).
 */

export interface DemoAuditRow {
  /** Server-issued opaque row id. */
  id: string;
  /** UTC ISO 8601 timestamp. */
  ts: string;
  /** Canonical audit-log event type (dot-separated). */
  event_type: string;
  /**
   * HMAC-pseudonymized actor ID. Truncated to the first 12 hex chars
   * for display; the full 64-char hash is server-side only.
   */
  actor_pseudonym: string;
  /** Free-form meta — the viewer renders the first 2-3 keys as chips. */
  meta: Record<string, string | number | boolean | null>;
}

export interface DemoAuditPage {
  rows: DemoAuditRow[];
  total: number;
  /** Zero-indexed page number. */
  page: number;
  page_size: number;
}

/**
 * Canonical event types drawn from observability/audit-log.md /
 * scripts/check-audit-enum-coverage.sh. Keeping the list aligned
 * here means the demo viewer doesn't surface fictional events.
 */
const EVENT_TYPES: readonly string[] = [
  'session.created',
  'session.revoked',
  'panic_wipe.invoked',
  'recovery_blob.viewed',
  'recovery_blob.stored',
  'identity_keypair.created',
  'concern.created',
  'concern.updated',
  'concern.source_revealed',
  'reprisal.created',
  'reprisal.updated',
  'work_refusal.created',
  's51_evidence.created',
  'committee_member.added',
  'committee_member.revoked',
  'audit_log.read'
];

/**
 * Twelve-char pseudonymized actor strings. Real ADR-0016 actor IDs
 * are HMAC-SHA256 → 64 hex chars; the viewer truncates to 12 for
 * display. We use a small pool so multiple rows share an actor —
 * mirrors the real-world "the worker certified member did seven
 * things this week" shape.
 */
const DEMO_ACTORS: readonly string[] = [
  'a1b2c3d4e5f6',
  '7890abcdef12',
  '3456789abcde',
  'f0e1d2c3b4a5',
  '0987654321ab',
  'feedfacebeef'
];

/**
 * Per-event-type meta sketches. Keep keys short + values opaque so
 * the demo doesn't accidentally educate the reader into expecting
 * real PI fields. The real audit-op response uses the same shape;
 * the viewer's chip-row layout works for any small object.
 */
const META_BY_EVENT: Record<string, () => Record<string, string | number | boolean | null>> = {
  'session.created': () => ({
    session_id: 'sess-' + Math.floor(Math.random() * 9999),
    ttl_ms: 300_000
  }),
  'session.revoked': () => ({ session_id: 'sess-' + Math.floor(Math.random() * 9999) }),
  'panic_wipe.invoked': () => ({ surface: 'settings', completed: true }),
  'recovery_blob.viewed': () => ({ reveal_count: Math.ceil(Math.random() * 3) }),
  'recovery_blob.stored': () => ({ kdf_alg: 'argon2id13', ttl_days: 365 }),
  'identity_keypair.created': () => ({ ident_pubkey_fingerprint: '7e8f9a0b' }),
  'concern.created': () => ({
    hazard_class: 'physical',
    severity: 'medium',
    anonymous_default_kept: true
  }),
  'concern.updated': () => ({ concern_id: 'con-' + Math.floor(Math.random() * 999) }),
  'concern.source_revealed': () => ({ concern_id: 'con-' + Math.floor(Math.random() * 999) }),
  'reprisal.created': () => ({
    reprisal_id: 'rep-' + Math.floor(Math.random() * 99),
    consent_kept: true
  }),
  'reprisal.updated': () => ({ reprisal_id: 'rep-' + Math.floor(Math.random() * 99) }),
  'work_refusal.created': () => ({ stage: 'worker_refusal', section: 's43' }),
  's51_evidence.created': () => ({ photo_count: Math.floor(Math.random() * 4) }),
  'committee_member.added': () => ({
    membership_id: 'mem-' + Math.floor(Math.random() * 99),
    role: 'worker_certified'
  }),
  'committee_member.revoked': () => ({ membership_id: 'mem-' + Math.floor(Math.random() * 99) }),
  'audit_log.read': () => ({ rows_returned: Math.floor(Math.random() * 50) })
};

/**
 * Build a deterministic-ish demo dataset of N rows spanning the past
 * 7 days. Same seed → same rows (the seed defaults to a fixed value
 * so the demo viewer is stable across renders, but tests can vary it).
 */
export function buildDemoAuditRows(count: number, seed = 42): DemoAuditRow[] {
  // Tiny PRNG so the same `seed` always produces the same sequence.
  // Mulberry32 — good enough for synthetic demo data, not for crypto.
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const now = Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const rows: DemoAuditRow[] = [];
  for (let i = 0; i < count; i++) {
    const ev = EVENT_TYPES[Math.floor(rand() * EVENT_TYPES.length)]!;
    const actor = DEMO_ACTORS[Math.floor(rand() * DEMO_ACTORS.length)]!;
    const ago = Math.floor(rand() * SEVEN_DAYS_MS);
    const ts = new Date(now - ago).toISOString();
    rows.push({
      id: 'row-' + i.toString().padStart(6, '0'),
      ts,
      event_type: ev,
      actor_pseudonym: actor,
      meta: META_BY_EVENT[ev]!()
    });
  }
  // Newest first — mirrors what the real query will return.
  rows.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return rows;
}

/**
 * Page-based fetch helper. The viewer treats this signature as the
 * provider contract so the real audit-op provider (cursor-based)
 * just needs an adapter when it lands.
 *
 * Optional `predicate` narrows the dataset before pagination, so
 * `total` reflects the filtered count.
 */
export async function fetchDemoAuditPage(
  page: number,
  page_size: number,
  all: DemoAuditRow[],
  predicate?: (row: DemoAuditRow) => boolean
): Promise<DemoAuditPage> {
  const filtered = predicate ? all.filter(predicate) : all;
  const start = page * page_size;
  return {
    rows: filtered.slice(start, start + page_size),
    total: filtered.length,
    page,
    page_size
  };
}
