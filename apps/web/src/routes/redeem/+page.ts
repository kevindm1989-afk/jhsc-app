// SvelteKit data load — match the rest of the app's posture: prerender the
// shell, client-side render at boot. The redeem ceremony reads no PI at mount;
// the member-entered code + the WebAuthn registration happen after a
// user-initiated submit, never on page load. ssr=false so window/location are
// always defined when the ceremony runs (rpId/origin derivation).
export const prerender = true;
export const ssr = false;
