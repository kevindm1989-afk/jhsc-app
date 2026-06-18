import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';

/**
 * Vitest configuration.
 *
 * Test environment: jsdom (browser-shaped DOM for the client modules).
 * No real clock; frozen via test/_helpers/clock.ts.
 * No real network; the test sinks in src/lib/log/test-sink.ts replace the
 * transport.
 *
 * Tests do NOT run SvelteKit's full server pipeline — only the components
 * under apps/web/src are loaded. Edge-function tests are Deno-side and
 * are not part of this runner.
 */
export default defineConfig({
  plugins: [
    svelte({
      // `hot` was removed from vite-plugin-svelte 7's options surface
      // (HMR is now controlled by the vite mode, not a plugin flag).
      compilerOptions: {
        dev: true
      },
      // PanicWipeModal exposes the legacy `component.$on('close', ...)` API
      // (A-T19-RR-2 contract). Svelte 5 only honours `$on` when the component
      // is compiled with `compatibility.componentApi: 4`; scope it to that one
      // file so other components keep the Svelte 5 instance API.
      dynamicCompileOptions({ filename }) {
        if (filename.endsWith('PanicWipeModal.svelte')) {
          return { compatibility: { componentApi: 4 } };
        }
        return undefined;
      }
    })
  ],
  resolve: {
    alias: [
      { find: '$lib', replacement: path.resolve(__dirname, 'src/lib') },
      { find: '$app', replacement: path.resolve(__dirname, 'src/.svelte-kit-stub/app') },
      // Edge-function shared module — the T02 structured-logger test
      // dynamic-imports `../../../supabase/functions/_shared/log` to verify
      // single-source-of-truth on the safeFields allowlist. Vite's
      // import-analysis plugin doesn't resolve extensionless cross-package
      // imports automatically; this regex maps the bare path to the .ts file.
      {
        find: /^\.\.\/\.\.\/\.\.\/supabase\/functions\/_shared\/log$/,
        replacement: path.resolve(
          __dirname,
          '..',
          '..',
          'supabase',
          'functions',
          '_shared',
          'log.ts'
        )
      }
    ],
    conditions: ['browser'],
    extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json', '.svelte']
  },
  // Allow imports outside the apps/web project root (supabase/functions
  // shares modules with the web test surface). Without this Vite's
  // serve.fs guard blocks the cross-package import.
  server: {
    fs: {
      allow: [path.resolve(__dirname, '..', '..')]
    }
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['test/**/*.test.ts'],
    // Edge-function Deno tests live outside this runner.
    exclude: ['**/node_modules/**', '**/.svelte-kit/**', '../../supabase/functions/**'],
    // Vitest 2.x default was 5000ms; carry the same budget but raise the
    // floor for CI variance (T07 multi-await tests routinely pass in <1s
    // locally but brush against 5s under runner load).
    testTimeout: 10000,
    // Determinism per test-plan.md §3.J
    sequence: {
      shuffle: false,
      concurrent: false
    },
    setupFiles: ['./test/setup.ts'],
    // Vitest 4 migration:
    //   - `poolOptions.threads.singleThread: true` was replaced by the
    //     top-level `fileParallelism: false` (per the v4 migration notes).
    //     Combined with `sequence.concurrent: false` above, this preserves
    //     the test-plan.md §3.J determinism contract.
    //   - `isolate: true` (the v4 default) gives each test file a fresh
    //     module/DOM context. The cost is ~12x wall-clock locally vs the
    //     v3 `isolate: false` equivalent, but CI's timeout budget
    //     (20–25 min) easily absorbs it (~200s), and isolate=true
    //     contains the PanicWipeModal `componentApi: 4` cleanup races
    //     that surfaced under v3+isolate-false.
    pool: 'threads',
    fileParallelism: false,
    isolate: true
  }
});
