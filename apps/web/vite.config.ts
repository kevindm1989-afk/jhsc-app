import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  // Test config is in vitest.config.ts so the test runner can be invoked
  // without SvelteKit's plugin pulling in its full server pipeline.
  server: {
    port: 3000,
    strictPort: true
  },
  build: {
    target: 'es2022',
    sourcemap: true
  }
});
