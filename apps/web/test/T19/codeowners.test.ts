/**
 * T19.1 — .github/CODEOWNERS pin (G-T19-16 scaffold close).
 *
 * GitHub branch-protection rules can require review from "code
 * owners" but only if a `.github/CODEOWNERS` file declares ownership.
 * Without it, the "Require review from Code Owners" branch-protection
 * setting is inert (no owners are matched, so the requirement is
 * automatically satisfied).
 *
 * This file pins:
 *
 *   - The CODEOWNERS file exists at the canonical path.
 *   - It declares a global default reviewer (`* @<handle>`) so every
 *     PR routes review to at least one owner.
 *   - It uses the repo maintainer's handle (kevindm1989-afk).
 *
 * Path-specific routing for security-critical surfaces is sketched
 * in known-gaps.md G-T19-16 but intentionally not pinned here —
 * those assignments need dedicated security-reviewer / architect
 * GitHub handles that a follow-up can layer in.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PATH = resolve(__dirname, '../../../../.github/CODEOWNERS');

describe('T19.1 / G-T19-16 — .github/CODEOWNERS', () => {
  it('file exists at .github/CODEOWNERS', () => {
    expect(existsSync(PATH)).toBe(true);
  });

  const src = readFileSync(PATH, 'utf8');

  it('declares a global default reviewer (line starting with `* @`)', () => {
    expect(src).toMatch(/^\*\s+@[\w-]+\s*$/m);
  });

  it('the global default uses the repo maintainer handle (@kevindm1989-afk)', () => {
    // Defense pin: drift to a placeholder handle (`@TODO`) or an
    // organization team (`@org/team`) without verifying the team
    // exists would silently make CODEOWNERS inert.
    expect(src).toMatch(/^\*\s+@kevindm1989-afk\s*$/m);
  });

  it('does NOT declare a placeholder handle like @TODO or @YOUR_HANDLE', () => {
    expect(src).not.toMatch(/@TODO\b/i);
    expect(src).not.toMatch(/@YOUR_HANDLE\b/i);
    expect(src).not.toMatch(/@PLACEHOLDER\b/i);
  });
});
