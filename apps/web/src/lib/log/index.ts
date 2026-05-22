/**
 * Browser + server structured logger.
 *
 * Source contract: observability/logging.md §2–§4.
 *
 * Behaviour summary (tests at apps/web/test/T02/structured-logger.test.ts):
 *   - Every emitted line carries {ts, level, service, env, release, event}.
 *   - Unknown attribute keys (not in safeFields) are dropped silently AND
 *     a CI-visible WARN is emitted to console.warn so the call site is
 *     fixed (ADR-0010 Amendment F-D Rule 2).
 *   - PI keys from the denylist are dropped silently (defense in depth).
 *   - request_id propagates from caller-provided field.
 *   - log.debug emits in dev/test; build-time excluded in production.
 *   - log.error captures error_class only; .message-class fields are
 *     dropped (may carry PI).
 *   - Determinism: identical input → identical output.
 *
 * Transport: in dev/test, lines go through a test sink (see ./test-sink).
 * In production the logger POSTs batches to /api/log/ingest (Edge Function);
 * that wiring is deferred to the T02 implementer once the edge function
 * lands.
 */
import { SAFE_FIELDS, PI_DENYLIST } from './safe-fields';
import { getTestSink } from './test-sink';

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

function detectService(): string {
  // SvelteKit / Vite + Node: best-effort. Edge Functions use a different
  // module (supabase/functions/_shared/log.ts) and report `edge-fn:<name>`.
  if (typeof window !== 'undefined') return 'web-browser';
  return 'web-server';
}

function detectEnv(): string {
  const mode = (typeof process !== 'undefined' && process.env?.NODE_ENV) || 'development';
  if (mode === 'production') return 'prod';
  if (mode === 'test') return 'test';
  if (mode === 'ci') return 'ci';
  return 'dev';
}

function detectRelease(): string {
  if (typeof process !== 'undefined' && process.env?.RELEASE) {
    return String(process.env.RELEASE);
  }
  return 'dev';
}

const SERVICE = detectService();

function scrubAttributes(
  raw: Record<string, unknown> | undefined,
  callEvent: string
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const out: Record<string, unknown> = {};
  let droppedUnknown = 0;
  let droppedDenylist = 0;
  const unknownKeys: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const lower = k.toLowerCase();
    if (PI_DENYLIST.has(lower)) {
      droppedDenylist++;
      continue;
    }
    if (!SAFE_FIELDS.has(k)) {
      droppedUnknown++;
      unknownKeys.push(k);
      continue;
    }
    out[k] = v;
  }

  if (droppedUnknown > 0 || droppedDenylist > 0) {
    // ADR-0010 Amendment F-D Rule 2: surface the drop in test/CI env so
    // the call site gets fixed.
    const env = detectEnv();
    if (env === 'test' || env === 'ci' || env === 'dev') {
      console.warn(
        `[log] dropped ${droppedUnknown + droppedDenylist} attr(s) ` +
          `not on safeFields/denylist on event "${callEvent}"` +
          (unknownKeys.length ? ` — unknown keys: ${unknownKeys.join(', ')}` : '')
      );
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function emit(level: LogLevel, call: LogCall): void {
  // DEBUG is excluded in prod.
  if (level === 'DEBUG' && detectEnv() === 'prod') return;

  const attributes = scrubAttributes(call.attributes, call.event);

  // Deterministic timestamp — Date.now() is frozen by vi.useFakeTimers
  // in tests; in production it's wall-clock.
  const ts = new Date().toISOString();

  const line: LogLine = {
    ts,
    level,
    service: SERVICE,
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

  const sink = getTestSink();
  if (sink) {
    sink(line);
    return;
  }

  // Production transport scaffolding — implementer of T02 wires this to
  // POST /api/log/ingest with batching (logging.md §5). For now,
  // emit to console.error to keep visibility without third-party transports.
  if (level === 'ERROR' || level === 'FATAL') {
    console.error(JSON.stringify(line));
  } else if (level === 'WARN') {
    console.warn(JSON.stringify(line));
  }
}

export const log = {
  debug: (call: LogCall): void => emit('DEBUG', call),
  info: (call: LogCall): void => emit('INFO', call),
  warn: (call: LogCall): void => emit('WARN', call),
  error: (call: LogCall): void => emit('ERROR', call),
  fatal: (call: LogCall): void => emit('FATAL', call)
};

// Re-export the allowlist id so callers can prove single-source-of-truth.
export { SAFE_FIELDS_ALLOWLIST_ID } from './safe-fields';
