/**
 * F182-6 / ADR-0030 Amendment C, Decision C4 — `removeRotationOrchestration`,
 * the roster-level call seam that the `rotateOnRemoval` structural method on the
 * card's injected `ManageClient` is wired to.
 *
 * The presentational `CommitteeManageMemberCard.svelte` MUST NOT receive raw
 * crypto deps (`holder` / `localIdentity` / t07 client / `actor_public_key`) —
 * that would leak the ADR-0003 Invariant-1 crypto boundary into a Svelte
 * component (re-pass #28). Instead the roster closes over those deps here,
 * derives `actor_public_key` in the crypto layer (via `deriveActorPublicKey`,
 * which zeroizes the private buffer), and calls the already-built hermetic
 * composition. The card only ever sees the opaque `rotation_id` / `new_key_id`
 * handles + the status union it returns.
 *
 * `remaining_members` is supplied BY THE CALLER (the card forwards its
 * roster-derived `remainingMembers` prop on a fresh run, or the `pending_members`
 * subset on a resume) — this seam passes it straight through, so a resume
 * re-wraps only the still-missing set (never the full roster).
 */
import {
  deriveActorPublicKey,
  rotateCommitteeKeyOnRemovalViaProduction,
  type SupabaseT07Client,
  type CommitteeKeyHolder,
  type LocalIdentityStore,
  type RotateCommitteeKeyOnRemovalResult
} from '$lib/crypto';

export interface RemoveRotationDeps {
  /** Production t07 client (the single `getMemberPubkey` disclosure owner). */
  client: SupabaseT07Client;
  /** The actor's session committee-key holder. */
  holder: CommitteeKeyHolder;
  /** The device-local identity store (source of the actor's private key). */
  localIdentity: LocalIdentityStore;
  /** The acting co-chair's own user id (JWT-bound). */
  user_id: string;
}

export interface RotateOnRemovalInput {
  removed_member_id: string;
  remaining_members: ReadonlyArray<{ user_id: string }>;
  resume?: { rotation_id: string; new_key_id: string };
}

/**
 * Build the `rotateOnRemoval` method the roster threads onto the manage card's
 * client — ONLY when the three crypto deps are present (so a governance-only
 * mount threads no rotation capability, and the card's Remove CTA gate stays
 * honest, VC-1).
 */
export function makeRemoveRotationOrchestration(
  deps: RemoveRotationDeps
): (input: RotateOnRemovalInput) => Promise<RotateCommitteeKeyOnRemovalResult> {
  return async function rotateOnRemoval(
    input: RotateOnRemovalInput
  ): Promise<RotateCommitteeKeyOnRemovalResult> {
    // Derive the actor's X25519 public half from the device-local private key.
    // The touch happens ONLY here in the crypto/orchestration layer; the buffer
    // is zeroized inside the helper (AC-C13).
    const priv = await deps.localIdentity.getIdentityPrivateKey(deps.user_id);
    const actor_public_key = await deriveActorPublicKey(priv);
    return rotateCommitteeKeyOnRemovalViaProduction({
      client: deps.client,
      holder: deps.holder,
      localIdentity: deps.localIdentity,
      user_id: deps.user_id,
      actor_public_key,
      removed_member_id: input.removed_member_id,
      remaining_members: input.remaining_members,
      // `exactOptionalPropertyTypes`: only include `resume` when it is actually a
      // resume run (a fresh run must omit the key, not pass `undefined`).
      ...(input.resume ? { resume: input.resume } : {})
    });
  };
}
