// SvelteKit data load — match the root layout posture: prerender the
// shell, client-side render at boot. The wizard itself is in-memory and
// loads no PI at mount; the load function is intentionally empty.
export const prerender = true;
export const ssr = false;
