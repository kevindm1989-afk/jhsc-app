/**
 * T19.1 — root .gitignore secret-prevention patterns pin.
 *
 * The .gitignore at the repo root is the first line of defense
 * against committing `.env` files. The repo also runs `gitleaks` as
 * a hardening gate (catches secrets that DID slip in), but
 * .gitignore prevents them ever entering the index.
 *
 * Pinning the existing patterns:
 *
 *   - `.env`, `.env.local`, `.env.*.local` — SvelteKit's conventional
 *     env files that are local-only by design. PUBLIC_SUPABASE_URL,
 *     PUBLIC_SENTRY_DSN, and any future env-driven secret would
 *     land here.
 *   - `node_modules/` — would bloat the repo + slow every git op.
 *   - `build/` — generated; never source-of-truth.
 *   - `.svelte-kit/` — SvelteKit generated cache + types.
 *
 * Pinning these doesn't expand the coverage (gaps like `.env.staging`
 * without the `.local` suffix remain a separate discussion); it
 * just defends what's currently there from silent removal.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const GITIGNORE_PATH = resolve(__dirname, '../../../../.gitignore');

describe('T19.1 — root .gitignore secret + cache patterns', () => {
  it('the root .gitignore exists', () => {
    expect(existsSync(GITIGNORE_PATH)).toBe(true);
  });

  const src = readFileSync(GITIGNORE_PATH, 'utf8');

  // Convert to a Set of non-empty, non-comment lines for membership
  // checks. Each pattern is on its own line per .gitignore syntax.
  const patterns = new Set(
    src
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  );

  describe('env / secret patterns', () => {
    it('ignores `.env` (the base SvelteKit env file)', () => {
      expect(patterns.has('.env')).toBe(true);
    });

    it('ignores `.env.local` (SvelteKit local override convention)', () => {
      expect(patterns.has('.env.local')).toBe(true);
    });

    it('ignores `.env.*.local` (mode-specific local overrides)', () => {
      expect(patterns.has('.env.*.local')).toBe(true);
    });
  });

  describe('cache / build patterns', () => {
    it('ignores `node_modules/`', () => {
      expect(patterns.has('node_modules/')).toBe(true);
    });

    it('ignores `build/` (adapter-static output)', () => {
      expect(patterns.has('build/')).toBe(true);
    });

    it('ignores `.svelte-kit/` (SvelteKit generated cache + types)', () => {
      expect(patterns.has('.svelte-kit/')).toBe(true);
    });

    it('ignores `.vite/` (Vite cache)', () => {
      expect(patterns.has('.vite/')).toBe(true);
    });

    it('ignores `coverage/` (test coverage output)', () => {
      expect(patterns.has('coverage/')).toBe(true);
    });
  });

  describe('logs / debug patterns', () => {
    it('ignores `*.log` (catch-all for stray log files)', () => {
      expect(patterns.has('*.log')).toBe(true);
    });

    it('ignores `pnpm-debug.log*`', () => {
      expect(patterns.has('pnpm-debug.log*')).toBe(true);
    });
  });

  describe('regression guards against unsafe loosening', () => {
    it('does NOT carry a `!.env` un-ignore line (would force-commit the secret file)', () => {
      // Defense pin: a refactor that adds `!.env` to "share dev env"
      // would defeat the secret-prevention. If a shareable env file
      // is needed, the convention is `.env.example` (not in
      // .gitignore by default).
      expect(patterns.has('!.env')).toBe(false);
      expect(patterns.has('!.env.local')).toBe(false);
    });

    it('does NOT carry a global `*` ignore (would ignore everything; broken repo)', () => {
      expect(patterns.has('*')).toBe(false);
    });
  });
});
