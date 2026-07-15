/**
 * Edge Function shared structured logger.
 *
 * Source contract: observability/logging.md §4 (Edge Function rules).
 *
 * This module is consumed in two runtimes:
 *   1. **Deno** (Supabase Edge Functions in production + `deno test`
 *      under supabase/functions/_shared/test/log.test.ts).
 *   2. **Node** (Vitest dynamic-imports it from the T02 structured-logger
 *      test to prove single-source-of-truth on the safeFields allowlist).
 *
 * It must therefore avoid Deno- or Node-specific imports at top level
 * and use only ECMAScript primitives that both runtimes ship.
 *
 * Per observability/logging.md §4, the shared logger:
 *   - Drops PI keys (denylist) silently and emits a CI-visible WARN.
 *   - Drops unknown safeFields keys silently and emits a CI-visible WARN.
 *   - Propagates request_id when caller supplies it (or when X-Request-ID
 *     header is set on the underlying Request — that wiring is in the
 *     per-function handler, not here).
 *   - Reports `service` as `edge-fn:<name>` (the function name is
 *     attached via `withFunctionName(...)`).
 *
 * The implementer of T02 may extend this module to honour F-09 fully
 * (e.g., per-function `service` derivation from Deno.env vars at request
 * time). The scaffolder's role is to keep the safeFields allowlist
 * identical to the browser surface and to provide the test sink.
 */

// ---- Inlined allowlist + denylist (must match src/lib/log/safe-fields.ts) ---
//
// We inline these so the module is self-contained in Deno (which doesn't
// resolve TS path aliases out of the box). A scripts/verify-safefields-drift.sh
// gate verifies the two surfaces stay aligned in a follow-up CI pass.

const SAFE_FIELDS: ReadonlySet<string> = new Set([
  'route',
  'outcome',
  'latency_ms',
  'attempt',
  'rate_limit_key_class',
  'feature_flag',
  'release',
  'auth.method',
  'auth.result',
  'auth.totp_consumed',
  'auth.session_id_pseudonym',
  // ADR-0023 Amendment A / F-128 (mint-session race-loss detector).
  // ADR-0024 §2 (cold-start parity check outcome).
  // Both values are closed-set literals; no PI surface.
  'auth.mint.outcome',
  'key_parity.outcome',
  'key_parity.surface',
  'audit.event_type',
  'audit.target_class',
  'audit.target_id_pseudonym',
  'audit.rotation_id',
  'concern.action',
  'concern.anonymous_default',
  'concern.hazard_class',
  'concern.severity',
  'sync.entries_drained',
  'sync.entries_rejected_hmac_fail',
  'sync.queue_depth',
  'cache.policy_violation',
  'cache.allowlist_version',
  'export.kind',
  'export.field_set_hash',
  'export.derived_from_concerns_count',
  'export.recipient_role',
  'c4.table',
  'c4.read_via',
  'c4.access_attempt_outcome',
  'retention.table',
  'retention.deleted_count',
  'retention.dry_run',
  'integrity.last_good_seq',
  'integrity.first_bad_seq',
  'integrity.trigger',
  'backup.bucket',
  'backup.age_hours',
  'drift.field',
  'drift.expected',
  'drift.observed',
  // M9 alert dispatch (lib/alerts).
  'alert.symbol',
  'alert.severity',
  'alert.source',
  'alert.ts_ms',
  'alert.run_id',
  'alert.outcome',
  'alert.would_delete_total',
  'alert.deleted_total',
  'alert.deleted_count',

  // Baseline multi-epoch anti-lockout read miss (F182-9 / ADR-0031 Decision 5 /
  // F-183-B-OBS). Key-material-FREE telemetry ONLY — a COUNT of held epochs +
  // two booleans. NEVER a key_id VALUE, key bytes, or plaintext (F-148). Must
  // stay identical to src/lib/log/safe-fields.ts (single-source allowlist id).
  'epochs_held',
  'escalated',
  'row_epoch_held'
]);

const PI_DENYLIST: ReadonlySet<string> = new Set([
  'display_name',
  'displayname',
  'off_employer_contact',
  'email',
  'phone',
  'phone_number',
  'contact',
  'address',
  'home_address',
  'cookie',
  'set-cookie',
  'authorization',
  'jwt',
  'access_token',
  'refresh_token',
  'totp',
  'totp_code',
  'totp_secret',
  'passkey',
  'passkey_assertion',
  'webauthn_response',
  'webauthn_credential',
  'api_key',
  'apikey',
  'session_token',
  'csrf_token',
  'password',
  'recovery_passphrase',
  'recovery_blob',
  'user_id',
  'user_uuid',
  'supabase_uid',
  'auth_uid',
  'sub',
  'body',
  'payload',
  'form',
  'form_data',
  'formdata',
  'req_body',
  'request_body',
  'message',
  'title_ct',
  'title_ciphertext',
  'body_ct',
  'body_ciphertext',
  'notes_ct',
  'notes_ciphertext',
  'draft_body_ct',
  'draft_body_ciphertext',
  'final_body_ct',
  'final_body_ciphertext',
  'employer_response_ct',
  'employer_response_ciphertext',
  'source_name_ct',
  'source_name_ciphertext',
  'reprisal_body_ct',
  'reprisal_body_ciphertext',
  'work_refusal_notes_ct',
  'work_refusal_notes_ciphertext',
  's51_evidence_ct',
  's51_evidence_ciphertext',
  's51_photo_ct',
  'evidence_ct',
  'evidence_ciphertext'
]);

function computeAllowlistId(): string {
  const sorted = [...SAFE_FIELDS].sort();
  let h = 0x811c9dc5;
  for (const k of sorted) {
    for (let i = 0; i < k.length; i++) {
      h ^= k.charCodeAt(i);
      // Math.imul exists in both Deno and Node.
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return `safe-fields/v1/${h.toString(16).padStart(8, '0')}`;
}

export const SAFE_FIELDS_ALLOWLIST_ID = computeAllowlistId();

// ---- Types -----------------------------------------------------------------

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export interface LogLine {
  ts: string;
  level: LogLevel;
  service: string;
  env: string;
  release: string;
  event: string;
  request_id?: string;
  actor_pseudonym?: string;
  route?: string;
  outcome?: string;
  latency_ms?: number;
  error_class?: string;
  attributes?: Record<string, unknown>;
}

export interface LogCall {
  event: string;
  request_id?: string;
  actor_pseudonym?: string;
  route?: string;
  outcome?: string;
  error_class?: string;
  attributes?: Record<string, unknown>;
}

// ---- Service / env / release detection -------------------------------------

let serviceTag = 'edge-fn:_shared';

export function withFunctionName(name: string): void {
  serviceTag = `edge-fn:${name}`;
}

function detectEnv(): string {
  // Deno exposes `Deno.env.get`; Node exposes `process.env`. We avoid hard
  // dependence on either in the type system.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (globalThis as any).Deno;
  if (d && typeof d.env?.get === 'function') {
    const v = d.env.get('DENO_ENV') ?? d.env.get('NODE_ENV');
    if (v === 'production') return 'prod';
    if (v === 'test') return 'test';
    if (v === 'ci') return 'ci';
    return 'dev';
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (globalThis as any).process;
  if (p && p.env) {
    const v = p.env.NODE_ENV;
    if (v === 'production') return 'prod';
    if (v === 'test') return 'test';
    if (v === 'ci') return 'ci';
    return 'dev';
  }
  return 'dev';
}

function detectRelease(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (globalThis as any).Deno;
  if (d && typeof d.env?.get === 'function') {
    return d.env.get('RELEASE') ?? 'dev';
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (globalThis as any).process;
  if (p && p.env?.RELEASE) return String(p.env.RELEASE);
  return 'dev';
}

// ---- Test sink -------------------------------------------------------------

let testSink: ((line: LogLine) => void) | null = null;

function emitWarn(msg: string): void {
  // Both Deno and Node expose console.warn.
  console.warn(msg);
}

function scrubAttributes(
  raw: Record<string, unknown> | undefined,
  callEvent: string
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const out: Record<string, unknown> = {};
  let dropped = 0;
  const unknownKeys: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const lower = k.toLowerCase();
    if (PI_DENYLIST.has(lower)) {
      dropped++;
      continue;
    }
    if (!SAFE_FIELDS.has(k)) {
      dropped++;
      unknownKeys.push(k);
      continue;
    }
    out[k] = v;
  }
  if (dropped > 0) {
    const env = detectEnv();
    if (env === 'test' || env === 'ci' || env === 'dev') {
      emitWarn(
        `[edge-log] dropped ${dropped} attr(s) ` +
          `not on safeFields/denylist on event "${callEvent}"` +
          (unknownKeys.length ? ` — unknown keys: ${unknownKeys.join(', ')}` : '')
      );
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function emit(level: LogLevel, call: LogCall): void {
  if (level === 'DEBUG' && detectEnv() === 'prod') return;
  const attributes = scrubAttributes(call.attributes, call.event);
  const ts = new Date().toISOString();
  const line: LogLine = {
    ts,
    level,
    service: serviceTag,
    env: detectEnv(),
    release: detectRelease(),
    event: call.event,
    ...(call.request_id !== undefined ? { request_id: call.request_id } : {}),
    ...(call.actor_pseudonym !== undefined ? { actor_pseudonym: call.actor_pseudonym } : {}),
    ...(call.route !== undefined ? { route: call.route } : {}),
    ...(call.outcome !== undefined ? { outcome: call.outcome } : {}),
    ...(call.error_class !== undefined ? { error_class: call.error_class } : {}),
    ...(attributes !== undefined ? { attributes } : {})
  };

  if (testSink) {
    testSink(line);
    return;
  }
  // Default transport: JSON-line to stdout (Supabase platform aggregates).
  if (level === 'ERROR' || level === 'FATAL') {
    console.error(JSON.stringify(line));
  } else {
    console.log(JSON.stringify(line));
  }
}

interface EdgeLog {
  debug: (call: LogCall) => void;
  info: (call: LogCall) => void;
  warn: (call: LogCall) => void;
  error: (call: LogCall) => void;
  fatal: (call: LogCall) => void;
  __setTestSink: (sink: ((line: LogLine) => void) | null) => void;
  __resetTestSink: () => void;
}

export const log: EdgeLog = {
  debug: (call) => emit('DEBUG', call),
  info: (call) => emit('INFO', call),
  warn: (call) => emit('WARN', call),
  error: (call) => emit('ERROR', call),
  fatal: (call) => emit('FATAL', call),
  __setTestSink: (sink) => {
    testSink = sink;
  },
  __resetTestSink: () => {
    testSink = null;
  }
};
