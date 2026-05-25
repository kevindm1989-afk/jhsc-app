/**
 * T19 — A-T19-RR-4 — bundle-strip gate must catch the __test_ family (LOW).
 *
 * The script scripts/check-onboarding-test-props-stripped.sh enumerates a
 * fixed list of banned literals but currently MISSES the broad `__test_*`
 * family added across the panic-wipe work (`__test_force_wipe_in_progress`,
 * `__test_store`, `__test_ready_delay_ms`, `__test_force_clear_failure`,
 * `__test_auto_submit`, `__test_session_count`, `__test_revoke_*`, etc.).
 *
 * Contract pinned (red until the implementer widens the gate):
 *   - The gate FAILS (exit != 0) when a bundle .js file contains the literal
 *     `__test_force_wipe_in_progress`.
 *   - The gate PASSES (exit 0) on a clean bundle fixture (no banned literals).
 *
 * This shells out to the real script against tmp fixture bundle dirs so the
 * test exercises the production gate, not a re-implementation. Each test owns
 * its fixture dir (mkdtemp) and tears it down — no shared mutable state.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../_helpers/paths';

// Everything is passed to bash RELATIVE to cwd=REPO_ROOT — both the script and
// the fixture bundle dir. This sidesteps Git Bash / MSYS absolute drive-letter
// path translation (which mangles `C:\...` argv and cannot stat Windows temp
// paths outside the repo), and behaves identically on POSIX.
const SCRIPT_REL = 'scripts/check-onboarding-test-props-stripped.sh';

// Dot-prefixed so it is ignored by the source-tree walkers in the other suites.
const createdDirs: string[] = [];

// Returns the bundle dir path RELATIVE to REPO_ROOT (e.g. ".rr4-bundle-AbC123").
function makeBundleDir(fileContents: Record<string, string>): string {
  const abs = mkdtempSync(path.join(REPO_ROOT, '.rr4-bundle-'));
  createdDirs.push(abs);
  mkdirSync(path.join(abs, 'chunks'), { recursive: true });
  for (const [name, contents] of Object.entries(fileContents)) {
    const full = path.join(abs, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  }
  // A single path segment — no separators to translate on either platform.
  return path.relative(REPO_ROOT, abs);
}

function runGate(bundleDirRel: string): { status: number; stderr: string; stdout: string } {
  const res = spawnSync('bash', [SCRIPT_REL, bundleDirRel], {
    encoding: 'utf8',
    cwd: REPO_ROOT
  });
  return {
    status: res.status ?? -1,
    stderr: res.stderr ?? '',
    stdout: res.stdout ?? ''
  };
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('T19 / A-T19-RR-4 — bundle-strip gate catches the __test_ family', () => {
  it('FAILS (exit != 0) when a bundle chunk contains literal `__test_force_wipe_in_progress`', () => {
    const dir = makeBundleDir({
      'chunks/PanicWipeModal.js':
        'export let open=!1;let __test_force_wipe_in_progress=void 0;'
    });
    const { status, stderr } = runGate(dir);
    expect(
      status,
      `gate must reject a bundle leaking __test_force_wipe_in_progress (stderr: ${stderr})`
    ).not.toBe(0);
  });

  it('PASSES (exit 0) on a clean bundle fixture with no banned literals', () => {
    const dir = makeBundleDir({
      'chunks/PanicWipeModal.js': 'export let open=!1;let ready=!0;function onConfirm(){}'
    });
    const { status, stderr } = runGate(dir);
    expect(
      status,
      `gate must pass on a clean bundle (stderr: ${stderr})`
    ).toBe(0);
  });

  it('FAILS (exit != 0) when a chunk leaks the injected `__test_store` prop literal', () => {
    const dir = makeBundleDir({
      'chunks/PanicWipeModal.js': 'export let __test_store=void 0;'
    });
    const { status, stderr } = runGate(dir);
    expect(
      status,
      `gate must reject a bundle leaking __test_store (stderr: ${stderr})`
    ).not.toBe(0);
  });
});
