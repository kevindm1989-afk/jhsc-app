// SvelteKit data load — match the rest of the app's posture: prerender
// the shell, client-side render at boot. The sign-in ceremony reads
// no PI at mount; the WebAuthn assertion happens after user-initiated
// click, never on page load.
export const prerender = true;
export const ssr = false;
