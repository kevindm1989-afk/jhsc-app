import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Bench harness — measures hot-path code only. Separate config so:
//   (1) `vitest run` does NOT pick up `.bench.ts` (test/include in
//       vitest.config.ts is `test/**/*.test.ts`).
//   (2) bench skips the svelte plugin (none of the hot-path code under
//       measurement loads svelte components).
//
// Source: 2026-06-17 perf-watcher pass finding F1.
// Run: `pnpm -C apps/web bench` from repo root.
export default defineConfig({
  resolve: {
    alias: [{ find: '$lib', replacement: path.resolve(__dirname, 'src/lib') }],
    conditions: ['node'],
    extensions: ['.mjs', '.js', '.mts', '.ts', '.json']
  },
  test: {
    environment: 'node',
    include: [],
    benchmark: {
      include: ['bench/**/*.bench.ts']
    }
  }
});
