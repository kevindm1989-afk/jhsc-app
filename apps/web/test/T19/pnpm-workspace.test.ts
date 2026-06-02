/**
 * T19.1 — `pnpm-workspace.yaml` workspace declaration pin.
 *
 * The root `pnpm-workspace.yaml` declares which directories are
 * packages in the pnpm monorepo. Every `pnpm install` resolves
 * dependencies against this list; a drift here would break the
 * apps/web workspace's link to the root, and `pnpm -C apps/web`
 * commands would fail with "package not found".
 *
 * The current contract is minimal: `apps/*` is the only package
 * glob (covers apps/web today and any future apps/ sibling).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKSPACE = resolve(__dirname, '../../../../pnpm-workspace.yaml');

describe('T19.1 — pnpm-workspace.yaml', () => {
  it('exists at the repo root', () => {
    expect(existsSync(WORKSPACE)).toBe(true);
  });

  const src = readFileSync(WORKSPACE, 'utf8');

  it('declares the `apps/*` package glob (covers apps/web + future apps/ siblings)', () => {
    // Defense pin: drift to a hardcoded `apps/web` would break when
    // a future apps/ sibling lands (e.g., apps/admin). Drift to `*`
    // would pull in non-package directories (.context/, scripts/,
    // supabase/) which lack package.json and break install.
    expect(src).toMatch(/^\s*-\s*['"]?apps\/\*['"]?\s*$/m);
  });

  it('declares the `packages:` key (yaml structure pin)', () => {
    expect(src).toMatch(/^packages:\s*$/m);
  });
});
