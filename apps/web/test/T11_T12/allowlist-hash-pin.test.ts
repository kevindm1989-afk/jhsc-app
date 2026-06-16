/**
 * G-T11-23 / privacy-review-t11-t12.md P-12 — hash-determinism pin for
 * `computeAllowlistHash`.
 *
 * The export library's F-27 audit-binding check projects every emitted
 * audit row's `field_set_hash` against `computeAllowlistHash(allowlist)`.
 * The match holds as long as:
 *   (a) the closed allowlists stay byte-identical
 *   (b) the JSON serialization stays insertion-order-preserving
 *   (c) Node's `crypto.createHash('sha256')` keeps the same digest under
 *       the current `utf8` encoding
 *
 * A Node / OpenSSL upgrade or an Object.freeze iteration-order change
 * could silently produce a different hex digest. Without this pin the
 * runtime equality check (`auditHash === computeAllowlistHash(...)`) would
 * STILL pass — both sides recompute under the new toolchain — but the
 * F-27 SQL projection-view binding (T11.1) would break because the SQL
 * column-row binding is wired to the pre-upgrade hex.
 *
 * Regenerate the pinned values ONLY when the allowlist intentionally
 * changes (which IS a reviewer event — the closed-set lives in
 * `apps/web/src/lib/export/allowlist.ts`).
 */

import { describe, it, expect } from 'vitest';
import {
  EXPORT_ALLOWLIST_MINUTES,
  EXPORT_ALLOWLIST_RECOMMENDATION,
  computeAllowlistHash
} from '../../src/lib/export/allowlist';

// Pinned 2026-06-16 against Node 20.x / OpenSSL 3.0.x. A digest mismatch
// surfaces as either (a) an unintentional allowlist drift (revert the
// allowlist change OR coordinate the SQL projection-view binding update)
// OR (b) a Node/OpenSSL toolchain upgrade (coordinate with the deploy
// team — the binding hex needs to be updated in lock-step with the
// runtime upgrade and the SQL view definition).
const PINNED_HASH_MINUTES =
  '1bb78b2635bbbf4e0d9290f446b7e025a980694d3303fb1b2ad094a0bbe675da';
const PINNED_HASH_RECOMMENDATION =
  'dadb87a7bd7ad60cf12dafc16e0c5c1938ec5198669311ceeb6c241447c63d01';

describe('G-T11-23 — computeAllowlistHash pinned hex KAT', () => {
  it('EXPORT_ALLOWLIST_MINUTES hash matches the pinned value', () => {
    expect(computeAllowlistHash(EXPORT_ALLOWLIST_MINUTES)).toBe(PINNED_HASH_MINUTES);
  });

  it('EXPORT_ALLOWLIST_RECOMMENDATION hash matches the pinned value', () => {
    expect(computeAllowlistHash(EXPORT_ALLOWLIST_RECOMMENDATION)).toBe(
      PINNED_HASH_RECOMMENDATION
    );
  });

  it('hash differs when allowlist order changes (Object.freeze preserves insertion order)', () => {
    // Sanity — confirm the hash IS sensitive to ordering. If this ever
    // returns the same hex on a permuted list, the JSON serialization
    // contract has changed and the pin above is meaningless.
    const reversed = [...EXPORT_ALLOWLIST_MINUTES].reverse();
    expect(computeAllowlistHash(reversed)).not.toBe(PINNED_HASH_MINUTES);
  });

  it('hash differs when a field is added', () => {
    const extended = [...EXPORT_ALLOWLIST_MINUTES, 'leaked_field'];
    expect(computeAllowlistHash(extended)).not.toBe(PINNED_HASH_MINUTES);
  });
});
