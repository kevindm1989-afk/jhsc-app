// SvelteKit data load — match the rest of the app's posture: prerender
// the shell, client-side render at boot. The landing page reads no PI
// at mount; the JWT-reactive copy swap (`$isSignedIn`) is a client-side
// store subscription that fires after hydration.
//
// These declarations are redundant with `+layout.ts` (which sets the
// same posture for every route), but pinning them per-route is the
// established defense-in-depth pattern across /onboarding, /sign-in,
// and /settings — a future change to the layout's posture won't
// silently re-enable SSR on the landing page without breaking the
// landing-route-mount structural test that pins this contract.
export const prerender = true;
export const ssr = false;
