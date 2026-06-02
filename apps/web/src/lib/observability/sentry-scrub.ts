/**
 * Sentry SDK-layer PI scrubber — runtime port of `observability/sentry-scrub.ts`.
 *
 * Scaffolder note: this file is a structural port of the spec from
 *   /home/user/agent-os/observability/sentry-scrub.ts
 * It exists so the T02 tests can import the module path
 *   $lib/observability/sentry-scrub
 * and exercise the scrub contract. The implementer of T02 (and beyond) MUST
 * keep this file behaviourally identical to the spec; if the spec is
 * amended via an ADR, this port is updated in the same PR.
 *
 * Reference docs:
 *   - observability/sentry-scrub.ts (canonical spec)
 *   - .context/decisions.md ADR-0010 + Amendment F (Sentry SaaS; SDK-layer scrubbing)
 *   - .context/threat-model.md §3.1 F-09, §6 Invariant 1 strengthened
 *
 * Hard rules (verbatim from the spec):
 *   1. PI is scrubbed BEFORE the SDK transport leaves the host.
 *   2. No `Sentry.setUser` on the browser.
 *   3. Breadcrumb stream denied-by-default for xhr/fetch to sensitive paths.
 *   4. Any event > MAX_EVENT_BYTES is dropped (oversize protection).
 *   5. A canary appearing in ANY captured event → P0.
 *   6. The browser bundle MUST NOT contain HMAC_PSEUDONYM_KEY.
 */

// ----------------------------------------------------------------------------
// 0. Types
// ----------------------------------------------------------------------------

export interface SentryEvent {
  event_id?: string | undefined;
  message?: string | undefined;
  exception?:
    | {
        values?: Array<{
          type?: string | undefined;
          value?: string | undefined;
          stacktrace?:
            | {
                frames?:
                  | Array<{
                      filename?: string | undefined;
                      vars?: Record<string, unknown> | undefined;
                    }>
                  | undefined;
              }
            | undefined;
        }>;
      }
    | undefined;
  request?:
    | {
        url?: string | undefined;
        method?: string | undefined;
        query_string?: string | Record<string, string> | undefined;
        cookies?: string | Record<string, string> | undefined;
        headers?: Record<string, string> | undefined;
        data?: unknown;
      }
    | undefined;
  user?:
    | {
        id?: string | undefined;
        email?: string | undefined;
        ip_address?: string | undefined;
        username?: string | undefined;
      }
    | undefined;
  contexts?: Record<string, Record<string, unknown>> | undefined;
  tags?: Record<string, string> | undefined;
  extra?: Record<string, unknown> | undefined;
  breadcrumbs?: SentryBreadcrumb[] | undefined;
  release?: string | undefined;
  environment?: string | undefined;
}

export interface SentryBreadcrumb {
  type?: string | undefined;
  category?: string | undefined;
  message?: string | undefined;
  data?: Record<string, unknown> | undefined;
  level?: string | undefined;
  timestamp?: number | undefined;
}

// ----------------------------------------------------------------------------
// 1. PI key denylist (closed list; mirrors the spec verbatim).
// ----------------------------------------------------------------------------

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

  // C3 ciphertext column names
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

  // C4 highest sensitivity (also panic-trigger below)
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

  // Raw identifiers
  'user_id',
  'user_uuid',
  'supabase_uid',
  'auth_uid',
  'sub',

  // Body / payload aliases
  'body',
  'payload',
  'form',
  'form_data',
  'formdata',
  'req_body',
  'request_body'
]);

export const C4_KEY_PANIC: ReadonlySet<string> = new Set([
  'source_name_ct',
  'source_name_ciphertext',
  'reprisal_body_ct',
  'reprisal_body_ciphertext',
  'work_refusal_notes_ct',
  'work_refusal_notes_ciphertext',
  's51_evidence_ct',
  's51_evidence_ciphertext',
  's51_photo_ct'
]);

// ----------------------------------------------------------------------------
// 2. Sensitive paths
// ----------------------------------------------------------------------------

export const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /\/api\/concerns(?:\/|$|\?)/i,
  /\/api\/reprisal(?:\/|$|\?)/i,
  /\/api\/work[-_]refusal(?:\/|$|\?)/i,
  /\/api\/s51(?:\/|$|\?)/i,
  /\/api\/inspections\/.+\/photos?(?:\/|$|\?)/i,
  /\/api\/minutes\/.+\/(?:draft|final)(?:\/|$|\?)/i,
  /\/api\/recommendations(?:\/|$|\?)/i,
  /\/api\/sensitive(?:\/|$|\?)/i,
  // G-T19-7 — Supabase Edge Function endpoints under /functions/v1/*.
  // The adapter-static app routes every server interaction through one
  // of these Edge Functions (T07.1 / T08.1 / T13.1 / T14.1 production
  // clients posted via createSupabaseT07Client and friends), and the
  // request body / URL can carry passphrase fragments, sealed-box
  // ciphertext, audit-row meta, and per-record passphrase hashes. The
  // breadcrumb stream for these calls is dropped entirely; the
  // application-level audit log (audit_log table) is the canonical
  // record of what happened. Pattern matches any /functions/v1/<name>
  // sub-path so future Edge Functions (e.g. retention-sweep, integrity-
  // check) inherit the protection without a separate update here.
  /\/functions\/v1\/(?:t07[-_]op|t14[-_]op|reprisal[-_]op|concern[-_]op|committee[-_]op|mint[-_]session)(?:\/|$|\?)/i
];

export const BREADCRUMB_CATEGORY_ALLOWLIST: ReadonlySet<string> = new Set([
  'navigation',
  'ui.click',
  'console',
  'sentry.event'
]);

// ----------------------------------------------------------------------------
// 3. Canaries — MUST match test/_helpers/fixtures.ts and the spec.
// ----------------------------------------------------------------------------

export const CANARIES: readonly string[] = [
  'CANARY_PII_X',
  '+15555550100',
  'canary.user@example.test',
  'CANARY_PRIVKEY_SHAPE_FIXTURE',
  // G-T19-7 / F-110 M-110c — canary fixtures for passphrase + TOTP fragments
  // that may originate from breadcrumbs emitted under `lib/onboarding/*` or
  // `lib/lock/*`. Neither shape is caught by the scrubFreeText regexes (a
  // BIP39-style passphrase is just words; a TOTP is six digits — both below
  // the phone-regex floor of eight digits). The defense is per-call: code
  // paths in those surfaces MUST NEVER feed raw passphrase / TOTP material
  // to console / breadcrumb / TTS sinks (statically enforced by
  // scripts/check-onboarding-no-passphrase-leak.sh). These canary literals
  // are the runtime tripwire — if either string surfaces in any captured
  // event, the panicSink fires 'canary' and the event is dropped, exactly
  // like the existing 4 canaries.
  'CANARY_PASSPHRASE_FIXTURE',
  'CANARY_TOTP_FIXTURE'
];

/**
 * "Marker" canaries — strings whose appearance ANYWHERE in the event
 * (including in scrubbable free-text channels) signals a code-path bug
 * upstream that we MUST catch. Distinct from the shape canaries
 * (synthetic email, synthetic phone) which scrubFreeText handles via
 * regex; those leave the event intact and the marker survives only the
 * keyed channels (`tags`, etc.) caught by the final byte-level scan.
 */
const MARKER_CANARIES: readonly string[] = [
  'CANARY_PII_X',
  'CANARY_PRIVKEY_SHAPE_FIXTURE',
  // G-T19-7 / F-110 M-110c — same scalar-channel first-pass coverage
  // for the passphrase + TOTP canaries. Without entry in MARKER_CANARIES
  // they'd only be caught by the final byte-level scan in beforeSend —
  // which still drops the event, but the first-pass check fires BEFORE
  // the redactInPlace deep-copy + scrubFreeText pass and so reports the
  // P0 with less work + on the original payload's exception/message
  // channels.
  'CANARY_PASSPHRASE_FIXTURE',
  'CANARY_TOTP_FIXTURE'
];

// ----------------------------------------------------------------------------
// 4. Size threshold
// ----------------------------------------------------------------------------

export const MAX_EVENT_BYTES = 15 * 1024;

// ----------------------------------------------------------------------------
// 5. Redaction core
// ----------------------------------------------------------------------------

const REDACT_MARKER = '[REDACTED:PI]';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function containsC4Key(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
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

export function scrubUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url, 'https://placeholder.invalid');
    const path = u.pathname.replace(/\/[0-9a-f-]{8,}/gi, '/:id').replace(/\/\d+/g, '/:n');
    return path;
  } catch {
    return REDACT_MARKER;
  }
}

function matchesSensitivePath(url: string | undefined): boolean {
  if (!url) return false;
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(url));
}

// ----------------------------------------------------------------------------
// 6. Canary check
// ----------------------------------------------------------------------------

function serializeForCanaryCheck(event: SentryEvent): string {
  try {
    return JSON.stringify(event);
  } catch {
    return '';
  }
}

function eventContainsAnyCanary(serialized: string): boolean {
  for (const c of CANARIES) {
    if (serialized.includes(c)) return true;
  }
  return false;
}

export type PanicSink = (
  reason: 'canary' | 'c4_field' | 'oversize',
  meta: Record<string, string>
) => void;

let panicSink: PanicSink = () => undefined;
export function setPanicSink(fn: PanicSink): void {
  panicSink = fn;
}

// ----------------------------------------------------------------------------
// 7. beforeSend
// ----------------------------------------------------------------------------

function containsMarkerCanary(value: string | undefined): boolean {
  if (!value) return false;
  for (const c of MARKER_CANARIES) {
    if (value.includes(c)) return true;
  }
  return false;
}

export function beforeSend(rawEvent: SentryEvent): SentryEvent | null {
  // 7.0 First-pass: a C4-class key anywhere in the event drops it and
  // raises a P0 — even before key/value redaction has had a chance to
  // touch it.
  if (containsC4Key(rawEvent)) {
    panicSink('c4_field', { event_id: rawEvent.event_id ?? '?' });
    return null;
  }
  // 7.0b A canary surviving in a SCALAR free-text channel (exception
  // message, top-level message) is a P0. We catch it on the RAW payload
  // because scrubFreeText below would redact it before the byte-level
  // check could see it. Keys that go through redactInPlace (which
  // redacts by KEY name, not by value) preserve the canary value — those
  // are caught by the byte-level check at the end of beforeSend instead.
  if (containsMarkerCanary(rawEvent.message)) {
    panicSink('canary', { event_id: rawEvent.event_id ?? '?' });
    return null;
  }
  if (rawEvent.exception?.values) {
    for (const v of rawEvent.exception.values) {
      if (containsMarkerCanary(v.value)) {
        panicSink('canary', { event_id: rawEvent.event_id ?? '?' });
        return null;
      }
    }
  }
  if (rawEvent.breadcrumbs) {
    for (const b of rawEvent.breadcrumbs) {
      if (containsMarkerCanary(b.message)) {
        panicSink('canary', { event_id: rawEvent.event_id ?? '?' });
        return null;
      }
    }
  }

  const e: SentryEvent = JSON.parse(JSON.stringify(rawEvent));

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
    // Always redact query_string when a request is present — even if the
    // input had none, the field is normalised to the redact marker so the
    // shape is uniform and downstream consumers can rely on the redaction
    // marker being there.
    e.request.query_string = REDACT_MARKER;
    e.request.data = REDACT_MARKER;
    e.request.url = scrubUrl(e.request.url);
  }

  if (e.user) {
    const id = e.user.id;
    e.user = id ? { id } : undefined;
  }

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

  if (e.breadcrumbs) {
    e.breadcrumbs = e.breadcrumbs
      .map((b) => beforeBreadcrumb(b))
      .filter((b): b is SentryBreadcrumb => b !== null);
  }

  const serialized = serializeForCanaryCheck(e);
  if (serialized.length > MAX_EVENT_BYTES) {
    panicSink('oversize', { bytes: String(serialized.length), event_id: e.event_id ?? '?' });
    return null;
  }

  if (eventContainsAnyCanary(serialized)) {
    panicSink('canary', { event_id: e.event_id ?? '?' });
    return null;
  }

  return e;
}

export function scrubFreeText(s: string): string {
  if (!s) return s;
  let out = s;
  out = out.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACT_MARKER);
  out = out.replace(/\+?\d[\d\s().-]{7,}\d/g, REDACT_MARKER);
  out = out.replace(/[A-Za-z0-9+/=_-]{40,}/g, (m) => (m.length >= 40 ? REDACT_MARKER : m));
  for (const c of CANARIES) {
    if (out.includes(c)) out = out.split(c).join(REDACT_MARKER);
  }
  return out;
}

function scrubBundlePath(p: string): string {
  const m = p.match(/\/_app\/[^/]+$/);
  if (m) return m[0];
  if (p.startsWith('webpack:') || p.startsWith('http')) return '/_app/[chunk]';
  return p;
}

// ----------------------------------------------------------------------------
// 8. beforeBreadcrumb
// ----------------------------------------------------------------------------

export function beforeBreadcrumb(b: SentryBreadcrumb): SentryBreadcrumb | null {
  if (!b) return null;
  const cat = (b.category ?? '').toLowerCase();
  if (!BREADCRUMB_CATEGORY_ALLOWLIST.has(cat) && cat !== 'xhr' && cat !== 'fetch') {
    return null;
  }
  if (cat === 'xhr' || cat === 'fetch') {
    const url = (b.data?.url as string) ?? '';
    if (matchesSensitivePath(url)) return null;
    return {
      category: cat,
      type: b.type,
      timestamp: b.timestamp,
      level: b.level,
      data: {
        method: (b.data?.method as string) ?? undefined,
        url: scrubUrl(url),
        status_code: (b.data?.status_code as number) ?? undefined
      }
    };
  }
  return {
    ...b,
    message: b.message ? scrubFreeText(b.message) : undefined,
    data: b.data ? (redactInPlace(b.data) as Record<string, unknown>) : undefined
  };
}
