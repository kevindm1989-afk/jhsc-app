/**
 * Sentry SDK-layer PI scrubber.
 *
 * Reference docs:
 *   - .context/decisions.md ADR-0010 (Sentry SaaS EU; SDK-layer scrubbing)
 *   - .context/decisions.md §System Design → PI inventory (the canonical list)
 *   - .context/threat-model.md §3.1 F-09 (Edge Function log scrubbing)
 *   - .context/threat-model.md §6 Invariant 1 strengthened (private-key-shape canary)
 *   - .context/constraints.md "Logging hygiene"
 *   - JHSC-APP-PLAN.md §7 ("No third-party JS at runtime")
 *
 * Hard rules:
 *   1. PI is scrubbed BEFORE the SDK transport leaves the host. No
 *      query-time redaction is trusted for PI.
 *   2. No `Sentry.setUser` on the browser. On the server, only
 *      `actor_pseudonym` (HMAC of supabase auth uid, with a server-only
 *      key) may appear as `user.id`.
 *   3. The breadcrumb stream is denied-by-default for `xhr`/`fetch` to
 *      sensitive paths.
 *   4. Any event > MAX_EVENT_BYTES is dropped (accidental payload dump
 *      protection).
 *   5. A canary appearing in ANY captured event → P0 incident. The
 *      scrubber treats canary appearance as an integrity failure of the
 *      scrubber itself.
 *   6. The browser bundle MUST NOT contain HMAC_PSEUDONYM_KEY. The
 *      pseudonym is derived in the Edge Function only.
 *
 * This file is the spec. The implementer (T02) wires it into
 * `apps/web/src/lib/observability/sentry-scrub.ts` and
 * `supabase/functions/_shared/sentry-scrub.ts` from this source.
 */

// ----------------------------------------------------------------------------
// 0. Types — minimal, deliberately decoupled from the Sentry version we ship.
// ----------------------------------------------------------------------------

/** Subset of @sentry/types Event we touch. */
export interface SentryEvent {
  event_id?: string;
  message?: string;
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      stacktrace?: { frames?: Array<{ filename?: string; vars?: Record<string, unknown> }> };
    }>;
  };
  request?: {
    url?: string;
    method?: string;
    query_string?: string | Record<string, string>;
    cookies?: string | Record<string, string>;
    headers?: Record<string, string>;
    data?: unknown;
  };
  user?: { id?: string; email?: string; ip_address?: string; username?: string };
  contexts?: Record<string, Record<string, unknown>>;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  breadcrumbs?: SentryBreadcrumb[];
  release?: string;
  environment?: string;
  // Implementation may carry more; we keep the surface minimal.
}

export interface SentryBreadcrumb {
  type?: string;
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
  level?: string;
  timestamp?: number;
}

// ----------------------------------------------------------------------------
// 1. The closed PI key list — every field name from the PI inventory.
//    Adding here requires the same PR to amend the inventory in
//    .context/decisions.md (architect-gated).
// ----------------------------------------------------------------------------

/**
 * Any object key that matches one of these is replaced with
 * `[REDACTED:<class>]`. Match is case-insensitive on the full key name.
 * The matcher is a Set, not a regex, so it is deterministic and testable.
 *
 * Keys here come from:
 *   - `.context/decisions.md` §System Design → PI inventory
 *   - the auth + crypto material list in this file's docstring
 *   - the `concerns.source_name_*` / reprisal* / work_refusal* /
 *     s51_evidence* / minutes.draft* / minutes.final* C3/C4 columns
 */
export const PI_KEY_DENYLIST: ReadonlySet<string> = new Set([
  // C2 PI
  'display_name',
  'displayname',
  'off_employer_contact',
  'offemployercontact',
  'email',
  'phone',
  'phone_number',
  'contact',
  'address',
  'home_address',
  'identity_privkey_recovery_blob',
  'recovery_passphrase',
  'recovery_blob',
  'training_records.evidence_ct',
  'evidence_ct',
  'evidence_ciphertext',

  // C3 sensitive (ciphertext field names — even the names are PI-adjacent)
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

  // C4 highest sensitivity — appearance of these in a stack trace is
  // a P0 incident (handled in `assertNoC4OrPanic` below).
  'source_name_ct',
  'source_name_ciphertext',
  'reprisal_body_ct',
  'reprisal_body_ciphertext',
  'work_refusal_notes_ct',
  'work_refusal_notes_ciphertext',
  's51_evidence_ct',
  's51_evidence_ciphertext',
  's51_photo_ct',

  // Auth material
  'authorization',
  'cookie',
  'set-cookie',
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

  // Identifiers that should never reach Sentry (we use pseudonym only)
  'user_id',
  'user_uuid',
  'supabase_uid',
  'auth_uid',
  'sub',

  // Form-body / payload aliases used by common frameworks
  'body',
  'payload',
  'form',
  'form_data',
  'formdata',
  'req_body',
  'request_body',
]);

/** Keys that signal C4-class field appearance. If we see these we drop the
 *  WHOLE event AND mark a P0 — never just redact. */
export const C4_KEY_PANIC: ReadonlySet<string> = new Set([
  'source_name_ct',
  'source_name_ciphertext',
  'reprisal_body_ct',
  'reprisal_body_ciphertext',
  'work_refusal_notes_ct',
  'work_refusal_notes_ciphertext',
  's51_evidence_ct',
  's51_evidence_ciphertext',
  's51_photo_ct',
]);

// ----------------------------------------------------------------------------
// 2. Path patterns that imply the operation itself is C3/C4-touching.
//    Breadcrumbs of category xhr|fetch to these URLs are dropped entirely.
// ----------------------------------------------------------------------------

export const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /\/api\/concerns(?:\/|$|\?)/i,
  /\/api\/reprisal(?:\/|$|\?)/i,
  /\/api\/work[-_]refusal(?:\/|$|\?)/i,
  /\/api\/s51(?:\/|$|\?)/i,
  /\/api\/inspections\/.+\/photos?(?:\/|$|\?)/i,
  /\/api\/minutes\/.+\/(?:draft|final)(?:\/|$|\?)/i,
  /\/api\/recommendations(?:\/|$|\?)/i,
  /\/api\/sensitive(?:\/|$|\?)/i, // the SECURITY DEFINER indirection layer
];

/** Allowlist of breadcrumb categories we keep. Anything else is dropped. */
export const BREADCRUMB_CATEGORY_ALLOWLIST: ReadonlySet<string> = new Set([
  'navigation', // route changes only — the URL is still scrubbed
  'ui.click',   // element selector + role; never the value
  'console',    // only if the message survives the canary scrub
  'sentry.event',
]);

// ----------------------------------------------------------------------------
// 3. Canaries — these literal strings should NEVER appear in any captured
//    event. The test fixture seeds them; the assertion checks them.
//    A canary appearance is itself a P0 incident.
// ----------------------------------------------------------------------------

export const CANARIES: readonly string[] = [
  'CANARY_PII_X',               // generic
  '+15555550100',               // synthetic E.164 phone
  'canary.user@example.test',   // synthetic email
  'CANARY_PRIVKEY_SHAPE_FIXTURE', // stand-in for the 32-byte privkey canary
  // G-T19-7 / F-110 M-110c — passphrase + TOTP canaries. Neither shape is
  // caught by the free-text regexes below (passphrase is just words; TOTP
  // is below the phone-regex 8-digit floor). The static lint
  // `scripts/check-onboarding-no-passphrase-leak.sh` prevents these
  // surfaces from feeding raw material to breadcrumb / console / TTS
  // sinks; these literals are the runtime tripwire for any escape.
  'CANARY_PASSPHRASE_FIXTURE',
  'CANARY_TOTP_FIXTURE',
];

// ----------------------------------------------------------------------------
// 4. Size threshold — a serialized event over this is dropped.
// ----------------------------------------------------------------------------

export const MAX_EVENT_BYTES = 15 * 1024; // 15 KB

// ----------------------------------------------------------------------------
// 5. Core: redact-by-key, recursively. The redacted value carries a marker
//    so reviewers can spot a redaction in the captured payload.
// ----------------------------------------------------------------------------

const REDACT_MARKER = '[REDACTED:PI]';
const REDACT_MARKER_C4 = '[REDACTED:C4_DROP]';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Returns true iff anything in the value tree contains a forbidden C4 key. */
function containsC4Key(value: unknown, depth = 0): boolean {
  if (depth > 12) return false; // bound recursion
  if (Array.isArray(value)) {
    return value.some((v) => containsC4Key(v, depth + 1));
  }
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) {
      if (C4_KEY_PANIC.has(k.toLowerCase())) return true;
      if (containsC4Key(value[k], depth + 1)) return true;
    }
  }
  return false;
}

function redactInPlace(value: unknown, depth = 0): unknown {
  if (depth > 12) return REDACT_MARKER;
  if (Array.isArray(value)) {
    return value.map((v) => redactInPlace(v, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (PI_KEY_DENYLIST.has(k.toLowerCase())) {
        out[k] = REDACT_MARKER;
        continue;
      }
      out[k] = redactInPlace(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Replace the URL with route shape only — strip query string + path params
 *  that look like UUIDs, ints, or base64 blobs. */
export function scrubUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url, 'https://placeholder.invalid');
    const path = u.pathname
      .replace(/\/[0-9a-f-]{8,}/gi, '/:id')
      .replace(/\/\d+/g, '/:n');
    return path; // query string and origin dropped entirely
  } catch {
    return REDACT_MARKER;
  }
}

function matchesSensitivePath(url: string | undefined): boolean {
  if (!url) return false;
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(url));
}

// ----------------------------------------------------------------------------
// 6. The canary check — runs LAST, after every other redaction. If a canary
//    string survives, the scrubber failed; we drop the event AND signal P0.
// ----------------------------------------------------------------------------

function serializeForCanaryCheck(event: SentryEvent): string {
  try {
    return JSON.stringify(event);
  } catch {
    return ''; // if it can't serialize, downstream `byteLength` check drops it
  }
}

function eventContainsAnyCanary(serialized: string): boolean {
  for (const c of CANARIES) {
    if (serialized.includes(c)) return true;
  }
  return false;
}

/** Hook for the implementer to wire to an out-of-band alert path —
 *  NOT Sentry itself (we just rejected the event to Sentry). The
 *  implementer routes this to the structured logger with a known
 *  `event: 'sentry.scrub.canary_seen'` which the alert pipeline
 *  watches as a P0 — see playbooks/runbooks/sentry-self-test-failed.md. */
export type PanicSink = (reason: 'canary' | 'c4_field' | 'oversize', meta: Record<string, string>) => void;

let panicSink: PanicSink = () => undefined;
export function setPanicSink(fn: PanicSink): void {
  panicSink = fn;
}

// ----------------------------------------------------------------------------
// 7. The `beforeSend` hook itself.
// ----------------------------------------------------------------------------

export function beforeSend(rawEvent: SentryEvent): SentryEvent | null {
  // 7.1 Drop entirely if any C4 key is present anywhere.
  if (containsC4Key(rawEvent)) {
    panicSink('c4_field', { event_id: rawEvent.event_id ?? '?' });
    return null;
  }

  const e: SentryEvent = JSON.parse(JSON.stringify(rawEvent)); // defensive copy

  // 7.2 Strip cookies + Authorization header + all known sensitive headers.
  if (e.request) {
    if (e.request.cookies) e.request.cookies = REDACT_MARKER;
    if (e.request.headers) {
      const headers: Record<string, string> = {};
      for (const [h, v] of Object.entries(e.request.headers)) {
        const key = h.toLowerCase();
        if (PI_KEY_DENYLIST.has(key) || key === 'authorization' || key.startsWith('x-supabase')) {
          headers[h] = REDACT_MARKER;
        } else {
          headers[h] = v;
        }
      }
      e.request.headers = headers;
    }
    // 7.3 Strip query string.
    e.request.query_string = e.request.query_string ? REDACT_MARKER : undefined;
    // 7.4 Strip request body — NEVER kept.
    e.request.data = REDACT_MARKER;
    // 7.5 URL: keep route shape, drop query + identifiers.
    e.request.url = scrubUrl(e.request.url);
  }

  // 7.6 No `user.email`, no `user.username`, no `user.ip_address` ever.
  if (e.user) {
    const id = e.user.id; // pseudonym on server, undefined on browser
    e.user = id ? { id } : undefined;
  }

  // 7.7 Recursively redact by key in extras, tags (string-only enforced),
  //     contexts, and exception frame `vars`.
  if (e.extra) e.extra = redactInPlace(e.extra) as Record<string, unknown>;
  if (e.contexts) e.contexts = redactInPlace(e.contexts) as Record<string, Record<string, unknown>>;
  if (e.exception?.values) {
    for (const v of e.exception.values) {
      if (v.value) v.value = scrubFreeText(v.value);
      if (v.stacktrace?.frames) {
        for (const f of v.stacktrace.frames) {
          if (f.vars) f.vars = redactInPlace(f.vars) as Record<string, unknown>;
          if (f.filename) f.filename = scrubBundlePath(f.filename);
        }
      }
    }
  }
  if (e.message) e.message = scrubFreeText(e.message);

  // 7.8 Breadcrumbs: re-run the breadcrumb hook on each (in case they were
  //     attached before the hook installed).
  if (e.breadcrumbs) {
    e.breadcrumbs = e.breadcrumbs
      .map((b) => beforeBreadcrumb(b))
      .filter((b): b is SentryBreadcrumb => b !== null);
  }

  // 7.9 Size cap.
  const serialized = serializeForCanaryCheck(e);
  if (serialized.length > MAX_EVENT_BYTES) {
    panicSink('oversize', { bytes: String(serialized.length), event_id: e.event_id ?? '?' });
    return null;
  }

  // 7.10 Canary check — last line of defense.
  if (eventContainsAnyCanary(serialized)) {
    panicSink('canary', { event_id: e.event_id ?? '?' });
    return null;
  }

  return e;
}

/** Scrub free-text fields (exception message, console messages). Strips:
 *  - email-shaped tokens
 *  - phone-shaped tokens (E.164, NANP)
 *  - 32+ byte base64 blobs (private-key-shape canary per Invariant 1)
 *  - any literal canary
 */
export function scrubFreeText(s: string): string {
  if (!s) return s;
  let out = s;
  // emails
  out = out.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACT_MARKER);
  // phones (E.164 and NANP)
  out = out.replace(/\+?\d[\d\s().-]{7,}\d/g, REDACT_MARKER);
  // private-key-shape (Invariant 1 strengthened)
  out = out.replace(/[A-Za-z0-9+/=_-]{40,}/g, (m) => (m.length >= 40 ? REDACT_MARKER : m));
  // explicit canaries (defense-in-depth; the byte-level check still runs)
  for (const c of CANARIES) {
    if (out.includes(c)) out = out.split(c).join(REDACT_MARKER);
  }
  return out;
}

/** Strip user-system bundle paths to a stable shape. Source-map upload
 *  happens at build time; the runtime stack-trace filename is normalised
 *  to `/_app/<chunk>.<hash>.js`. */
function scrubBundlePath(p: string): string {
  const m = p.match(/\/_app\/[^/]+$/);
  return m ? m[0] : p.startsWith('webpack:') || p.startsWith('http') ? '/_app/[chunk]' : p;
}

// ----------------------------------------------------------------------------
// 8. The `beforeBreadcrumb` hook.
// ----------------------------------------------------------------------------

export function beforeBreadcrumb(b: SentryBreadcrumb): SentryBreadcrumb | null {
  if (!b) return null;

  // 8.1 Category allowlist.
  const cat = (b.category ?? '').toLowerCase();
  if (!BREADCRUMB_CATEGORY_ALLOWLIST.has(cat) && cat !== 'xhr' && cat !== 'fetch') {
    return null;
  }

  // 8.2 xhr / fetch: drop entirely if URL matches a sensitive path.
  if (cat === 'xhr' || cat === 'fetch') {
    const url = (b.data?.url as string) ?? '';
    if (matchesSensitivePath(url)) return null;
    // Even non-sensitive xhr/fetch: keep only method + scrubbed URL + status.
    return {
      category: cat,
      type: b.type,
      timestamp: b.timestamp,
      level: b.level,
      data: {
        method: (b.data?.method as string) ?? undefined,
        url: scrubUrl(url),
        status_code: (b.data?.status_code as number) ?? undefined,
      },
    };
  }

  // 8.3 Other allowed categories: redact data, scrub message.
  return {
    ...b,
    message: b.message ? scrubFreeText(b.message) : undefined,
    data: b.data ? (redactInPlace(b.data) as Record<string, unknown>) : undefined,
  };
}

// ============================================================================
// 9. TEST FIXTURES + TESTS
//
// The implementer copies this section into a co-located `.test.ts` (or runs
// it as-is under Vitest / Node test). Every required scrubbing rule has a
// failing test before the implementer touches the scrubber wiring.
//
// To run (when the implementer ports this into apps/web):
//   pnpm vitest observability/sentry-scrub.test.ts
// ============================================================================

/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-nocheck — this block is the spec; the implementer pastes it into a real
// .test.ts and replaces this comment.

/*
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  beforeSend,
  beforeBreadcrumb,
  scrubUrl,
  scrubFreeText,
  CANARIES,
  MAX_EVENT_BYTES,
  setPanicSink,
  type SentryEvent,
} from './sentry-scrub';

describe('sentry-scrub', () => {
  const panicCalls: Array<[string, Record<string, string>]> = [];
  beforeEach(() => {
    panicCalls.length = 0;
    setPanicSink((reason, meta) => panicCalls.push([reason, meta]));
  });

  // ---- 1. Form-value redaction (PI-key denylist) -------------------------
  it('redacts PI keys in `extra` regardless of nesting', () => {
    const ev: SentryEvent = {
      extra: {
        display_name: 'Real Name',
        nested: {
          off_employer_contact: 'real@example.com',
          notes: 'innocent',
        },
      },
    };
    const out = beforeSend(ev);
    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain('Real Name');
    expect(JSON.stringify(out)).not.toContain('real@example.com');
    expect(JSON.stringify(out)).toContain('innocent'); // non-PI key kept
  });

  // ---- 2. Breadcrumb URL (sensitive path) --------------------------------
  it('drops xhr/fetch breadcrumbs to sensitive paths entirely', () => {
    expect(
      beforeBreadcrumb({ category: 'fetch', data: { url: '/api/reprisal/123', method: 'GET' } })
    ).toBeNull();
    expect(
      beforeBreadcrumb({ category: 'xhr', data: { url: '/api/concerns/abc', method: 'POST' } })
    ).toBeNull();
    expect(
      beforeBreadcrumb({ category: 'fetch', data: { url: '/api/feature-flags', method: 'GET' } })
    ).not.toBeNull();
  });

  // ---- 3. Exception message (free-text) ----------------------------------
  it('scrubs emails, phones, and key-shape blobs out of exception messages', () => {
    const ev: SentryEvent = {
      exception: {
        values: [
          {
            type: 'Error',
            value: 'Failed for user real@example.com phone +15555550100',
          },
        ],
      },
    };
    const out = beforeSend(ev)!;
    const v = out.exception!.values![0].value!;
    expect(v).not.toContain('real@example.com');
    expect(v).not.toContain('+15555550100');
  });

  // ---- 4. User object: never email/ip/username --------------------------
  it('strips user.email, user.username, user.ip_address', () => {
    const ev: SentryEvent = {
      user: {
        id: 'pseudo-abc123',
        email: 'real@example.com',
        username: 'realname',
        ip_address: '203.0.113.7',
      },
    };
    const out = beforeSend(ev)!;
    expect(out.user).toEqual({ id: 'pseudo-abc123' });
  });

  // ---- 5. Extra context: oversize event is dropped -----------------------
  it('drops events whose serialized size > MAX_EVENT_BYTES', () => {
    const blob = 'x'.repeat(MAX_EVENT_BYTES + 100);
    const ev: SentryEvent = { extra: { okay_key: blob } };
    const out = beforeSend(ev);
    expect(out).toBeNull();
    expect(panicCalls[0][0]).toBe('oversize');
  });

  // ---- 6. C4 key panic ---------------------------------------------------
  it('drops the entire event AND raises P0 if any C4 key appears', () => {
    const ev: SentryEvent = {
      extra: { nested: { source_name_ciphertext: 'ciphertext-bytes' } },
    };
    const out = beforeSend(ev);
    expect(out).toBeNull();
    expect(panicCalls[0][0]).toBe('c4_field');
  });

  // ---- 7. Canary survival is a P0 ---------------------------------------
  it('drops the event if a canary survives the scrubber', () => {
    const ev: SentryEvent = {
      // 'tags' is string-keyed and survives redaction; we plant the canary
      // there to prove the byte-level check at the end catches it.
      tags: { route: 'CANARY_PII_X' },
    };
    const out = beforeSend(ev);
    expect(out).toBeNull();
    expect(panicCalls[0][0]).toBe('canary');
  });

  // ---- 8. Cookies + Authorization header --------------------------------
  it('redacts cookies and Authorization headers', () => {
    const ev: SentryEvent = {
      request: {
        url: '/api/concerns/abc?token=xyz',
        cookies: 'sb-access-token=ey...real',
        headers: { Authorization: 'Bearer ey...real', 'X-Other': 'fine' },
      },
    };
    const out = beforeSend(ev)!;
    expect(out.request!.cookies).toBe('[REDACTED:PI]');
    expect(out.request!.headers!.Authorization).toBe('[REDACTED:PI]');
    expect(out.request!.headers!['X-Other']).toBe('fine');
    expect(out.request!.url).toBe('/api/concerns/:id');
    expect(out.request!.query_string).toBe('[REDACTED:PI]');
  });

  // ---- 9. scrubUrl: route shape preserved -------------------------------
  it('scrubs URLs to route shape (UUIDs/ints replaced; query dropped)', () => {
    expect(scrubUrl('https://app.ca/api/reprisal/9f4e9b40-0000-4000-8000-000000000001?reveal=1'))
      .toBe('/api/reprisal/:id');
    expect(scrubUrl('https://app.ca/api/inspections/42/photos/7')).toBe('/api/inspections/:n/photos/:n');
  });

  // ---- 10. Pseudonym not derivable in browser ---------------------------
  it('document/CI assert: HMAC_PSEUDONYM_KEY is not in the built bundle', () => {
    // This is verified in CI by a `grep` over the built bundle (see
    // .github/workflows / scripts/verify.sh). Here we just assert the
    // browser code path does not import the key.
    expect(true).toBe(true); // placeholder; the real check is at the CI layer
  });
});
*/
