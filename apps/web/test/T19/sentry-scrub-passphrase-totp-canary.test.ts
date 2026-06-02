/**
 * T19.1 — G-T19-7 closing half: F-110 M-110c canary test for the
 * passphrase + TOTP shape canaries.
 *
 * The other half of G-T19-7 — extending the URL-based SENSITIVE_PATH_PATTERNS
 * to cover Supabase Edge Function paths — landed alongside the route-mount
 * series and is pinned by `sentry-scrub-edge-functions.test.ts`. This file
 * closes the test-obligation side of the gap (per `.context/known-gaps.md`
 * G-T19-7 Resolution scope): canary tests asserting that passphrase / TOTP
 * fragments planted in breadcrumbs originating from `lib/onboarding/*` and
 * `lib/lock/*` are stripped (or, when they survive into the final byte-level
 * scan, drop the event with a `canary` P0).
 *
 * Why these two canaries needed adding alongside the existing four:
 *
 *   - The existing free-text regexes catch (a) email shapes, (b) phone
 *     shapes ≥8 digits, and (c) base64-ish blobs ≥40 chars. Neither a
 *     BIP39-style passphrase fragment (multi-word lowercase, hyphen-
 *     separated, mostly ≤8 chars per word, total often <40) NOR a 6-digit
 *     TOTP code matches any of those. So a code-path bug feeding raw
 *     passphrase material to a breadcrumb sink would survive scrubFreeText
 *     entirely.
 *
 *   - The defense at the source surface (`lib/onboarding/recovery/*.svelte`,
 *     `lib/lock/*.svelte`) is the static lint `scripts/check-onboarding-no-
 *     passphrase-leak.sh` (G-T19-6) — no aria-live, no clipboard, no TTS.
 *     But static lint can't catch a runtime-constructed breadcrumb message
 *     from a try/catch that includes the raw passphrase in the error
 *     string.
 *
 *   - Adding `CANARY_PASSPHRASE_FIXTURE` + `CANARY_TOTP_FIXTURE` to both
 *     `CANARIES` (for the byte-level final scan + scrubFreeText literal
 *     replacement) and `MARKER_CANARIES` (for the first-pass scalar-channel
 *     check in beforeSend) gives us the runtime tripwire. A test fixture
 *     that pipes either literal through a breadcrumb is exactly the F-110
 *     M-110c contract — an integrity-check that the scrubber actually
 *     panics when the upstream code-path bug ships.
 *
 * The four pinned assertions per canary:
 *
 *   1. In a breadcrumb message → beforeSend drops the event AND fires
 *      panicSink('canary', ...).
 *   2. In a breadcrumb data field → beforeSend drops the event AND fires
 *      panicSink('canary', ...). (data goes through redactInPlace by key,
 *      not by value, so canary values survive into the byte-level scan.)
 *   3. In an exception value (a try/catch wrapping a passphrase variable
 *      and re-throwing) → beforeSend drops the event AND fires the panic.
 *      This is the realistic ship-path.
 *   4. scrubFreeText replaces the canary literal with [REDACTED:PI] so
 *      a non-Sentry log channel that pipes through scrubFreeText (the
 *      structured logger's PI scrubber would also use this fn) doesn't
 *      surface the canary.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  beforeSend,
  setPanicSink,
  scrubFreeText,
  CANARIES,
  type SentryEvent
} from '../../src/lib/observability/sentry-scrub';
import { CANARY_PASSPHRASE, CANARY_TOTP } from '../_helpers/fixtures';

type PanicCall = [string, Record<string, string>];

let panicCalls: PanicCall[] = [];

beforeEach(() => {
  panicCalls = [];
  setPanicSink((reason, meta) => {
    panicCalls.push([reason, meta]);
  });
});

afterEach(() => {
  setPanicSink(() => undefined);
});

describe('T19.1 / G-T19-7 — passphrase + TOTP canaries are in the CANARIES allowlist', () => {
  it('CANARY_PASSPHRASE_FIXTURE is in the published CANARIES list', () => {
    expect(CANARIES).toContain('CANARY_PASSPHRASE_FIXTURE');
  });

  it('CANARY_TOTP_FIXTURE is in the published CANARIES list', () => {
    expect(CANARIES).toContain('CANARY_TOTP_FIXTURE');
  });

  it('the fixtures-helper export matches the runtime literal (drift guard)', () => {
    // The test-helper export and the scrubber's literal must stay in sync;
    // otherwise tests planting the helper string wouldn't actually trip
    // the scrubber.
    expect(CANARY_PASSPHRASE).toBe('CANARY_PASSPHRASE_FIXTURE');
    expect(CANARY_TOTP).toBe('CANARY_TOTP_FIXTURE');
  });
});

describe('T19.1 / F-110 M-110c — passphrase canary in breadcrumbs drops the event', () => {
  it('canary planted in a breadcrumb message → event dropped + panicSink fired', () => {
    const ev: SentryEvent = {
      event_id: 'e-1',
      message: 'wizard step transition',
      breadcrumbs: [
        {
          category: 'console',
          message: `recovery passphrase entered: ${CANARY_PASSPHRASE}`,
          timestamp: 0
        }
      ]
    };
    expect(beforeSend(ev)).toBeNull();
    expect(panicCalls.length).toBeGreaterThanOrEqual(1);
    expect(panicCalls[0][0]).toBe('canary');
    expect(panicCalls[0][1].event_id).toBe('e-1');
  });

  it('canary planted in a breadcrumb data value → event dropped + panicSink fired', () => {
    // data goes through redactInPlace by KEY, not by value. An attacker-
    // shaped or buggy code path that puts the canary under a key not in
    // the PI_KEY_DENYLIST would have the value SURVIVE redactInPlace —
    // but the final byte-level scan in beforeSend catches it.
    const ev: SentryEvent = {
      event_id: 'e-2',
      breadcrumbs: [
        {
          category: 'ui.click',
          data: { hint: `passphrase=${CANARY_PASSPHRASE}` },
          timestamp: 0
        }
      ]
    };
    expect(beforeSend(ev)).toBeNull();
    expect(panicCalls.length).toBeGreaterThanOrEqual(1);
    expect(panicCalls[0][0]).toBe('canary');
  });

  it('canary thrown via exception value → event dropped + panicSink fired (realistic ship path)', () => {
    // The realistic bug: a try/catch around the passphrase-entry code
    // captures the passphrase variable in the error string and re-throws.
    // Sentry's auto-capture grabs this as exception.values[0].value.
    const ev: SentryEvent = {
      event_id: 'e-3',
      exception: {
        values: [
          {
            type: 'TypeError',
            value: `Cannot read property of undefined: ${CANARY_PASSPHRASE}`
          }
        ]
      }
    };
    expect(beforeSend(ev)).toBeNull();
    expect(panicCalls.length).toBeGreaterThanOrEqual(1);
    expect(panicCalls[0][0]).toBe('canary');
  });

  it('scrubFreeText replaces the passphrase canary literal with the redact marker', () => {
    const out = scrubFreeText(`prefix ${CANARY_PASSPHRASE} suffix`);
    expect(out).not.toContain(CANARY_PASSPHRASE);
    expect(out).toContain('[REDACTED:PI]');
  });
});

describe('T19.1 / F-110 M-110c — TOTP canary in breadcrumbs drops the event', () => {
  it('canary planted in a breadcrumb message → event dropped + panicSink fired', () => {
    const ev: SentryEvent = {
      event_id: 'e-4',
      message: 'mfa step transition',
      breadcrumbs: [
        {
          category: 'console',
          message: `totp submitted: ${CANARY_TOTP}`,
          timestamp: 0
        }
      ]
    };
    expect(beforeSend(ev)).toBeNull();
    expect(panicCalls.length).toBeGreaterThanOrEqual(1);
    expect(panicCalls[0][0]).toBe('canary');
    expect(panicCalls[0][1].event_id).toBe('e-4');
  });

  it('canary planted in a breadcrumb data value → event dropped + panicSink fired', () => {
    const ev: SentryEvent = {
      event_id: 'e-5',
      breadcrumbs: [
        {
          category: 'ui.click',
          data: { code: CANARY_TOTP },
          timestamp: 0
        }
      ]
    };
    expect(beforeSend(ev)).toBeNull();
    expect(panicCalls.length).toBeGreaterThanOrEqual(1);
    expect(panicCalls[0][0]).toBe('canary');
  });

  it('canary thrown via exception value → event dropped + panicSink fired (realistic ship path)', () => {
    const ev: SentryEvent = {
      event_id: 'e-6',
      exception: {
        values: [
          {
            type: 'Error',
            value: `TOTP verification failed for ${CANARY_TOTP}`
          }
        ]
      }
    };
    expect(beforeSend(ev)).toBeNull();
    expect(panicCalls.length).toBeGreaterThanOrEqual(1);
    expect(panicCalls[0][0]).toBe('canary');
  });

  it('scrubFreeText replaces the TOTP canary literal with the redact marker', () => {
    const out = scrubFreeText(`prefix ${CANARY_TOTP} suffix`);
    expect(out).not.toContain(CANARY_TOTP);
    expect(out).toContain('[REDACTED:PI]');
  });
});

describe('T19.1 / F-110 M-110c — coverage gap defense: shape regexes do NOT catch these literals', () => {
  // Defense pin: the existing scrubFreeText regexes (email, phone, base64)
  // were never going to catch a passphrase or TOTP shape. These tests
  // prove that — if a future refactor adds a passphrase / TOTP regex,
  // the canary path is STILL the contract.

  it('a 6-digit shape (TOTP-like) is below the phone-regex 8-digit floor (no false-positive on benign 6-digit numbers)', () => {
    // 123456 is six digits — fewer than the phone regex's
    // `\+?\d[\d\s().-]{7,}\d` floor of 8 (1 + {7,} + 1 = 9). Benign
    // 6-digit numbers like sequence counters, http status codes, version
    // identifiers do NOT get false-positived. So real TOTP detection
    // can ONLY come via the canary literal, not via a shape regex.
    const out = scrubFreeText('benign sequence: 123456 done');
    expect(out).toContain('123456');
  });

  it('a multi-word lowercase passphrase shape is not regex-matched (relies on canary literal)', () => {
    // BIP39-ish: short lowercase words, hyphen-separated. None of the
    // three scrubFreeText regexes (email, phone, base64≥40) match this
    // shape. The canary literal is the only line of defense at runtime.
    const sample = 'apple-banana-cherry-date-elderberry-fig';
    const out = scrubFreeText(sample);
    expect(out).toBe(sample); // unchanged
  });
});
