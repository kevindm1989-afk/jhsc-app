/**
 * T19.1 — `.nvmrc` ↔ CI workflow Node-version pin.
 *
 * The `.nvmrc` file is the single source of truth for the Node version
 * across local dev (nvm-aware shells), CI (`actions/setup-node` via
 * `node-version-file: '.nvmrc'`), and the README's prerequisites
 * table. A drift in any one of those three sites without updating
 * the others would produce builds that pass in one environment and
 * fail in another.
 *
 * Specifically:
 *
 *   - `.nvmrc` carries the canonical Node version string.
 *   - `.github/workflows/ci.yml`'s two `actions/setup-node@v4` steps
 *     reference `node-version-file: '.nvmrc'` — pinning that
 *     reference defends against a refactor that hardcodes a specific
 *     version (which would silently drift from `.nvmrc`).
 *
 * The README cross-reference is pinned by `readme-pins.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const NVMRC_PATH = resolve(__dirname, '../../../../.nvmrc');
const CI_PATH = resolve(__dirname, '../../../../.github/workflows/ci.yml');

describe('T19.1 — .nvmrc + CI Node-version single-source-of-truth', () => {
  it('.nvmrc exists at the repo root', () => {
    expect(existsSync(NVMRC_PATH)).toBe(true);
  });

  it('.nvmrc contains a SemVer-shaped Node version (e.g., 22.22.2)', () => {
    const raw = readFileSync(NVMRC_PATH, 'utf8').trim();
    // Defense pin: a SemVer shape (`major.minor.patch`) means the
    // version is pinned to a specific patch — not a moving floor
    // like `22` or `lts/*` which would let CI silently pick up
    // breaking patches between PRs.
    expect(raw).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('.nvmrc declares Node 22+ (the project minimum per apps/web/README.md)', () => {
    const raw = readFileSync(NVMRC_PATH, 'utf8').trim();
    const major = parseInt(raw.split('.')[0] ?? '0', 10);
    expect(major).toBeGreaterThanOrEqual(22);
  });

  it('.github/workflows/ci.yml setup-node steps reference node-version-file: \'.nvmrc\'', () => {
    // Defense pin: hardcoding the Node version in the workflow file
    // would silently drift from .nvmrc. Every setup-node step must
    // delegate to .nvmrc.
    const src = readFileSync(CI_PATH, 'utf8');
    const setupNodeBlocks = src.match(/uses:\s+actions\/setup-node@v4[\s\S]{0,300}?(?=\n\s{6}- name:|$)/g) ?? [];
    expect(setupNodeBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of setupNodeBlocks) {
      expect(block).toMatch(/node-version-file:\s*['"]\.nvmrc['"]/);
    }
  });

  it('.github/workflows/ci.yml does NOT hardcode a Node version (regression guard)', () => {
    // A drift to `node-version: '22.x'` or similar would bypass the
    // .nvmrc single-source-of-truth.
    const src = readFileSync(CI_PATH, 'utf8');
    expect(src).not.toMatch(/node-version:\s*['"]\d+\.x['"]/);
    expect(src).not.toMatch(/node-version:\s*['"]\d+\.\d+\.\d+['"]/);
  });
});
