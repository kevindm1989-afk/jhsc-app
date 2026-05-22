/**
 * T02 — Sentry SDK-layer PI scrubber tests.
 *
 * Source obligations:
 *   - observability/sentry-scrub.ts §9 (the in-file fixture is the spec; this
 *     file ports it into a real test file with real types — per the prompt's
 *     "port to a real test file with the real Sentry types").
 *   - .context/decisions.md ADR-0010 (Sentry SaaS EU + SDK-layer scrubbing).
 *   - .context/decisions.md ADR-0010 Amendment F-D Rule 2 (scrubbing at emit;
 *     no downstream pipeline).
 *   - .context/threat-model.md §8 T02 ("PI canary test"; "Semgrep: ban
 *     Sentry.captureException with non-allowlisted keys").
 *   - .context/threat-model.md §8 T07 "Invariant 1 strengthened — Canary
 *     32-byte private-key-shape never appears in Sentry payload".
 *   - observability/README.md §11 items 2, 9, 10, 11.
 *
 * The scrubber module is consumed via the path
 * `apps/web/src/lib/observability/sentry-scrub` per ADR-0010 Amendment.
 * The implementer ports the spec from observability/sentry-scrub.ts into
 * that path; this test imports from that path so it FAILS UNTIL the
 * implementer ports the module.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  beforeSend,
  beforeBreadcrumb,
  scrubUrl,
  scrubFreeText,
  MAX_EVENT_BYTES,
  setPanicSink,
  type SentryEvent,
} from '../../src/lib/observability/sentry-scrub';
import {
  CANARY_PII_X,
  CANARY_PHONE_E164,
  CANARY_EMAIL,
  CANARY_PRIVKEY_SHAPE,
  SYNTHETIC_DISPLAY_NAME,
  SYNTHETIC_EMAIL_OFF_EMPLOYER,
} from '../_helpers/fixtures';

describe('T02 / ADR-0010 / F-09 — Sentry scrubber', () => {
  const panicCalls: Array<[string, Record<string, string>]> = [];
  beforeEach(() => {
    panicCalls.length = 0;
    setPanicSink((reason, meta) => panicCalls.push([reason, meta]));
  });

  // --- Happy-path / PI-key redaction -----------------------------------

  it('T02 / F-09 / observability-README §11.2 — redacts PI keys in `extra` regardless of nesting depth', () => {
    const ev: SentryEvent = {
      extra: {
        display_name: SYNTHETIC_DISPLAY_NAME,
        nested: {
          off_employer_contact: SYNTHETIC_EMAIL_OFF_EMPLOYER,
          deeper: { email: CANARY_EMAIL },
          notes: 'innocent-non-PI-field',
        },
      },
    };
    const out = beforeSend(ev);
    expect(out).not.toBeNull();
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(SYNTHETIC_DISPLAY_NAME);
    expect(serialized).not.toContain(SYNTHETIC_EMAIL_OFF_EMPLOYER);
    expect(serialized).not.toContain(CANARY_EMAIL);
    expect(serialized).toContain('innocent-non-PI-field');
  });

  // --- Breadcrumb sensitive-path policy --------------------------------

  it('T02 / observability-README §11.10 / sentry-scrub §2 — drops xhr/fetch breadcrumbs to sensitive paths entirely', () => {
    expect(
      beforeBreadcrumb({ category: 'fetch', data: { url: '/api/reprisal/abc', method: 'GET' } })
    ).toBeNull();
    expect(
      beforeBreadcrumb({ category: 'xhr', data: { url: '/api/concerns/123', method: 'POST' } })
    ).toBeNull();
    expect(
      beforeBreadcrumb({ category: 'xhr', data: { url: '/api/work-refusal/x', method: 'GET' } })
    ).toBeNull();
    expect(
      beforeBreadcrumb({ category: 'fetch', data: { url: '/api/s51/x', method: 'GET' } })
    ).toBeNull();
    expect(
      beforeBreadcrumb({ category: 'fetch', data: { url: '/api/sensitive/read', method: 'POST' } })
    ).toBeNull();
    // Non-sensitive routes survive (with URL scrubbed).
    const okay = beforeBreadcrumb({
      category: 'fetch',
      data: { url: '/api/feature-flags', method: 'GET' },
    });
    expect(okay).not.toBeNull();
  });

  // --- Free-text scrubbing ---------------------------------------------

  it('T02 / threat-model §6 Invariant 1 strengthened — scrubs emails, phones, and key-shape blobs out of exception messages', () => {
    const ev: SentryEvent = {
      exception: {
        values: [
          {
            type: 'Error',
            value: `Failed for user ${CANARY_EMAIL} phone ${CANARY_PHONE_E164}`,
          },
        ],
      },
    };
    const out = beforeSend(ev)!;
    const v = out.exception!.values![0].value!;
    expect(v).not.toContain(CANARY_EMAIL);
    expect(v).not.toContain(CANARY_PHONE_E164);
  });

  it('T02 / threat-model §6 Invariant 1 strengthened — scrubs 32+ byte base64-shaped blobs (private-key-shape canary)', () => {
    // A 40-char base64 blob — the scrubber MUST collapse this regardless of
    // whether it is the canary literal.
    const fakeKey = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd';
    const scrubbed = scrubFreeText(`captured key ${fakeKey} during enrollment`);
    expect(scrubbed).not.toContain(fakeKey);
    // The canary literal itself MUST be stripped even when shorter than 40 chars.
    const scrubbed2 = scrubFreeText(CANARY_PRIVKEY_SHAPE);
    expect(scrubbed2).not.toContain(CANARY_PRIVKEY_SHAPE);
  });

  // --- User object hygiene ---------------------------------------------

  it('T02 / ADR-0010 — strips user.email / user.username / user.ip_address; keeps only pseudonym in user.id', () => {
    const ev: SentryEvent = {
      user: {
        id: 'pseudonym-deadbeef',
        email: CANARY_EMAIL,
        username: SYNTHETIC_DISPLAY_NAME,
        ip_address: '203.0.113.7',
      },
    };
    const out = beforeSend(ev)!;
    expect(out.user).toEqual({ id: 'pseudonym-deadbeef' });
  });

  it('T02 / ADR-0010 — drops user object entirely when only PI fields present (no pseudonym)', () => {
    const ev: SentryEvent = {
      user: { email: CANARY_EMAIL, ip_address: '203.0.113.7' },
    };
    const out = beforeSend(ev)!;
    expect(out.user).toBeUndefined();
  });

  // --- Size cap ---------------------------------------------------------

  it('T02 / observability-README §11.9 — drops events whose serialized size > MAX_EVENT_BYTES and signals P0 oversize', () => {
    const blob = 'x'.repeat(MAX_EVENT_BYTES + 100);
    const ev: SentryEvent = { extra: { okay_key: blob } };
    const out = beforeSend(ev);
    expect(out).toBeNull();
    expect(panicCalls.length).toBeGreaterThanOrEqual(1);
    expect(panicCalls[0][0]).toBe('oversize');
  });

  // --- C4 key panic ----------------------------------------------------

  it('T02 / sentry-scrub §1 C4_KEY_PANIC — drops the entire event AND signals c4_field P0 if any C4 key appears', () => {
    const ev: SentryEvent = {
      extra: { nested: { source_name_ciphertext: 'ciphertext-bytes-here' } },
    };
    const out = beforeSend(ev);
    expect(out).toBeNull();
    expect(panicCalls.length).toBe(1);
    expect(panicCalls[0][0]).toBe('c4_field');
  });

  it('T02 / sentry-scrub §1 C4_KEY_PANIC — also panics on reprisal_body_ct, work_refusal_notes_ct, s51_evidence_ct, s51_photo_ct', () => {
    const cases = [
      'reprisal_body_ct',
      'reprisal_body_ciphertext',
      'work_refusal_notes_ct',
      'work_refusal_notes_ciphertext',
      's51_evidence_ct',
      's51_evidence_ciphertext',
      's51_photo_ct',
    ];
    for (const key of cases) {
      panicCalls.length = 0;
      const ev: SentryEvent = { extra: { [key]: 'ct-bytes' } };
      const out = beforeSend(ev);
      expect(out, `C4 key ${key} must trigger panic`).toBeNull();
      expect(panicCalls[0][0]).toBe('c4_field');
    }
  });

  // --- Canary survival is a P0 ------------------------------------------

  it('T02 / threat-model §8 T02 canary contract — drops the event AND signals canary P0 if any canary string survives', () => {
    const ev: SentryEvent = {
      // tags are string-keyed and survive redaction; canary plant proves
      // the byte-level check at the end catches it.
      tags: { route: CANARY_PII_X },
    };
    const out = beforeSend(ev);
    expect(out).toBeNull();
    expect(panicCalls.length).toBe(1);
    expect(panicCalls[0][0]).toBe('canary');
  });

  it('T02 / threat-model §8 T02 canary contract — canary CANARY_PRIVKEY_SHAPE_FIXTURE never survives any payload', () => {
    const ev: SentryEvent = { message: `crash dump: ${CANARY_PRIVKEY_SHAPE}` };
    const out = beforeSend(ev);
    expect(out).toBeNull();
    expect(panicCalls[0][0]).toBe('canary');
  });

  // --- Cookies + Authorization headers ----------------------------------

  it('T02 / ADR-0010 — redacts cookies and Authorization headers; keeps non-sensitive headers; scrubs URL/query', () => {
    const ev: SentryEvent = {
      request: {
        url: '/api/concerns/9f4e9b40-0000-4000-8000-000000000001?token=xyz',
        cookies: 'sb-access-token=ey...real',
        headers: {
          Authorization: 'Bearer ey...real',
          Cookie: 'sb-refresh-token=real',
          'X-Other': 'fine-non-sensitive',
        },
      },
    };
    const out = beforeSend(ev)!;
    expect(out.request!.cookies).toBe('[REDACTED:PI]');
    expect(out.request!.headers!.Authorization).toBe('[REDACTED:PI]');
    expect(out.request!.headers!['X-Other']).toBe('fine-non-sensitive');
    expect(out.request!.url).toBe('/api/concerns/:id');
    expect(out.request!.query_string).toBe('[REDACTED:PI]');
  });

  // --- URL scrubbing ----------------------------------------------------

  it('T02 / sentry-scrub.scrubUrl — replaces UUIDs and ints in path with placeholders; drops query string', () => {
    expect(
      scrubUrl('https://app.ca/api/reprisal/9f4e9b40-0000-4000-8000-000000000001?reveal=1')
    ).toBe('/api/reprisal/:id');
    expect(scrubUrl('https://app.ca/api/inspections/42/photos/7')).toBe(
      '/api/inspections/:n/photos/:n'
    );
    expect(scrubUrl('/api/concerns/abc-123-def-456')).toBe('/api/concerns/:id');
  });

  // --- request.data MUST always be redacted -----------------------------

  it('T02 / ADR-0010 — request.data (body) is unconditionally redacted regardless of contents', () => {
    const ev: SentryEvent = {
      request: { url: '/api/x', data: { harmless_key: 'harmless_value' } },
    };
    const out = beforeSend(ev)!;
    expect(out.request!.data).toBe('[REDACTED:PI]');
  });

  // --- Stack trace `vars` redaction -------------------------------------

  it('T02 / ADR-0010 — recursively redacts PI keys in exception stacktrace frame `vars`', () => {
    const ev: SentryEvent = {
      exception: {
        values: [
          {
            type: 'Error',
            stacktrace: {
              frames: [
                {
                  filename: 'http://app.ca/_app/chunk.abc.js',
                  vars: { display_name: SYNTHETIC_DISPLAY_NAME, harmless: 1 },
                },
              ],
            },
          },
        ],
      },
    };
    const out = beforeSend(ev)!;
    const vars = out.exception!.values![0].stacktrace!.frames![0].vars!;
    expect(vars.display_name).toBe('[REDACTED:PI]');
    expect(vars.harmless).toBe(1);
  });

  // --- Determinism ------------------------------------------------------

  it('T02 / determinism — beforeSend is pure: identical input yields byte-identical output', () => {
    const ev: SentryEvent = {
      extra: { display_name: SYNTHETIC_DISPLAY_NAME, ok: 'value' },
      message: 'hello',
    };
    const out1 = JSON.stringify(beforeSend(structuredClone(ev)));
    const out2 = JSON.stringify(beforeSend(structuredClone(ev)));
    expect(out1).toBe(out2);
  });

  // --- Bundle hygiene (CI-level grep — placeholder in unit test) --------

  it.skip('T02 / observability-README §11.11 / logging.md §7 rule 5 — HMAC_PSEUDONYM_KEY not present in browser bundle [CI grep test]', () => {
    // The runtime test stub is documented; the real assertion is a grep
    // over the built bundle in scripts/verify.sh. Marked skip because the
    // unit-test layer cannot meaningfully verify a CI-time grep; the
    // implementer wires the grep into verify.sh per logging.md §7 rule 5.
    // TODO(implementer): add scripts/verify.sh hook + assert by running
    // verify.sh in CI; this test becomes a smoke test invoking the script.
    expect(true).toBe(false);
  });
});
