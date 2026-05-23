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
      hot: false,
      compilerOptions: {
        dev: true
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
    // Determinism per test-plan.md §3.J
    sequence: {
      shuffle: false,
      concurrent: false
    },
    setupFiles: ['./test/setup.ts'],
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true
      }
    }
  }
});
