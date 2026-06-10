// SvelteKit data load — same posture as the rest of the register
// surfaces. Prerender the shell, client-side render at boot, no
// PI on the route surface.
export const prerender = true;
export const ssr = false;
