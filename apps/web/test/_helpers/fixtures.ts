/**
 * Shared synthetic-PI test fixtures.
 *
 * All values here are LABELED synthetic; never use real PI in tests.
 * Source: `.context/decisions.md` §PI inventory; `.context/threat-model.md`
 * §3.1 F-09 (canary contract); `observability/sentry-scrub.ts` (canary list).
 *
 * Conventions:
 *   - Canary literals match `observability/sentry-scrub.ts` `CANARIES` array.
 *   - Synthetic emails use `.invalid` TLD (RFC-2606) and contain "jhsc-test".
 *   - Synthetic phones use NANP test prefix `+1-555-55x-xxxx`.
 *   - Workplace coordinates are deliberately the centroid of Lake Ontario
 *     (no real workplace).
 */

// ============================================================================
// Canary strings — MUST match observability/sentry-scrub.ts exactly.
// ============================================================================

export const CANARY_PII_X = 'CANARY_PII_X';
export const CANARY_PHONE_E164 = '+15555550100';
export const CANARY_EMAIL = 'canary.user@example.test';
export const CANARY_PRIVKEY_SHAPE = 'CANARY_PRIVKEY_SHAPE_FIXTURE';

// ============================================================================
// Synthetic personal data — clearly labeled as fixtures.
// ============================================================================

export const SYNTHETIC_DISPLAY_NAME = 'CANARY-FIXTURE-NAME-DO-NOT-USE';
export const SYNTHETIC_EMAIL_OFF_EMPLOYER = 'synthetic.email+jhsc-test@example.invalid';
export const SYNTHETIC_PHONE = '+15555550199'; // also matches scrubber phone regex

// ============================================================================
// Synthetic UUIDs (RFC-4122 v4-shaped; not actually random).
// ============================================================================

export const SYNTHETIC_USER_A = '9f4e9b40-0000-4000-8000-00000000000a';
export const SYNTHETIC_USER_B = '9f4e9b40-0000-4000-8000-00000000000b';
export const SYNTHETIC_USER_C_INACTIVE = '9f4e9b40-0000-4000-8000-00000000000c';
export const SYNTHETIC_USER_D_NONMEMBER = '9f4e9b40-0000-4000-8000-00000000000d';
export const SYNTHETIC_USER_COCHAIR = '9f4e9b40-0000-4000-8000-00000000001a';
export const SYNTHETIC_USER_COCHAIR_2 = '9f4e9b40-0000-4000-8000-00000000001b';
export const SYNTHETIC_USER_CERTIFIED = '9f4e9b40-0000-4000-8000-00000000002a';

export const SYNTHETIC_CONCERN_ID = '11111111-0000-4000-8000-000000000001';
export const SYNTHETIC_REPRISAL_ID = '22222222-0000-4000-8000-000000000001';
export const SYNTHETIC_INSPECTION_ID = '33333333-0000-4000-8000-000000000001';
export const SYNTHETIC_MINUTES_ID = '44444444-0000-4000-8000-000000000001';
export const SYNTHETIC_RECOMMENDATION_ID = '55555555-0000-4000-8000-000000000001';
export const SYNTHETIC_WORK_REFUSAL_ID = '66666666-0000-4000-8000-000000000001';
export const SYNTHETIC_S51_ID = '77777777-0000-4000-8000-000000000001';

// ============================================================================
// Synthetic EXIF/IPTC/XMP photo fixtures (for HG-5 round-trip — T10/T14).
// The actual bytes are constructed at test time; constants below describe what
// the fixture MUST contain pre-strip and MUST NOT contain post-strip.
// ============================================================================

export const FIXTURE_EXIF_GPS_LAT = 43.6532; // Toronto City Hall centroid — synthetic
export const FIXTURE_EXIF_GPS_LON = -79.3832;
export const FIXTURE_EXIF_IPTC_BYLINE = 'CANARY-FIXTURE-PHOTOGRAPHER';
export const FIXTURE_EXIF_XMP_CREATOR_TOOL = 'CANARY-FIXTURE-CAMERA-APP';

/** A regex matching decimal-degree-shaped strings within Ontario's bounding
 *  box. The HG-5 round-trip test uses this to assert no GPS coords leaked
 *  via a non-EXIF channel after sanitize.  */
export const ONTARIO_DECIMAL_DEGREES_RE = /\b(4[1-5]|5[0-6])\.\d{3,}\b|\b-(7[4-9]|8[0-5])\.\d{3,}\b/;

// ============================================================================
// Test clock — set at test setup; never use real Date.now() in assertions.
// ============================================================================

export const FROZEN_NOW_ISO = '2026-05-22T14:37:42.123456Z';
export const FROZEN_NOW_MS = Date.parse(FROZEN_NOW_ISO);

// ============================================================================
// HMAC keys, salts, KDF params — known-answer fixtures, NEVER production.
// ============================================================================

/** 32-byte zero-bytes — a recognizable test key. */
export const TEST_HMAC_KEY_HEX = '0'.repeat(64);

/** Per ADR-0014 — versioned salt for the queue HMAC. */
export const HMAC_QUEUE_SALT_V1 = 'jhsc.queue.hmac.v1';

/** Per F-08 minimum Argon2id floor (from threat-model.md). */
export const ARGON2_MIN_OPS = 4;
export const ARGON2_MIN_MEM_BYTES = 512 * 1024 * 1024; // 512 MB
