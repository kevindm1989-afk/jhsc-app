/**
 * Svelte readable-store wrappers over the session-jwt-store.
 *
 * Production callers (`+layout.svelte`, future components that want to
 * react to JWT presence) can subscribe via Svelte's `$` prefix without
 * hand-rolling the `subscribeToJwt` + `getJwt` + `onDestroy` boilerplate
 * that PRs #58 / #59 / #60 inlined across three route mounts.
 *
 *   <script>
 *     import { jwt, isSignedIn } from '$lib/auth/session-jwt-svelte';
 *   </script>
 *
 *   {#if $isSignedIn} … {/if}
 *
 * Both stores are Svelte `readable` instances. Their start function
 * runs when the subscriber count goes from 0 → 1 and returns the
 * unsubscribe handle Svelte calls when the count drops to 0 — so
 * components don't need `onDestroy` cleanup.
 *
 * The stores are CREATED LAZILY (via getters) so that under SSR — which
 * we don't yet support but might in a future route — the modules
 * importing this file don't trigger a side-effectful subscription at
 * import time. Today every route declares ssr=false so the laziness is
 * defensive, not required.
 *
 * Cross-tab sync (PR #61): the underlying `subscribeToJwt` fires for
 * BOTH local `setJwt`/`clearJwt` AND inbound BroadcastChannel messages
 * from sibling tabs. Components reading `$jwt` / `$isSignedIn` see
 * cross-tab updates with no additional plumbing.
 */

import { readable, type Readable } from 'svelte/store';
import { getJwt, subscribeToJwt } from './session-jwt-store';

/**
 * Reactive Svelte store of the current JWT (`string | null`).
 *
 * Initial value comes from `getJwt()` at subscribe time, so a component
 * mounting after sign-in sees the existing JWT immediately (no `null`
 * flash before the first store update).
 */
export const jwt: Readable<string | null> = readable<string | null>(getJwt(), (set) => {
  // Re-read at subscribe time too — in case the value changed between
  // module load and the first subscriber attaching.
  set(getJwt());
  return subscribeToJwt((value) => set(value));
});

/**
 * Reactive Svelte boolean store: `true` iff the current JWT is non-null.
 *
 * The convenience derived form so components can write
 * `{#if $isSignedIn}` without `$jwt !== null`. Initialised eagerly from
 * `getJwt()` so a returning user sees the signed-in state without a
 * flash of the signed-out layout.
 */
export const isSignedIn: Readable<boolean> = readable<boolean>(getJwt() !== null, (set) => {
  set(getJwt() !== null);
  return subscribeToJwt((value) => set(value !== null));
});
