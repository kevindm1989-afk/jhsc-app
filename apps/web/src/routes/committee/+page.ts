// SvelteKit data load — parity with the other route shells (prerender the
// shell, client-side render at boot). No PI on the route surface: ssr=false
// keeps the roster read off the server, prerender emits only the empty shell.
export const prerender = true;
export const ssr = false;
