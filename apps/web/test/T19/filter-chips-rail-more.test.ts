/**
 * T19.1 — FilterChipsRail wiring for the remaining seven register
 * routes. Mirrors filter-chips-rail.test.ts which covered concerns +
 * recommendations.
 *
 * Each suite pins: the route imports FilterChipsRail, mounts it with
 * `{chips} {activeValue}`, and declares the canonical filter values
 * it supports. A refactor that drops a value will fail loudly here.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTES_DIR = resolve(__dirname, '../../src/routes');

/** @param {string} route */
function pageSrc(route: string): string {
  return readFileSync(resolve(ROUTES_DIR, route, '+page.svelte'), 'utf8');
}

describe('T19.1 — /training wires the FilterChipsRail', () => {
  const src = pageSrc('training');
  it('imports + mounts FilterChipsRail', () => {
    expect(src).toMatch(
      /import\s+FilterChipsRail\s+from\s+['"]\$lib\/ui\/FilterChipsRail\.svelte['"]/
    );
    expect(src).toMatch(/<FilterChipsRail\s+\{chips\}\s+\{activeValue\}/);
  });
  it('declares the three canonical validity values', () => {
    for (const v of ['valid', 'expiring', 'expired']) {
      expect(src).toContain(`'${v}'`);
    }
  });
});

describe('T19.1 — /work-refusal wires the FilterChipsRail (with `active` macro preserved)', () => {
  const src = pageSrc('work-refusal');
  it('imports + mounts FilterChipsRail', () => {
    expect(src).toMatch(
      /import\s+FilterChipsRail\s+from\s+['"]\$lib\/ui\/FilterChipsRail\.svelte['"]/
    );
    expect(src).toMatch(/<FilterChipsRail\s+\{chips\}\s+\{activeValue\}/);
  });
  it('declares the four canonical stage values', () => {
    for (const v of ['worker_refusal', 's43_4_investigation', 's43_8_mol', 'resolved']) {
      expect(src).toContain(`'${v}'`);
    }
  });
  it('still recognizes the legacy `active` macro for the home dashboard tile', () => {
    expect(src).toContain("filterParam === 'active'");
    expect(src).toContain('work_refusal_active');
  });
});

describe('T19.1 — /s51-evidence wires the FilterChipsRail', () => {
  const src = pageSrc('s51-evidence');
  it('imports + mounts FilterChipsRail', () => {
    expect(src).toMatch(
      /import\s+FilterChipsRail\s+from\s+['"]\$lib\/ui\/FilterChipsRail\.svelte['"]/
    );
    expect(src).toMatch(/<FilterChipsRail\s+\{chips\}\s+\{activeValue\}/);
  });
  it('declares the three canonical scene_state values', () => {
    for (const v of ['preserving', 'released_by_inspector', 'window_expired']) {
      expect(src).toContain(`'${v}'`);
    }
  });
});

describe('T19.1 — /reprisal wires the FilterChipsRail (with `active` macro preserved)', () => {
  const src = pageSrc('reprisal');
  it('imports + mounts FilterChipsRail', () => {
    expect(src).toMatch(
      /import\s+FilterChipsRail\s+from\s+['"]\$lib\/ui\/FilterChipsRail\.svelte['"]/
    );
    expect(src).toMatch(/<FilterChipsRail\s+\{chips\}\s+\{activeValue\}/);
  });
  it('declares the four canonical status values', () => {
    for (const v of ['filed', 'investigating', 'resolved', 'archived']) {
      expect(src).toContain(`'${v}'`);
    }
  });
  it('still recognizes the legacy `active` macro', () => {
    expect(src).toContain("filterParam === 'active'");
    expect(src).toContain('reprisal_active');
  });
});

describe('T19.1 — /minutes wires the FilterChipsRail', () => {
  const src = pageSrc('minutes');
  it('imports + mounts FilterChipsRail', () => {
    expect(src).toMatch(
      /import\s+FilterChipsRail\s+from\s+['"]\$lib\/ui\/FilterChipsRail\.svelte['"]/
    );
    expect(src).toMatch(/<FilterChipsRail\s+\{chips\}\s+\{activeValue\}/);
  });
  it('declares the three canonical status values', () => {
    for (const v of ['draft', 'approved', 'archived']) {
      expect(src).toContain(`'${v}'`);
    }
  });
});

describe('T19.1 — /inspections wires the FilterChipsRail', () => {
  const src = pageSrc('inspections');
  it('imports + mounts FilterChipsRail', () => {
    expect(src).toMatch(
      /import\s+FilterChipsRail\s+from\s+['"]\$lib\/ui\/FilterChipsRail\.svelte['"]/
    );
    expect(src).toMatch(/<FilterChipsRail\s+\{chips\}\s+\{activeValue\}/);
  });
  it('declares the two canonical integrity-status values', () => {
    for (const v of ['verified', 'quarantined']) {
      expect(src).toContain(`'${v}'`);
    }
  });
});

describe('T19.1 — /library wires the FilterChipsRail (with `offline` macro preserved)', () => {
  const src = pageSrc('library');
  it('imports + mounts FilterChipsRail', () => {
    expect(src).toMatch(
      /import\s+FilterChipsRail\s+from\s+['"]\$lib\/ui\/FilterChipsRail\.svelte['"]/
    );
    expect(src).toMatch(/<FilterChipsRail\s+\{chips\}\s+\{activeValue\}/);
  });
  it('declares the five canonical category values', () => {
    for (const v of ['policy', 'procedure', 'training', 'legislation', 'template']) {
      expect(src).toContain(`'${v}'`);
    }
  });
  it('still recognizes the `offline` macro orthogonal to category', () => {
    expect(src).toContain("filterParam === 'offline'");
    expect(src).toContain('library_offline');
  });
});

describe('T19.1 — s51.viewer.chip.* short labels are in the catalog', () => {
  const catalog = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
  );
  it('preserving / released / expired labels exist', () => {
    expect(typeof catalog.s51.viewer.chip.preserving).toBe('string');
    expect(typeof catalog.s51.viewer.chip.released).toBe('string');
    expect(typeof catalog.s51.viewer.chip.expired).toBe('string');
  });
});
