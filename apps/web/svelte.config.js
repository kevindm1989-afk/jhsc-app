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
    //
    // `connect-src` includes `https://*.supabase.co` so the browser-side
    // Edge Function clients (mint-session, t07-op, t14-op, concern-op,
    // reprisal-op, committee-op) can post to
    // `${PUBLIC_SUPABASE_URL}/functions/v1/<op>` — typically
    // `https://<project>.supabase.co`. Without this, the prerendered
    // <meta http-equiv="content-security-policy"> would block every
    // Edge Function call (the cross-origin fetch would violate
    // `connect-src 'self'`). The wildcard scope is the standard
    // Supabase deploy posture; tightening to the exact project URL
    // requires either env-driven CSP synthesis at build time (deferred —
    // adds build-config plumbing without changing the security bound
    // meaningfully) OR a custom Supabase domain (deploy-config, not
    // changeable from this file).
    //
    // The bundle-isolation defense for `@supabase/supabase-js` is
    // intact: the SDK is server-only (per decisions.md §4) and the
    // bundle gate (`scripts/verify-no-third-party-js.sh`) keeps it
    // out of `build/`. `connect-src` controls runtime fetches, NOT
    // bundle inclusion.
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        'script-src': ['self'],
        'style-src': ['self', 'unsafe-inline'],
        'img-src': ['self', 'data:', 'blob:'],
        'font-src': ['self'],
        'connect-src': ['self', 'https://*.supabase.co'],
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
