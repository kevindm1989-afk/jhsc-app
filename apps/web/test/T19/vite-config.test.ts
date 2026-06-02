/**
 * T19.1 — vite.config.ts structural pin.
 *
 * The Vite config establishes the production build target + the dev
 * server contract. None of its load-bearing values were pinned:
 *
 *   - `sveltekit()` plugin presence is the single load-bearing wiring
 *     that makes this a SvelteKit app rather than a generic Vite project.
 *   - `build.target: 'es2022'` is the JS-syntax floor. Drift to a
 *     newer target (e.g., 'esnext') would ship features unsupported
 *     by some older personal-device browsers the threat model targets.
 *     Drift to an older target (es2017) would bloat the bundle with
 *     polyfills for features we have shipped (async/await, optional
 *     chaining, etc.).
 *   - `build.sourcemap: true` keeps stack traces decipherable in the
 *     Sentry-scrub path. The scrub module's filename rewrite assumes
 *     sourcemaps exist; turning sourcemap=false would silently render
 *     the captured stack traces useless for debugging.
 *   - `server.port: 3000` + `strictPort: true` lock the dev server
 *     port so a parallel-launched dev instance fails loudly (port
 *     conflict) instead of silently picking the next free port.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG_PATH = resolve(__dirname, '../../vite.config.ts');

describe('T19.1 — vite.config.ts (plugin + build + dev-server)', () => {
  it('vite.config.ts exists', () => {
    expect(existsSync(CONFIG_PATH)).toBe(true);
  });

  it('imports + invokes the sveltekit() plugin (single load-bearing wiring)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/import\s*{\s*sveltekit\s*}\s*from\s*['"]@sveltejs\/kit\/vite['"]/);
    expect(src).toMatch(/plugins:\s*\[\s*sveltekit\(\s*\)/);
  });

  it('sets build.target to es2022 (modern personal-device baseline)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/\btarget:\s*['"]es2022['"]/);
  });

  it('does NOT use \'esnext\' build target (would ship unsupported syntax to older personal-device browsers)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).not.toMatch(/\btarget:\s*['"]esnext['"]/);
  });

  it('enables build.sourcemap (load-bearing for Sentry scrub stack-trace decipher)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/\bsourcemap:\s*true/);
  });

  it('sets server.port to 3000 + strictPort to true (dev-server contract)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/\bport:\s*3000/);
    expect(src).toMatch(/\bstrictPort:\s*true/);
  });
});
