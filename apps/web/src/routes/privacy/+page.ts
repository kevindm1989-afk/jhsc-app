// SvelteKit data load — same posture as the rest of the app: prerender
// the shell, client-side render at boot. The privacy page reads no
// dynamic state; the catalog text is interpolated at compile time.
export const prerender = true;
export const ssr = false;
