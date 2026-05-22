// SvelteKit configuration.
//
// Adapter choice — ADR-0006 follow-up: adapter-static is the default since
// auth is Supabase-side and most routes are client-rendered after login.
// If auth callback SSR becomes necessary, switch to adapter-node deliberately.
//
// Pinned per scaffolder hard rules (reproducible builds).
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html',
      precompress: false,
      strict: true
    }),
    // CSP locked down — no inline script, no third-party JS at runtime.
    // (ADR-0010 / JHSC-APP-PLAN.md §7).
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        'script-src': ['self'],
        'style-src': ['self', 'unsafe-inline'],
        'img-src': ['self', 'data:', 'blob:'],
        'font-src': ['self'],
        'connect-src': ['self'],
        'frame-ancestors': ['none'],
        'base-uri': ['self'],
        'form-action': ['self']
      }
    },
    alias: {
      $lib: 'src/lib',
      '$lib/*': 'src/lib/*'
    }
  }
};

export default config;
