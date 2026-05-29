// SvelteKit data load — match the rest of the app's posture: prerender
// the shell, client-side render at boot. Settings state is in-memory and
// loads no PI at mount.
export const prerender = true;
export const ssr = false;
